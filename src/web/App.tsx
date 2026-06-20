import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  FileText,
  Plus,
  RefreshCw,
  Save,
  ScanLine,
  Trash2,
  Upload
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { IntakeJob, InvoiceDraft, InvoiceLineItem, JobStatus, QoyodMapping } from "../shared/invoice";
import { decodeZatcaTlv } from "../shared/zatca";
import { getJob, saveReview, uploadCapture } from "./api";

const statusLabels: Record<JobStatus, string> = {
  uploaded: "Uploaded",
  queued: "Queued",
  extracting: "Extracting",
  needs_review: "Needs review",
  ready_for_qoyod: "Ready for Qoyod",
  qoyod_filling: "Filling Qoyod",
  ready_for_robot: "Ready for Qoyod",
  robot_running: "Filling Qoyod",
  draft_saved: "Draft saved",
  rejected: "Rejected",
  error: "Error"
};

const emptyMapping: QoyodMapping = {
  type: "expense",
  id: "",
  label: ""
};

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function newLineItem(): InvoiceLineItem {
  return {
    id: crypto.randomUUID(),
    description: "",
    quantity: 1,
    unitPrice: 0,
    discount: 0,
    taxRate: 15,
    taxAmount: 0,
    total: 0,
    selectedQoyodMapping: { ...emptyMapping }
  };
}

function recalcLine(line: InvoiceLineItem): InvoiceLineItem {
  const net = Math.max(0, numberValue(line.quantity) * numberValue(line.unitPrice) - numberValue(line.discount));
  const taxAmount = Math.round(net * (numberValue(line.taxRate) / 100) * 100) / 100;
  const total = Math.round((net + taxAmount) * 100) / 100;
  return { ...line, taxAmount, total };
}

function deriveHeaderTotals(draft: InvoiceDraft): InvoiceDraft {
  const subtotal = Math.round(
    draft.lineItems.reduce((sum, line) => sum + Math.max(0, line.quantity * line.unitPrice - line.discount), 0) * 100
  ) / 100;
  const vatTotal = Math.round(draft.lineItems.reduce((sum, line) => sum + line.taxAmount, 0) * 100) / 100;
  const grandTotal = Math.round(draft.lineItems.reduce((sum, line) => sum + line.total, 0) * 100) / 100;
  return { ...draft, subtotal, vatTotal, grandTotal };
}

export function App() {
  const [file, setFile] = useState<File | null>(null);
  const [qrPayload, setQrPayload] = useState("");
  const [job, setJob] = useState<IntakeJob | null>(null);
  const [draft, setDraft] = useState<InvoiceDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cameraActive, setCameraActive] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimerRef = useRef<number | null>(null);

  const decodedQr = useMemo(() => decodeZatcaTlv(qrPayload), [qrPayload]);

  useEffect(() => {
    if (!job || !["queued", "extracting", "qoyod_filling", "robot_running"].includes(job.status)) {
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        const refreshed = await getJob(job.jobId);
        setJob(refreshed);
        setDraft(refreshed.draft);
      } catch (requestError) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    }, 2500);

    return () => window.clearInterval(timer);
  }, [job]);

  useEffect(() => {
    return () => stopCamera();
  }, []);

  async function startCamera() {
    setError("");
    setScanMessage("");

    const barcodeDetector = "BarcodeDetector" in window
      ? new (window as unknown as { BarcodeDetector: new (options: { formats: string[] }) => { detect: (source: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> } }).BarcodeDetector({ formats: ["qr_code"] })
      : null;

    if (!barcodeDetector) {
      setScanMessage("QR scanner unavailable on this browser. Paste the QR payload or upload the invoice.");
      return;
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    streamRef.current = stream;
    setCameraActive(true);

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }

    scanTimerRef.current = window.setInterval(async () => {
      if (!videoRef.current) return;
      const codes = await barcodeDetector.detect(videoRef.current).catch(() => []);
      const qr = codes[0]?.rawValue;
      if (qr) {
        setQrPayload(qr);
        setScanMessage("QR captured.");
        stopCamera();
      }
    }, 600);
  }

  function stopCamera() {
    if (scanTimerRef.current) {
      window.clearInterval(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setCameraActive(false);
  }

  async function submitCapture() {
    if (!file) {
      setError("Choose a photo or PDF first.");
      return;
    }

    setBusy(true);
    setError("");
    try {
      const created = await uploadCapture(file, qrPayload);
      setJob(created);
      setDraft(created.draft);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  function updateDraft(patch: Partial<InvoiceDraft>) {
    if (!draft) return;
    setDraft({ ...draft, ...patch });
  }

  function updateLine(lineId: string, patch: Partial<InvoiceLineItem>) {
    if (!draft) return;
    const nextLines = draft.lineItems.map((line) => (line.id === lineId ? recalcLine({ ...line, ...patch }) : line));
    setDraft(deriveHeaderTotals({ ...draft, lineItems: nextLines }));
  }

  function updateLineMapping(lineId: string, patch: Partial<QoyodMapping>) {
    if (!draft) return;
    const nextLines = draft.lineItems.map((line) => {
      if (line.id !== lineId) return line;
      return {
        ...line,
        selectedQoyodMapping: {
          ...(line.selectedQoyodMapping ?? emptyMapping),
          ...patch
        }
      };
    });
    setDraft({ ...draft, lineItems: nextLines });
  }

  function addLine() {
    if (!draft) return;
    setDraft({ ...draft, lineItems: [...draft.lineItems, newLineItem()] });
  }

  function removeLine(lineId: string) {
    if (!draft) return;
    setDraft(deriveHeaderTotals({ ...draft, lineItems: draft.lineItems.filter((line) => line.id !== lineId) }));
  }

  async function submitReview() {
    if (!job || !draft) return;
    setBusy(true);
    setError("");
    try {
      const updated = await saveReview(job.jobId, draft);
      setJob(updated);
      setDraft(updated.draft);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <FileText size={24} aria-hidden="true" />
          <div>
            <strong>Qoyod Intake</strong>
            <span>Invoice draft capture</span>
          </div>
        </div>
        <div className={`status-pill status-${job?.status ?? "uploaded"}`}>{job ? statusLabels[job.status] : "No job"}</div>
      </header>

      <main className="workspace">
        <section className="panel capture-panel">
          <div className="panel-heading">
            <h1>Capture</h1>
            <button className="icon-button" title="Refresh job" disabled={!job || busy} onClick={() => job && getJob(job.jobId).then((refreshed) => {
              setJob(refreshed);
              setDraft(refreshed.draft);
            })}>
              <RefreshCw size={18} />
            </button>
          </div>

          <div className="scan-box">
            <video ref={videoRef} className={cameraActive ? "scanner active" : "scanner"} muted playsInline />
            <div className="scan-actions">
              {!cameraActive ? (
                <button className="secondary-button" type="button" onClick={startCamera}>
                  <ScanLine size={18} />
                  Scan QR
                </button>
              ) : (
                <button className="secondary-button danger" type="button" onClick={stopCamera}>
                  <Camera size={18} />
                  Stop camera
                </button>
              )}
            </div>
          </div>

          <label className="field">
            <span>QR payload</span>
            <textarea value={qrPayload} onChange={(event) => setQrPayload(event.target.value)} rows={4} />
          </label>

          {decodedQr && (
            <div className="qr-grid">
              <span>{decodedQr.sellerName || "Seller pending"}</span>
              <span>{decodedQr.vatRegistrationNumber || "VAT pending"}</span>
              <span>{decodedQr.totalWithVat ? `${decodedQr.totalWithVat.toFixed(2)} SAR` : "Total pending"}</span>
            </div>
          )}

          <label className="file-drop">
            <Upload size={22} aria-hidden="true" />
            <span>{file ? file.name : "Choose invoice photo or PDF"}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,application/pdf"
              capture="environment"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          </label>

          <button className="primary-button" type="button" disabled={busy || !file} onClick={submitCapture}>
            <Upload size={18} />
            Upload capture
          </button>

          {scanMessage && <div className="notice">{scanMessage}</div>}
          {error && <div className="notice error">{error}</div>}
        </section>

        <section className="panel review-panel">
          <div className="panel-heading">
            <h2>Review</h2>
            {job && <code>{job.jobId.slice(0, 8)}</code>}
          </div>

          {!draft ? (
            <div className="empty-state">
              <FileText size={36} />
              <span>Waiting for capture</span>
            </div>
          ) : (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>Supplier</span>
                  <input value={draft.supplierName} onChange={(event) => updateDraft({ supplierName: event.target.value })} />
                </label>
                <label className="field">
                  <span>Tax ID</span>
                  <input value={draft.supplierTaxId} onChange={(event) => updateDraft({ supplierTaxId: event.target.value })} />
                </label>
                <label className="field">
                  <span>Invoice no.</span>
                  <input value={draft.invoiceNumber} onChange={(event) => updateDraft({ invoiceNumber: event.target.value })} />
                </label>
                <label className="field">
                  <span>Issue date</span>
                  <input type="date" value={draft.issueDate} onChange={(event) => updateDraft({ issueDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>Due date</span>
                  <input type="date" value={draft.dueDate} onChange={(event) => updateDraft({ dueDate: event.target.value })} />
                </label>
                <label className="field">
                  <span>Currency</span>
                  <input value={draft.currency} onChange={(event) => updateDraft({ currency: event.target.value.toUpperCase() })} />
                </label>
              </div>

              <div className="totals-strip">
                <label className="field">
                  <span>Subtotal</span>
                  <input type="number" value={draft.subtotal} onChange={(event) => updateDraft({ subtotal: numberValue(event.target.value) })} />
                </label>
                <label className="field">
                  <span>VAT</span>
                  <input type="number" value={draft.vatTotal} onChange={(event) => updateDraft({ vatTotal: numberValue(event.target.value) })} />
                </label>
                <label className="field">
                  <span>Grand total</span>
                  <input type="number" value={draft.grandTotal} onChange={(event) => updateDraft({ grandTotal: numberValue(event.target.value) })} />
                </label>
              </div>

              <div className="line-header">
                <h3>Line items</h3>
                <button className="secondary-button" type="button" onClick={addLine}>
                  <Plus size={18} />
                  Add line
                </button>
              </div>

              <div className="line-table">
                {draft.lineItems.map((line) => (
                  <div className="line-row" key={line.id}>
                    <label className="field span-2">
                      <span>Description</span>
                      <input value={line.description} onChange={(event) => updateLine(line.id, { description: event.target.value })} />
                    </label>
                    <label className="field">
                      <span>Qty</span>
                      <input type="number" value={line.quantity} onChange={(event) => updateLine(line.id, { quantity: numberValue(event.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Unit</span>
                      <input type="number" value={line.unitPrice} onChange={(event) => updateLine(line.id, { unitPrice: numberValue(event.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Disc.</span>
                      <input type="number" value={line.discount} onChange={(event) => updateLine(line.id, { discount: numberValue(event.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Tax %</span>
                      <input type="number" value={line.taxRate} onChange={(event) => updateLine(line.id, { taxRate: numberValue(event.target.value) })} />
                    </label>
                    <label className="field">
                      <span>Mapping</span>
                      <input
                        value={line.selectedQoyodMapping?.label ?? ""}
                        onChange={(event) => updateLineMapping(line.id, { label: event.target.value, id: event.target.value.trim() })}
                      />
                    </label>
                    <label className="field">
                      <span>Type</span>
                      <select
                        value={line.selectedQoyodMapping?.type ?? "expense"}
                        onChange={(event) => updateLineMapping(line.id, { type: event.target.value as QoyodMapping["type"] })}
                      >
                        <option value="expense">Expense</option>
                        <option value="item">Item</option>
                      </select>
                    </label>
                    <div className="line-total">{line.total.toFixed(2)}</div>
                    <button className="icon-button danger" type="button" title="Remove line" onClick={() => removeLine(line.id)}>
                      <Trash2 size={18} />
                    </button>
                  </div>
                ))}
              </div>

              {job?.validation && (
                <div className={job.validation.canSubmitToRobot ? "validation ok" : "validation"}>
                  <div className="validation-title">
                    {job.validation.canSubmitToRobot ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
                    <span>{job.validation.canSubmitToRobot ? "Ready" : "Blocked"}</span>
                  </div>
                  {job.validation.blocking.map((item) => <p key={item}>{item}</p>)}
                  {job.validation.warnings.map((item) => <p key={item}>{item}</p>)}
                </div>
              )}

              <button className="primary-button" type="button" disabled={busy || !job} onClick={submitReview}>
                <Save size={18} />
                Save review
              </button>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
