# Qoyod Invoice Intake as Backend-First UiPath Maestro Case

Track 1 pilot for invoice intake into Qoyod without IXP, RPA, or Qoyod API access.

- Phone PWA captures QR plus invoice photo/PDF.
- Express API stores job state, uploads files to Orchestrator Storage, creates `InvoiceIntake` queue items, and can start a Maestro Case once CaseManagement runtime is available.
- Extraction runs through a modular backend worker: OpenAI vision/PDF first, DeepSeek JSON normalization second when configured.
- Finance review remains human-controlled in the PWA or Coded Action App.
- Qoyod fill is handled by a desktop Chrome extension using the user's logged-in Qoyod browser session. It saves draft only after explicit confirmation.

## Run Locally

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`. The API runs on `http://localhost:8787`.

For the complete operator walkthrough, see `docs/USER_GUIDE.md`.

## Local Env

Copy `.env.example` and set the local secrets you have:

```powershell
$env:PUBLIC_API_BASE_URL="http://localhost:8787"
$env:EXTRACTION_MODE="local"
$env:OPENAI_API_KEY="<openai-key>"
$env:OPENAI_EXTRACTION_MODEL="gpt-4.1"
$env:DEEPSEEK_API_KEY="<deepseek-key>"
$env:DEEPSEEK_MODEL="deepseek-v4-flash"
$env:FILLER_API_TOKEN="<shared-extension-token>"
```

Use `EXTRACTION_MODE=external` plus `EXTRACTION_START_URL` when extraction moves to a separate backend. Cloud Maestro cannot call localhost, so Case-driven execution needs `PUBLIC_API_BASE_URL` to be a public HTTPS URL.

## UiPath Resources

Configure these per tenant in your local `.env`; no connected environment values are committed.

- Base URL: your UiPath Automation Cloud URL
- Organization: your organization name
- Tenant: your tenant name
- Folder: your target folder path
- Folder key: your target folder key
- Queue: `InvoiceIntake`
- Storage bucket: your invoice-intake storage bucket
- Case solution: `uipath/QoyodInvoiceIntakeSolution`
- Case file: `uipath/QoyodInvoiceIntakeSolution/QoyodInvoiceIntakeCase/caseplan.json`

The Case remains the visible Maestro design. If CaseManagement runtime is not available in your tenant, the backend can start extraction immediately after capture. Once runtime exists, a Case/API Workflow can call the same extraction endpoint.

## API Endpoints

Capture and review:

```http
POST /api/captures
GET /api/jobs/{jobId}
POST /api/jobs/{jobId}/review
```

Extraction:

```http
POST /api/extraction/jobs/{jobId}/start
GET /api/extraction/jobs/{jobId}/input
GET /api/extraction/jobs/{jobId}/source
POST /api/extraction/jobs/{jobId}/result
```

Qoyod extension fill:

```http
POST /api/fill/jobs/claim-next
GET /api/fill/jobs/{jobId}
GET /api/fill/jobs/{jobId}/source
POST /api/fill/jobs/{jobId}/status
```

Deprecated `/api/robot/...` aliases remain for compatibility, but new work should use `/api/fill/...`.

## Chrome Extension

Load `extension/qoyod-filler` as an unpacked Chrome extension:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Load unpacked and select `extension/qoyod-filler`.
4. Log into Qoyod in Chrome and open the draft form.
5. Click the extension toolbar icon to open the side panel.
6. Configure API base URL and fill token in the side panel.
7. Calibrate selectors once, then claim, fill, review, and save draft.

The extension never stores Qoyod credentials and never clicks approve/submit.

## Current Blockers

- No IXP access: extraction is LLM-backed.
- No RPA license/runtime: Qoyod fill is extension-assisted.
- No Qoyod API access: the extension uses the logged-in browser session.
- No CaseManagement runtime in staging: backend-first execution is active until runtime is allocated.

## Verify

```powershell
npm test
npm run build
npm audit --audit-level=low
uip maestro case validate uipath/QoyodInvoiceIntakeSolution/QoyodInvoiceIntakeCase/caseplan.json --output json
```
