const CALIBRATION_FIELDS = [
  ["supplier", "Supplier selector/input"],
  ["invoiceNumber", "Invoice/reference number"],
  ["issueDate", "Issue date"],
  ["dueDate", "Due date"],
  ["addLine", "Add line button"],
  ["lineDescription", "First line description"],
  ["lineQuantity", "First line quantity"],
  ["lineUnitPrice", "First line unit price"],
  ["lineDiscount", "First line discount"],
  ["lineTax", "First line tax percent"],
  ["lineMapping", "First line item/expense mapping"],
  ["attachmentInput", "Attachment file input or upload control"],
  ["saveDraftButton", "Save draft button"]
];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  });
  return true;
});

async function handleMessage(message) {
  if (message.type === "QOYOD_START_CALIBRATION") {
    return startCalibration(message.qoyodBaseUrl);
  }
  if (message.type === "QOYOD_FILL_JOB") {
    return fillJob(message.job, message.config);
  }
  if (message.type === "QOYOD_SAVE_DRAFT") {
    return saveDraft();
  }
  return { ok: false, error: "Unknown Qoyod filler message." };
}

async function startCalibration(qoyodBaseUrl) {
  assertQoyodPage(qoyodBaseUrl);
  const profile = {};

  for (const [key, label] of CALIBRATION_FIELDS) {
    const element = await captureElement(`Click the Qoyod ${label}. Press Escape to skip optional fields.`);
    if (element) {
      profile[key] = selectorFor(element);
      flash(element);
    }
  }

  await chrome.storage.local.set({ qoyodSelectorProfile: profile });
  return { ok: true, message: `Calibration saved ${Object.keys(profile).length} selectors.` };
}

async function fillJob(job, config) {
  assertQoyodPage(config.qoyodBaseUrl);
  const { qoyodSelectorProfile } = await chrome.storage.local.get({ qoyodSelectorProfile: null });
  const profile = qoyodSelectorProfile || {};
  const required = ["supplier", "invoiceNumber", "issueDate", "lineDescription", "lineQuantity", "lineUnitPrice", "saveDraftButton"];
  const missing = required.filter((key) => !profile[key]);
  if (missing.length) {
    return { ok: false, error: `Missing calibration: ${missing.join(", ")}`, errorCode: "selector_profile_missing" };
  }

  const draft = job.draft;
  setValue(profile.supplier, draft.supplierName || draft.supplierTaxId);
  setValue(profile.invoiceNumber, draft.invoiceNumber);
  setValue(profile.issueDate, draft.issueDate);
  if (profile.dueDate) setValue(profile.dueDate, draft.dueDate);

  const lines = draft.lineItems || [];
  for (let index = 0; index < lines.length; index += 1) {
    if (index > 0 && profile.addLine) {
      click(profile.addLine);
      await wait(250);
    }
    fillLine(profile, lines[index], index);
  }

  const attachmentResult = await attachSourceIfPossible(profile, job, config);
  const suffix = attachmentResult ? ` ${attachmentResult}` : "";
  return { ok: true, message: `Filled ${lines.length} line(s).${suffix}` };
}

async function saveDraft() {
  const { qoyodSelectorProfile } = await chrome.storage.local.get({ qoyodSelectorProfile: null });
  const selector = qoyodSelectorProfile?.saveDraftButton;
  if (!selector) {
    return { ok: false, error: "Missing save draft calibration.", errorCode: "selector_profile_missing" };
  }
  if (!window.confirm("Save this Qoyod document as a draft only?")) {
    return { ok: false, error: "User cancelled draft save.", errorCode: "save_cancelled" };
  }

  click(selector);
  await wait(1000);
  return { ok: true, reference: inferDraftReference() };
}

function fillLine(profile, line, index) {
  setRepeatedValue(profile.lineDescription, index, line.description);
  setRepeatedValue(profile.lineQuantity, index, String(line.quantity ?? ""));
  setRepeatedValue(profile.lineUnitPrice, index, String(line.unitPrice ?? ""));
  if (profile.lineDiscount) setRepeatedValue(profile.lineDiscount, index, String(line.discount ?? 0));
  if (profile.lineTax) setRepeatedValue(profile.lineTax, index, String(line.taxRate ?? 15));
  if (profile.lineMapping) setRepeatedValue(profile.lineMapping, index, line.selectedQoyodMapping?.label || line.selectedQoyodMapping?.id || "");
}

async function attachSourceIfPossible(profile, job, config) {
  if (!profile.attachmentInput) return "";
  const input = document.querySelector(profile.attachmentInput);
  if (!(input instanceof HTMLInputElement) || input.type !== "file") {
    return "Attachment control needs manual upload.";
  }

  try {
    const response = await fetch(`${config.apiBaseUrl}/api/fill/jobs/${job.jobId}/source`, {
      headers: config.fillToken ? { "x-fill-token": config.fillToken } : {}
    });
    if (!response.ok) return "Attachment fetch failed; upload manually.";

    const blob = await response.blob();
    const attachment = job.draft.attachmentRefs?.[0];
    const file = new File([blob], attachment?.name || "invoice-upload", { type: attachment?.mimeType || blob.type });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return "Attachment staged.";
  } catch {
    return "Attachment upload needs manual handling.";
  }
}

function assertQoyodPage(qoyodBaseUrl) {
  const expected = new URL(qoyodBaseUrl || "https://www.qoyod.com").hostname.replace(/^www\./, "");
  if (!window.location.hostname.endsWith(expected)) {
    throw new Error("Open the Qoyod draft form in the active tab first.");
  }
  if (/login|sign_in|users\/sign_in/i.test(window.location.href)) {
    throw new Error("Qoyod is showing a login page. Log in first, then retry.");
  }
}

function setRepeatedValue(selector, index, value) {
  const elements = Array.from(document.querySelectorAll(selector));
  const element = elements[index] || elements[elements.length - 1];
  if (!element) throw new Error(`Selector not found: ${selector}`);
  setElementValue(element, value);
}

function setValue(selector, value) {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Selector not found: ${selector}`);
  setElementValue(element, value);
}

function setElementValue(element, value) {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    element.focus();
    element.value = value ?? "";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.blur();
    return;
  }

  element.textContent = value ?? "";
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function click(selector) {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Selector not found: ${selector}`);
  element.click();
}

function captureElement(message) {
  return new Promise((resolve) => {
    const banner = document.createElement("div");
    banner.textContent = message;
    banner.style.cssText = "position:fixed;z-index:2147483647;top:12px;left:12px;right:12px;background:#143c34;color:white;padding:12px 14px;border-radius:6px;font:14px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.2)";
    document.body.appendChild(banner);

    const cleanup = () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
      banner.remove();
    };

    const onClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      resolve(event.target);
    };

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cleanup();
        resolve(null);
      }
    };

    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
  });
}

function selectorFor(element) {
  if (!(element instanceof Element)) throw new Error("Calibration target is not an element.");
  if (element.id) return `#${CSS.escape(element.id)}`;
  const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("name");
  if (testId) {
    const attr = element.getAttribute("data-testid") ? "data-testid" : element.getAttribute("data-test") ? "data-test" : "name";
    return `${element.tagName.toLowerCase()}[${attr}="${cssAttr(testId)}"]`;
  }

  const parts = [];
  let node = element;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
    const index = siblings.indexOf(node) + 1;
    parts.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
    node = parent;
  }
  return parts.join(" > ");
}

function cssAttr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function flash(element) {
  if (!(element instanceof HTMLElement)) return;
  const previous = element.style.outline;
  element.style.outline = "3px solid #1b8f66";
  window.setTimeout(() => {
    element.style.outline = previous;
  }, 800);
}

function inferDraftReference() {
  const candidates = [
    document.querySelector("[data-testid*='reference' i]"),
    document.querySelector("[class*='reference' i]"),
    document.querySelector("[id*='reference' i]")
  ].filter(Boolean);
  const text = candidates.map((node) => node.textContent?.trim()).find(Boolean);
  return text || new URL(window.location.href).pathname.split("/").filter(Boolean).pop() || "";
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
