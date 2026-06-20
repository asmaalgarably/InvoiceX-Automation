import { describe, expect, it } from "vitest";
import { parseUipOutput } from "./uipathCli";

describe("parseUipOutput", () => {
  it("unwraps successful UiPath JSON envelopes", () => {
    const result = parseUipOutput(
      ["uip", "or", "folders", "list"],
      JSON.stringify({
        Result: "Success",
        Code: "FolderList",
        Data: [{ Path: "Finance/InvoiceIntake" }]
      })
    );

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual([{ Path: "Finance/InvoiceIntake" }]);
  });

  it("returns failure messages from failed UiPath envelopes", () => {
    const result = parseUipOutput(
      ["uip", "ixp", "projects", "list"],
      JSON.stringify({
        Result: "Failure",
        Message: "Failed to list IXP projects",
        Instructions: "Service: reinfer not found"
      })
    );

    expect(result.error).toContain("Failed to list IXP projects");
    expect(result.error).toContain("Service: reinfer not found");
  });

  it("treats successful envelopes with failed payloads as errors", () => {
    const result = parseUipOutput(
      ["uip", "rpa", "init"],
      JSON.stringify({
        Result: "Success",
        Code: "ToolResult",
        Data: {
          success: false,
          errorMessage: "No Studio licence is available for the current user."
        }
      })
    );

    expect(result.error).toBe("No Studio licence is available for the current user.");
  });
});
