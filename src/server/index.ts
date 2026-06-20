import "dotenv/config";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import path from "node:path";
import { v4 as uuid } from "uuid";
import { ZodError } from "zod";
import type { AttachmentRef, IntakeJob, InvoiceDraft, JobEvent } from "../shared/invoice";
import { invoiceDraftSchema, jobStatuses } from "../shared/invoice";
import { decodeZatcaTlv } from "../shared/zatca";
import { buildExtractionJobInput, extractInvoiceDraft, startExternalExtraction } from "./extraction";
import { reconcileDraft } from "./reconciliation";
import { jobStore, UPLOAD_DIR } from "./store";
import { createInvoiceQueueItem, maybeStartInvoiceCase, uploadAttachmentToBucket } from "./uipathCli";

const PORT = Number(process.env.PORT ?? 8787);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_request, _file, callback) => callback(null, UPLOAD_DIR),
    filename: (_request, file, callback) => {
      const extension = path.extname(file.originalname) || ".upload";
      callback(null, `${Date.now()}-${uuid()}${extension}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: (_request, file, callback) => {
    callback(null, allowedMimeTypes.has(file.mimetype));
  }
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const fillWritableStatuses = new Set(["ready_for_qoyod", "qoyod_filling", "draft_saved", "error"]);
const deprecatedRobotStatusMap: Record<string, IntakeJob["status"]> = {
  ready_for_robot: "ready_for_qoyod",
  robot_running: "qoyod_filling"
};

function asyncHandler(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response) => {
    handler(request, response).catch((error) => {
      console.error(error);
      if (error instanceof ZodError) {
        response.status(400).json({
          error: "Invalid invoice draft payload.",
          issues: error.issues
        });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "Unexpected server error."
      });
    });
  };
}

function draftFromCapture(attachment: AttachmentRef, qrPayload?: string): InvoiceDraft {
  const qrTlv = qrPayload ? decodeZatcaTlv(qrPayload) ?? undefined : undefined;
  const grandTotal = qrTlv?.totalWithVat ?? 0;
  const vatTotal = qrTlv?.vatTotal ?? 0;
  const issueDate = qrTlv?.timestamp ? qrTlv.timestamp.slice(0, 10) : "";

  return {
    supplierName: qrTlv?.sellerName ?? "",
    supplierTaxId: qrTlv?.vatRegistrationNumber ?? "",
    invoiceNumber: "",
    issueDate,
    dueDate: "",
    currency: "SAR",
    subtotal: grandTotal && vatTotal ? Math.round((grandTotal - vatTotal) * 100) / 100 : 0,
    discount: 0,
    vatTotal,
    grandTotal,
    attachmentRefs: [attachment],
    qrTlv,
    lineItems: []
  };
}

function routeParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function verifyRobotToken(request: Request, response: Response): boolean {
  const token = process.env.ROBOT_API_TOKEN;
  if (token && request.header("x-robot-token") !== token) {
    response.status(401).json({ error: "Invalid robot token." });
    return false;
  }
  return true;
}

function verifyFillToken(request: Request, response: Response): boolean {
  const token = process.env.FILLER_API_TOKEN || process.env.ROBOT_API_TOKEN;
  if (token && request.header("x-fill-token") !== token && request.header("x-robot-token") !== token) {
    response.status(401).json({ error: "Invalid Qoyod fill token." });
    return false;
  }
  return true;
}

function verifyCaseToken(request: Request, response: Response): boolean {
  const token = process.env.CASE_CALLBACK_TOKEN;
  if (token && request.header("x-case-token") !== token) {
    response.status(401).json({ error: "Invalid case callback token." });
    return false;
  }
  return true;
}

function verifyExtractionToken(request: Request, response: Response): boolean {
  const extractionToken = process.env.EXTRACTION_CALLBACK_TOKEN;
  const caseToken = process.env.CASE_CALLBACK_TOKEN;
  const fillToken = process.env.FILLER_API_TOKEN || process.env.ROBOT_API_TOKEN;
  const provided = request.header("x-extraction-token") ?? request.header("x-case-token") ?? request.header("x-fill-token");
  const accepted = [extractionToken, caseToken, fillToken].filter((token): token is string => Boolean(token));

  if (accepted.length > 0 && (!provided || !accepted.includes(provided))) {
    response.status(401).json({ error: "Invalid extraction token." });
    return false;
  }
  return true;
}

function requestBaseUrl(request: Request): string {
  return (process.env.PUBLIC_API_BASE_URL || process.env.INVOICE_INTAKE_API_BASE_URL || `${request.protocol}://${request.get("host")}`).replace(/\/$/, "");
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function casePatchFromBody(body: unknown): Pick<IntakeJob, "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage"> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {};
  return {
    caseInstanceId: optionalString(payload.caseInstanceId),
    caseJobKey: optionalString(payload.caseJobKey),
    caseExternalId: optionalString(payload.caseExternalId),
    caseStage: optionalString(payload.caseStage)
  };
}

function caseStartPatch(data: unknown): Pick<IntakeJob, "caseInstanceId" | "caseJobKey" | "caseExternalId" | "caseStage"> {
  const payload = data && typeof data === "object" ? data as Record<string, unknown> : {};
  return {
    caseInstanceId: optionalString(payload.CaseInstanceId) ?? optionalString(payload.caseInstanceId) ?? optionalString(payload.ProcessInstanceKey),
    caseJobKey: optionalString(payload.JobKey) ?? optionalString(payload.jobKey),
    caseExternalId: optionalString(payload.ExternalId) ?? optionalString(payload.externalId),
    caseStage: "Capture Intake"
  };
}

async function dispatchToUiPath(job: IntakeJob, uploadedFile: Express.Multer.File): Promise<IntakeJob> {
  const uploadResult = await uploadAttachmentToBucket(job, uploadedFile.path, uploadedFile.mimetype);
  let workingJob = job;

  if (uploadResult.error) {
    workingJob = await jobStore.appendEvent(job.jobId, {
      level: "warning",
      message: `UiPath bucket upload skipped or failed: ${uploadResult.error}`
    });
  } else {
    const attachmentRefs = workingJob.draft.attachmentRefs.map((attachment) =>
      attachment.id === workingJob.draft.attachmentRefs[0]?.id
        ? { ...attachment, bucketPath: uploadResult.bucketPath }
        : attachment
    );
    workingJob = await jobStore.update(job.jobId, {
      draft: { ...workingJob.draft, attachmentRefs },
      events: [
        ...workingJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: uploadResult.mode === "dry-run" ? "UiPath bucket upload recorded in dry-run mode." : "Attachment uploaded to Orchestrator bucket."
        }
      ]
    });
  }

  const queueResult = await createInvoiceQueueItem(workingJob);
  if (queueResult.error) {
    workingJob = await jobStore.appendEvent(workingJob.jobId, {
      level: "warning",
      message: `UiPath queue item skipped or failed: ${queueResult.error}`
    });
  } else {
    const queueData = queueResult.data as { UniqueKey?: string; uniqueKey?: string } | undefined;
    const queueKey = queueData?.UniqueKey ?? queueData?.uniqueKey;
    workingJob = await jobStore.update(workingJob.jobId, {
      queueItemKey: queueKey,
      caseStage: "Capture Intake",
      events: [
        ...workingJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: queueResult.mode === "dry-run" ? "InvoiceIntake queue item recorded in dry-run mode." : "InvoiceIntake queue item created."
        }
      ]
    });
  }

  const caseResult = await maybeStartInvoiceCase(workingJob);
  if (caseResult?.error) {
    workingJob = await jobStore.appendEvent(workingJob.jobId, {
      level: "warning",
      message: `Maestro Case start skipped or failed: ${caseResult.error}`
    });
  } else if (caseResult) {
    workingJob = await jobStore.update(workingJob.jobId, {
      ...caseStartPatch(caseResult.data),
      events: [
        ...workingJob.events,
        {
          at: new Date().toISOString(),
          level: "info",
          message: caseResult.mode === "dry-run" ? "Maestro Case start recorded in dry-run mode." : "Maestro Case started."
        }
      ]
    });
  }

  return workingJob;
}

async function startExtraction(job: IntakeJob, apiBaseUrl: string, trigger: "capture" | "case" | "manual"): Promise<IntakeJob> {
  const mode = process.env.EXTRACTION_MODE === "external" ? "external" : "local";
  const startingJob = await jobStore.update(job.jobId, {
    status: "extracting",
    caseStage: "Extraction And Reconciliation",
    events: [
      ...job.events,
      {
        at: new Date().toISOString(),
        level: "info",
        message: mode === "external"
          ? `External extraction requested by ${trigger}.`
          : `Local LLM extraction started by ${trigger}.`
      }
    ]
  });

  const input = buildExtractionJobInput(startingJob, apiBaseUrl);
  if (mode === "external") {
    try {
      await startExternalExtraction(startingJob, input);
      return jobStore.appendEvent(startingJob.jobId, {
        level: "info",
        message: "External extraction service accepted the job."
      });
    } catch (error) {
      return jobStore.setStatus(
        startingJob.jobId,
        "error",
        error instanceof Error ? error.message : String(error),
        "error"
      );
    }
  }

  void runLocalExtraction(startingJob);
  return startingJob;
}

async function runLocalExtraction(job: IntakeJob): Promise<void> {
  try {
    const result = await extractInvoiceDraft(job);
    const current = await jobStore.get(job.jobId);
    if (!current) return;

    const validation = reconcileDraft(result.draft);
    await jobStore.update(job.jobId, {
      status: "needs_review",
      draft: result.draft,
      validation,
      extraction: result.extraction,
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: result.extraction.provider === "manual" ? "warning" : "info",
          message: result.extraction.provider === "manual"
            ? result.extraction.warnings[0] ?? "Extraction requires manual review."
            : `LLM extraction completed with ${result.extraction.provider}.`
        }
      ]
    });
  } catch (error) {
    const current = await jobStore.get(job.jobId);
    if (!current) return;

    await jobStore.update(job.jobId, {
      status: "error",
      extraction: {
        provider: "manual",
        confidence: 0,
        warnings: [error instanceof Error ? error.message : String(error)]
      },
      events: [
        ...current.events,
        {
          at: new Date().toISOString(),
          level: "error",
          message: `Local LLM extraction failed: ${error instanceof Error ? error.message : String(error)}`
        }
      ]
    });
  }
}

app.get("/api/health", (_request, response) => {
  response.json({
    ok: true,
    service: "qoyod-invoice-intake-api",
    time: new Date().toISOString()
  });
});

app.get("/api/jobs", asyncHandler(async (_request, response) => {
  response.json({ jobs: await jobStore.list() });
}));

app.get("/api/jobs/:jobId", asyncHandler(async (request, response) => {
  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.post("/api/extraction/jobs/:jobId/start", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const updated = await startExtraction(job, requestBaseUrl(request), request.header("x-case-token") ? "case" : "manual");
  response.status(202).json({ job: updated, input: buildExtractionJobInput(updated, requestBaseUrl(request)) });
}));

app.get("/api/extraction/jobs/:jobId/input", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ input: buildExtractionJobInput(job, requestBaseUrl(request)) });
}));

app.get("/api/extraction/jobs/:jobId/source", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  const attachment = job?.draft.attachmentRefs[0];
  if (!job || !attachment?.localPath) {
    response.status(404).json({ error: "Source attachment not found." });
    return;
  }

  response.type(attachment.mimeType);
  response.sendFile(attachment.localPath);
}));

app.post("/api/extraction/jobs/:jobId/result", asyncHandler(async (request, response) => {
  if (!verifyExtractionToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = invoiceDraftSchema.parse(request.body.draft);
  const validation = reconcileDraft(draft);
  const provider = String(request.body.provider ?? "external");
  const providerName = ["openai", "deepseek", "external", "mock", "manual"].includes(provider) ? provider as "openai" | "deepseek" | "external" | "mock" | "manual" : "external";
  const warnings = Array.isArray(request.body.warnings)
    ? request.body.warnings.filter((item: unknown): item is string => typeof item === "string")
    : [];
  const job = await jobStore.update(current.jobId, {
    status: "needs_review",
    caseStage: "Extraction And Reconciliation",
    draft,
    validation,
    extraction: {
      provider: providerName,
      model: optionalString(request.body.model),
      confidence: typeof request.body.confidence === "number" ? request.body.confidence : undefined,
      warnings
    },
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: validation.canSubmitToRobot ? "info" : "warning",
        message: validation.canSubmitToRobot
          ? "Extraction result received and reconciled."
          : "Extraction result received with blocking review checks."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/fill/jobs/claim-next", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.claimNextForFill();
  response.json({ job: job ?? null });
}));

app.get("/api/fill/jobs/:jobId", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.get("/api/fill/jobs/:jobId/source", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  const attachment = job?.draft.attachmentRefs[0];
  if (!job || !attachment?.localPath) {
    response.status(404).json({ error: "Source attachment not found." });
    return;
  }

  response.type(attachment.mimeType);
  response.sendFile(attachment.localPath);
}));

app.post("/api/fill/jobs/:jobId/status", asyncHandler(async (request, response) => {
  if (!verifyFillToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const rawStatus = String(request.body.status ?? "");
  const status = deprecatedRobotStatusMap[rawStatus] ?? rawStatus;
  if (!jobStatuses.includes(status as (typeof jobStatuses)[number]) || !fillWritableStatuses.has(status)) {
    response.status(400).json({ error: "Unsupported Qoyod fill status." });
    return;
  }

  const message = optionalString(request.body.message) ?? `Qoyod fill status changed to ${status}.`;
  const now = new Date().toISOString();
  const job = await jobStore.update(current.jobId, {
    status: status as IntakeJob["status"],
    fill: {
      method: "chrome_extension",
      status: status === "draft_saved" ? "draft_saved" : status === "error" ? "error" : status === "ready_for_qoyod" ? "cancelled" : "filling",
      errorCode: optionalString(request.body.errorCode),
      qoyodDraftReference: optionalString(request.body.qoyodDraftReference),
      claimedAt: current.fill?.claimedAt,
      updatedAt: now
    },
    events: [
      ...current.events,
      {
        at: now,
        level: status === "error" ? "error" : "info",
        message
      }
    ]
  });

  response.json({ job });
}));

app.get("/api/robot/jobs/next", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const jobs = await jobStore.list();
  const job = jobs
    .filter((candidate) => candidate.status === "ready_for_qoyod" || candidate.status === "ready_for_robot")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];

  response.json({ job: job ?? null });
}));

app.get("/api/robot/jobs/:jobId", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const job = await jobStore.get(routeParam(request.params.jobId));
  if (!job) {
    response.status(404).json({ error: "Job not found." });
    return;
  }
  response.json({ job });
}));

app.post("/api/robot/jobs/:jobId/status", asyncHandler(async (request, response) => {
  if (!verifyRobotToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const rawStatus = String(request.body.status ?? "");
  const status = deprecatedRobotStatusMap[rawStatus] ?? rawStatus;
  if (!jobStatuses.includes(status as (typeof jobStatuses)[number]) || !fillWritableStatuses.has(status)) {
    response.status(400).json({ error: "Unsupported robot status." });
    return;
  }

  const message = typeof request.body.message === "string" && request.body.message.trim()
    ? request.body.message.trim()
    : `Robot status changed to ${status}.`;
  const level: JobEvent["level"] = status === "error" ? "error" : "info";
  const robotJobKey = typeof request.body.robotJobKey === "string" ? request.body.robotJobKey : current.robotJobKey;
  const job = await jobStore.update(current.jobId, {
    status: status as IntakeJob["status"],
    robotJobKey,
    fill: {
      method: "chrome_extension",
      status: status === "draft_saved" ? "draft_saved" : status === "error" ? "error" : "filling",
      errorCode: optionalString(request.body.errorCode),
      qoyodDraftReference: optionalString(request.body.qoyodDraftReference),
      claimedAt: current.fill?.claimedAt,
      updatedAt: new Date().toISOString()
    },
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level,
        message
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/captures", upload.single("document"), asyncHandler(async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: "A photo or PDF upload is required in the document field." });
    return;
  }

  const attachment: AttachmentRef = {
    id: uuid(),
    name: request.file.originalname,
    mimeType: request.file.mimetype,
    size: request.file.size,
    localPath: request.file.path
  };
  const qrPayload = typeof request.body.qrPayload === "string" ? request.body.qrPayload : undefined;
  const draft = draftFromCapture(attachment, qrPayload);
  const created = await jobStore.create(draft);
  const dispatched = await dispatchToUiPath(created, request.file);
  const job = await startExtraction(dispatched, requestBaseUrl(request), "capture");

  response.status(201).json({ jobId: job.jobId, job });
}));

app.post("/api/jobs/:jobId/extraction", asyncHandler(async (request, response) => {
  const token = process.env.INTAKE_WEBHOOK_TOKEN;
  if (token && request.header("x-intake-token") !== token) {
    response.status(401).json({ error: "Invalid intake webhook token." });
    return;
  }

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = invoiceDraftSchema.parse(request.body.draft);
  const validation = reconcileDraft(draft);
  const job = await jobStore.update(current.jobId, {
    status: "needs_review",
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: "info",
        message: "Extraction result received."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/extraction", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = invoiceDraftSchema.parse(request.body.draft);
  const validation = reconcileDraft(draft);
  const job = await jobStore.update(current.jobId, {
    ...casePatchFromBody(request.body),
    caseStage: "Extraction And Reconciliation",
    status: "needs_review",
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: validation.canSubmitToRobot ? "info" : "warning",
        message: validation.canSubmitToRobot
          ? "Maestro Case extraction and reconciliation result received."
          : "Maestro Case extraction needs review or correction."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/jobs/:jobId/review", asyncHandler(async (request, response) => {
  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = invoiceDraftSchema.parse(request.body.draft);
  const validation = reconcileDraft(draft);
  const reviewedStatus = validation.canSubmitToRobot ? "ready_for_qoyod" : "needs_review";
  const job = await jobStore.update(current.jobId, {
    status: reviewedStatus,
    fill: validation.canSubmitToRobot ? {
      method: "chrome_extension",
      status: "ready",
      updatedAt: new Date().toISOString()
    } : current.fill,
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: validation.canSubmitToRobot ? "info" : "warning",
        message: validation.canSubmitToRobot ? "Review complete. Draft is ready for the Qoyod Chrome extension." : "Review saved with blocking checks."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/review", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const draft = invoiceDraftSchema.parse(request.body.draft);
  const validation = reconcileDraft(draft);
  const reviewDecision = String(request.body.reviewDecision ?? "save").toLowerCase();
  const status: IntakeJob["status"] = ["reject", "rejected"].includes(reviewDecision)
    ? "rejected"
    : validation.canSubmitToRobot && ["approve", "approve_for_qoyod", "ready_for_robot"].includes(reviewDecision)
      ? "ready_for_qoyod"
      : "needs_review";
  const job = await jobStore.update(current.jobId, {
    ...casePatchFromBody(request.body),
    caseStage: "Finance Review And Mapping",
    status,
    fill: status === "ready_for_qoyod" ? {
      method: "chrome_extension",
      status: "ready",
      updatedAt: new Date().toISOString()
    } : current.fill,
    draft,
    validation,
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: status === "ready_for_qoyod" ? "info" : status === "rejected" ? "warning" : "warning",
        message: status === "ready_for_qoyod"
          ? "Maestro Case review approved the draft for the Qoyod Chrome extension."
          : status === "rejected"
            ? "Maestro Case review rejected the invoice."
            : "Maestro Case review saved with blocking checks or incomplete mapping."
      }
    ]
  });

  response.json({ job });
}));

app.post("/api/case/jobs/:jobId/exception", asyncHandler(async (request, response) => {
  if (!verifyCaseToken(request, response)) return;

  const current = await jobStore.get(routeParam(request.params.jobId));
  if (!current) {
    response.status(404).json({ error: "Job not found." });
    return;
  }

  const errorCode = optionalString(request.body.errorCode) ?? "case_exception";
  const message = optionalString(request.body.message) ?? `Maestro Case exception: ${errorCode}`;
  const resolved = request.body.resolved === true;
  const job = await jobStore.update(current.jobId, {
    ...casePatchFromBody(request.body),
    caseStage: optionalString(request.body.caseStage) ?? "Exception Resolution",
    status: resolved ? "needs_review" : "error",
    events: [
      ...current.events,
      {
        at: new Date().toISOString(),
        level: resolved ? "info" : "error",
        message
      }
    ]
  });

  response.json({ job });
}));

await jobStore.init();
app.listen(PORT, () => {
  console.log(`Qoyod invoice intake API listening on http://localhost:${PORT}`);
});
