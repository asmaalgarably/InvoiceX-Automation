import { describe, expect, it } from "vitest";
import type { IntakeJob, ValidationResult } from "../shared/invoice";
import { erpNextReviewPostAction, mergeDestinationStates, statusAfterDestinationPosting } from "./destinations";

const validValidation: ValidationResult = {
  canSubmitToRobot: true,
  blocking: [],
  warnings: [],
  totals: {
    lineSubtotal: 100,
    lineVat: 15,
    lineGrandTotal: 115,
    headerGrandTotal: 115,
    headerVatTotal: 15
  }
};

function jobFixture(patch: Partial<IntakeJob> = {}): IntakeJob {
  return {
    jobId: "job-1",
    status: "reviewed",
    createdAt: "2026-06-26T00:00:00.000Z",
    updatedAt: "2026-06-26T00:00:00.000Z",
    draft: {
      supplierName: "Demo Supplier",
      supplierTaxId: "300000000000003",
      invoiceNumber: "INV-1",
      issueDate: "2026-06-26",
      dueDate: "",
      currency: "SAR",
      subtotal: 100,
      discount: 0,
      vatTotal: 15,
      grandTotal: 115,
      attachmentRefs: [],
      lineItems: []
    },
    validation: validValidation,
    destinations: [{ platform: "erpnext", status: "ready", updatedAt: "2026-06-26T00:00:00.000Z" }],
    events: [],
    ...patch
  };
}

describe("destination review posting decisions", () => {
  it("posts ERPNext after valid review when selected and no draft exists", () => {
    expect(erpNextReviewPostAction(jobFixture(), ["erpnext"])).toBe("post");
  });

  it("skips ERPNext posting when review is blocked", () => {
    const job = jobFixture({
      validation: { ...validValidation, canSubmitToRobot: false, blocking: ["Line 1: mapping is required."] }
    });

    expect(erpNextReviewPostAction(job, ["erpnext"])).toBe("skip_invalid");
  });

  it("skips ERPNext repost when a draft already exists", () => {
    const job = jobFixture({
      destinations: [{
        platform: "erpnext",
        status: "draft_created",
        externalReference: "PINV-0001",
        updatedAt: "2026-06-26T00:00:00.000Z"
      }]
    });

    expect(erpNextReviewPostAction(job, ["erpnext"])).toBe("skip_created");
  });

  it("preserves existing draft-created destination state when review is saved again", () => {
    const merged = mergeDestinationStates([
      {
        platform: "erpnext",
        status: "draft_created",
        externalReference: "PINV-0001",
        updatedAt: "2026-06-26T00:00:00.000Z"
      }
    ], [
      {
        platform: "erpnext",
        status: "ready",
        updatedAt: "2026-06-26T00:01:00.000Z"
      }
    ]);

    expect(merged[0]).toMatchObject({
      platform: "erpnext",
      status: "draft_created",
      externalReference: "PINV-0001"
    });
  });

  it("preserves Qoyod readiness after ERPNext draft creation when both destinations are selected", () => {
    const job = jobFixture({
      status: "ready_for_qoyod",
      destinations: [
        { platform: "qoyod", status: "ready", updatedAt: "2026-06-26T00:00:00.000Z" },
        { platform: "erpnext", status: "draft_created", updatedAt: "2026-06-26T00:00:00.000Z" }
      ]
    });

    expect(statusAfterDestinationPosting(job, "erpnext", "success")).toBe("ready_for_qoyod");
  });
});
