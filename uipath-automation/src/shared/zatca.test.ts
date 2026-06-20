import { describe, expect, it } from "vitest";
import { decodeZatcaTlv, encodeZatcaTlvForTest } from "./zatca";

describe("decodeZatcaTlv", () => {
  it("decodes Saudi FATOORA tags 1 through 5", () => {
    const payload = encodeZatcaTlvForTest({
      1: "شركة الاختبار",
      2: "300000000000003",
      3: "2026-06-17T10:00:00Z",
      4: "115.00",
      5: "15.00"
    });

    const decoded = decodeZatcaTlv(payload);

    expect(decoded?.sellerName).toBe("شركة الاختبار");
    expect(decoded?.vatRegistrationNumber).toBe("300000000000003");
    expect(decoded?.timestamp).toBe("2026-06-17T10:00:00Z");
    expect(decoded?.totalWithVat).toBe(115);
    expect(decoded?.vatTotal).toBe(15);
  });

  it("returns null for invalid base64 or malformed TLV data", () => {
    expect(decodeZatcaTlv("not a qr")).toBeNull();
    expect(decodeZatcaTlv(Buffer.from([1, 20, 65]).toString("base64"))).toBeNull();
  });
});
