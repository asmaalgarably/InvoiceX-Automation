# Qoyod Invoice Intake User Guide

This guide walks through the no-IXP/no-RPA pilot from invoice capture to a saved Qoyod draft.

## What You Need

- The local app running with `npm run dev`.
- API available at `http://localhost:8787`.
- PWA available at `http://localhost:5173`.
- OpenAI key configured for extraction.
- Optional DeepSeek key for second-pass normalization.
- Qoyod Filler Chrome extension loaded as an unpacked extension.
- A Chrome browser session already logged into Qoyod.

## Moving Parts

- Phone/PWA capture: scans the FATOORA QR when available and uploads the invoice photo or PDF.
- Express API: stores the intake job, source file, extracted draft, review status, and fill status.
- LLM extraction: reads the uploaded image/PDF and produces a normalized invoice draft.
- UiPath Maestro Case artifact: documents the case stages and will call the same backend endpoints after CaseManagement runtime is available.
- Orchestrator bucket/queue: stores source files and queue signals for the UiPath-facing pilot surface.
- Finance review: confirms fields, totals, line items, and Qoyod item/expense mappings before Qoyod is touched.
- Chrome side panel extension: claims a reviewed job and fills Qoyod in the logged-in browser.
- Qoyod browser tab: remains under the user’s control; the output is a draft only.

## 1. Start The App

From the project folder:

```powershell
npm install
npm run dev
```

Open `http://localhost:5173`.

Make sure the backend environment includes:

```powershell
$env:PUBLIC_API_BASE_URL="http://localhost:8787"
$env:EXTRACTION_MODE="local"
$env:OPENAI_API_KEY="<openai-key>"
$env:FILLER_API_TOKEN="<shared-extension-token>"
```

## 2. Capture The Invoice

1. Open the PWA on a phone or desktop browser.
2. Click Scan QR if the invoice has a Saudi FATOORA QR code.
3. If camera QR scanning is unavailable, paste the QR payload manually.
4. Choose the invoice photo or PDF.
5. Click Upload capture.

The backend uploads the file, creates local job state, and starts extraction.

## 3. Wait For Extraction

The job status moves to Extracting while the backend worker runs.

- With `OPENAI_API_KEY`, the worker extracts invoice headers and line items from the photo/PDF.
- With `DEEPSEEK_API_KEY`, DeepSeek can normalize the extracted JSON.
- Without an extraction key, the job falls back to manual review with the QR-seeded draft.

Refresh or wait for the PWA to show the review form.

## 4. Review And Map

In the PWA review panel:

1. Check supplier name and tax ID.
2. Check invoice number, issue date, due date, and currency.
3. Check subtotal, VAT, and grand total.
4. Review every line item.
5. Add missing line items if extraction missed anything.
6. For each line, set the Qoyod mapping label and type.
7. Click Save review.

The job becomes ready for Qoyod only when totals reconcile and required mappings are present.

## 5. Load The Chrome Side Panel

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select Load unpacked.
4. Choose `extension/qoyod-filler`.
5. Click the extension toolbar icon to open the Qoyod Filler side panel.
6. Pin the extension if you want the toolbar icon to stay visible.

In the side panel, set:

- API base URL: `http://localhost:8787`
- Fill token: same value as `FILLER_API_TOKEN`
- Qoyod base URL: `https://www.qoyod.com`

Click Save.

## 6. Calibrate Qoyod Fields

Calibration teaches the extension which Qoyod fields to use.

1. In Chrome, log into Qoyod.
2. Open the Qoyod purchase/simple bill draft form.
3. In the side panel, click Calibrate selectors.
4. Follow the banner prompts on the Qoyod page.
5. Click each requested field or button.
6. Press Escape to skip optional controls, such as attachment upload, if needed.

Recalibrate if Qoyod changes the page layout or fields stop filling correctly.

## 7. Fill Qoyod

1. Keep the Qoyod draft form open in the active tab.
2. In the side panel, click Claim next reviewed invoice.
3. Confirm the current job details shown in the side panel.
4. Click Fill current Qoyod page.
5. Review all filled fields inside Qoyod.
6. If attachment upload did not work automatically, upload the source invoice manually.
7. Click Save draft only.
8. Confirm the save prompt.

The extension reports `draft_saved` back to the backend. It does not approve or submit the invoice.

## Troubleshooting

- No extraction happens: confirm `OPENAI_API_KEY` is set, or review the QR-seeded draft manually.
- No reviewed invoice is ready: finish review in the PWA and make sure every line has a mapping.
- Qoyod is not logged in: log into Qoyod in the same Chrome profile, then retry.
- Missing calibration: open the Qoyod draft form and run Calibrate selectors.
- Selector failure: recalibrate; Qoyod likely changed markup or the wrong form is open.
- Attachment needs manual upload: upload the invoice file in Qoyod by hand, then save draft.
- Cloud Maestro cannot call localhost: use a public HTTPS API URL when CaseManagement runtime is available.
- Side panel does not open: use Chrome 114 or newer and reload the unpacked extension.
