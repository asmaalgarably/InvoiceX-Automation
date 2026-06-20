import type { ZatcaQr } from "./invoice";

const zatcaTagNames: Record<number, keyof Omit<ZatcaQr, "rawPayload" | "rawTags">> = {
  1: "sellerName",
  2: "vatRegistrationNumber",
  3: "timestamp",
  4: "totalWithVat",
  5: "vatTotal"
};

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  const maybeBuffer = (globalThis as { Buffer?: typeof Buffer }).Buffer;
  if (maybeBuffer) {
    return new Uint8Array(maybeBuffer.from(value, "base64"));
  }

  throw new Error("No base64 decoder is available in this runtime.");
}

function normalizeQrPayload(input: string): string {
  const trimmed = input.trim();
  const dataUrlIndex = trimmed.indexOf("base64,");
  return dataUrlIndex >= 0 ? trimmed.slice(dataUrlIndex + "base64,".length) : trimmed;
}

function readUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function toMoney(value: string): number | undefined {
  const normalized = value.replace(/[^\d.-]/g, "");
  if (!normalized) {
    return undefined;
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function decodeZatcaTlv(input: string): ZatcaQr | null {
  const payload = normalizeQrPayload(input);
  if (!payload) {
    return null;
  }

  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(payload);
  } catch {
    return null;
  }

  const rawTags: Record<string, string> = {};
  const result: Partial<ZatcaQr> = {
    rawPayload: payload,
    rawTags
  };

  let cursor = 0;
  while (cursor + 2 <= bytes.length) {
    const tag = bytes[cursor];
    const length = bytes[cursor + 1];
    cursor += 2;

    if (length < 0 || cursor + length > bytes.length) {
      return null;
    }

    const value = readUtf8(bytes.slice(cursor, cursor + length));
    cursor += length;
    rawTags[String(tag)] = value;

    const fieldName = zatcaTagNames[tag];
    if (fieldName === "totalWithVat" || fieldName === "vatTotal") {
      const money = toMoney(value);
      if (money !== undefined) {
        result[fieldName] = money;
      }
    } else if (fieldName) {
      result[fieldName] = value;
    }
  }

  if (!Object.keys(rawTags).length || cursor !== bytes.length) {
    return null;
  }

  return result as ZatcaQr;
}

export function encodeZatcaTlvForTest(tags: Record<number, string>): string {
  const encoder = new TextEncoder();
  const chunks: number[] = [];

  for (const [tagText, value] of Object.entries(tags)) {
    const tag = Number(tagText);
    const encoded = Array.from(encoder.encode(value));
    if (encoded.length > 255) {
      throw new Error("Test TLV values must fit in one byte.");
    }
    chunks.push(tag, encoded.length, ...encoded);
  }

  return Buffer.from(chunks).toString("base64");
}
