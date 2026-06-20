import type { IntakeJob, InvoiceDraft } from "../shared/invoice";

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function uploadCapture(file: File, qrPayload: string): Promise<IntakeJob> {
  const formData = new FormData();
  formData.append("document", file);
  if (qrPayload.trim()) {
    formData.append("qrPayload", qrPayload.trim());
  }

  const response = await fetch("/api/captures", {
    method: "POST",
    body: formData
  });
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}

export async function getJob(jobId: string): Promise<IntakeJob> {
  const response = await fetch(`/api/jobs/${jobId}`);
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}

export async function saveReview(jobId: string, draft: InvoiceDraft): Promise<IntakeJob> {
  const response = await fetch(`/api/jobs/${jobId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ draft })
  });
  const body = await parseResponse<{ job: IntakeJob }>(response);
  return body.job;
}
