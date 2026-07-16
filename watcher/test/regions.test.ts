import { describe, expect, it } from "vitest";
import { extractStatus, renderRegions } from "../src/regions.js";

describe("renderRegions (JOB-725 rendering)", () => {
  it("renders region:verdict, appending (reason) for fail_slow and unknown", () => {
    const bodyText = JSON.stringify({
      status: "fail",
      regions: {
        "europe-west1": { verdict: "pass" },
        "asia-south1": { verdict: "fail_slow", reason: "mass suppression" },
        "us-east1": { verdict: "unknown", reason: "no sessions in window" },
      },
    });
    expect(renderRegions({ bodyText })).toBe(
      "europe-west1:pass, asia-south1:fail_slow (mass suppression), " +
        "us-east1:unknown (no sessions in window)",
    );
  });

  it("does NOT append reason for other verdicts even when present", () => {
    const bodyText = JSON.stringify({
      regions: { "europe-west1": { verdict: "fail", reason: "ignored" } },
    });
    expect(renderRegions({ bodyText })).toBe("europe-west1:fail");
  });

  it('falls back to "(no regions)" when regions is empty or missing', () => {
    expect(renderRegions({ bodyText: JSON.stringify({ regions: {} }) })).toBe(
      "(no regions)",
    );
    expect(renderRegions({ bodyText: JSON.stringify({ status: "fail" }) })).toBe(
      "(no regions)",
    );
  });

  it('falls back to "(no body)" on empty/unparsable/wrong-shape bodies', () => {
    expect(renderRegions({ bodyText: "" })).toBe("(no body)");
    expect(renderRegions({ bodyText: "upstream error" })).toBe("(no body)");
    expect(renderRegions({ bodyText: "[1,2]" })).toBe("(no body)");
    expect(renderRegions({ bodyText: JSON.stringify({ regions: [1] }) })).toBe(
      "(no body)",
    );
  });
});

describe("extractStatus", () => {
  it("reads body.status", () => {
    expect(extractStatus({ bodyText: '{"status":"degraded"}' })).toBe("degraded");
  });

  it('returns "unreachable" for missing status / unparsable body', () => {
    expect(extractStatus({ bodyText: "{}" })).toBe("unreachable");
    expect(extractStatus({ bodyText: "" })).toBe("unreachable");
    expect(extractStatus({ bodyText: "not json" })).toBe("unreachable");
    expect(extractStatus({ bodyText: "[]" })).toBe("unreachable");
  });
});
