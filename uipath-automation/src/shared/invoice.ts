import { z } from "zod";

export const jobStatuses = [
  "uploaded",
  "queued",
  "extracting",
  "needs_review",
  "ready_for_qoyod",
  "qoyod_filling",
  "ready_for_robot",
  "robot_running",
  "draft_saved",
  "rejected",
  "error"
] as const;

export const extractionProviderSchema = z.enum(["openai", "deepseek", "external", "mock", "manual"]);

export const extractionMetadataSchema = z.object({
  provider: extractionProviderSchema,
  model: z.string().optional(),
  confidence: z.coerce.number().min(0).max(1).optional(),
  warnings: z.array(z.string()).default([])
});

export const fillMetadataSchema = z.object({
  method: z.literal("chrome_extension"),
  status: z.enum(["ready", "claimed", "filling", "draft_saved", "error", "cancelled"]),
  errorCode: z.string().optional(),
  qoyodDraftReference: z.string().optional(),
  claimedAt: z.string().optional(),
  updatedAt: z.string().optional()
});

export const mappingSchema = z.object({
  type: z.enum(["item", "expense"]),
  id: z.string().min(1),
  label: z.string().min(1)
});

export const lineItemSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  quantity: z.coerce.number().nonnegative(),
  unitPrice: z.coerce.number().nonnegative(),
  discount: z.coerce.number().nonnegative().default(0),
  taxRate: z.coerce.number().nonnegative().default(15),
  taxAmount: z.coerce.number().nonnegative().default(0),
  total: z.coerce.number().nonnegative(),
  selectedQoyodMapping: mappingSchema.optional()
});

export const attachmentRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().nonnegative(),
  localPath: z.string().optional(),
  bucketKey: z.string().optional(),
  bucketPath: z.string().optional()
});

export const qrTlvSchema = z.object({
  sellerName: z.string().optional(),
  vatRegistrationNumber: z.string().optional(),
  timestamp: z.string().optional(),
  totalWithVat: z.number().optional(),
  vatTotal: z.number().optional(),
  rawPayload: z.string(),
  rawTags: z.record(z.string())
});

export const invoiceDraftSchema = z.object({
  supplierName: z.string().default(""),
  supplierTaxId: z.string().default(""),
  invoiceNumber: z.string().default(""),
  issueDate: z.string().default(""),
  dueDate: z.string().default(""),
  currency: z.string().default("SAR"),
  subtotal: z.coerce.number().nonnegative().default(0),
  discount: z.coerce.number().nonnegative().default(0),
  vatTotal: z.coerce.number().nonnegative().default(0),
  grandTotal: z.coerce.number().nonnegative().default(0),
  attachmentRefs: z.array(attachmentRefSchema).default([]),
  qrTlv: qrTlvSchema.optional(),
  lineItems: z.array(lineItemSchema).default([])
});

export const validationResultSchema = z.object({
  canSubmitToRobot: z.boolean(),
  blocking: z.array(z.string()),
  warnings: z.array(z.string()),
  totals: z.object({
    lineSubtotal: z.number(),
    lineVat: z.number(),
    lineGrandTotal: z.number(),
    headerGrandTotal: z.number(),
    headerVatTotal: z.number()
  })
});

export const jobEventSchema = z.object({
  at: z.string(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string()
});

export const intakeJobSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(jobStatuses),
  createdAt: z.string(),
  updatedAt: z.string(),
  draft: invoiceDraftSchema,
  validation: validationResultSchema.optional(),
  events: z.array(jobEventSchema).default([]),
  queueItemKey: z.string().optional(),
  robotJobKey: z.string().optional(),
  caseInstanceId: z.string().optional(),
  caseJobKey: z.string().optional(),
  caseExternalId: z.string().optional(),
  caseStage: z.string().optional(),
  extraction: extractionMetadataSchema.optional(),
  fill: fillMetadataSchema.optional()
});

export type JobStatus = (typeof jobStatuses)[number];
export type ExtractionMetadata = z.infer<typeof extractionMetadataSchema>;
export type FillMetadata = z.infer<typeof fillMetadataSchema>;
export type QoyodMapping = z.infer<typeof mappingSchema>;
export type InvoiceLineItem = z.infer<typeof lineItemSchema>;
export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
export type ZatcaQr = z.infer<typeof qrTlvSchema>;
export type InvoiceDraft = z.infer<typeof invoiceDraftSchema>;
export type ValidationResult = z.infer<typeof validationResultSchema>;
export type JobEvent = z.infer<typeof jobEventSchema>;
export type IntakeJob = z.infer<typeof intakeJobSchema>;

export function emptyDraft(): InvoiceDraft {
  return {
    supplierName: "",
    supplierTaxId: "",
    invoiceNumber: "",
    issueDate: "",
    dueDate: "",
    currency: "SAR",
    subtotal: 0,
    discount: 0,
    vatTotal: 0,
    grandTotal: 0,
    attachmentRefs: [],
    lineItems: []
  };
}
