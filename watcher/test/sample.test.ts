import { describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { signRequest } from "../src/hmac.js";
import type { FetchLike } from "../src/sample.js";
import { applyForceBad, fetchSample } from "../src/sample.js";

const config = readConfig({
  env: { WATCH_URL: "https://example.a.run.app" } as NodeJS.ProcessEnv,
});

describe("fetchSample", () => {
  it("requests /health/output?window_min=30 with the bash HMAC header", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const fetchImpl: FetchLike = async (url, init) => {
      capturedUrl = url;
      capturedAuth = init.headers.Authorization ?? "";
      return {
        status: 200,
        text: async () => JSON.stringify({ status: "pass", regions: {} }),
      };
    };

    const sample = await fetchSample({
      config,
      secretReader: vi.fn(async () => "testkey"),
      fetchImpl,
      now: () => 1234567890_000,
    });

    expect(capturedUrl).toBe("https://example.a.run.app/health/output?window_min=30");
    expect(capturedAuth).toBe(
      `HMAC 1234567890:${signRequest({ ts: "1234567890", key: "testkey" })}`,
    );
    expect(sample).toEqual({
      status: "pass",
      httpCode: "200",
      bodyText: '{"status":"pass","regions":{}}',
    });
  });

  it("maps transport failure to the bash unreachable sample (bad by code)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ETIMEDOUT");
    };
    const sample = await fetchSample({
      config,
      secretReader: vi.fn(async () => "testkey"),
      fetchImpl,
    });
    expect(sample).toEqual({ status: "unreachable", httpCode: "", bodyText: "" });
  });

  it("signs with an empty key when the secret is unavailable (server rejects)", async () => {
    let capturedAuth = "";
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedAuth = init.headers.Authorization ?? "";
      return { status: 401, text: async () => "unauthorized" };
    };
    const sample = await fetchSample({
      config,
      secretReader: vi.fn(async () => null),
      fetchImpl,
      now: () => 1234567890_000,
    });
    expect(capturedAuth).toBe(
      `HMAC 1234567890:${signRequest({ ts: "1234567890", key: "" })}`,
    );
    expect(sample.httpCode).toBe("401");
    expect(sample.status).toBe("unreachable");
  });
});

describe("FORCE_BAD hook", () => {
  it("forces degraded/503 but keeps the real body for regions rendering", () => {
    const real = {
      status: "pass",
      httpCode: "200",
      bodyText: '{"status":"pass","regions":{"europe-west1":{"verdict":"pass"}}}',
    };
    expect(applyForceBad({ sample: real, forceBad: true })).toEqual({
      status: "degraded",
      httpCode: "503",
      bodyText: real.bodyText,
    });
    expect(applyForceBad({ sample: real, forceBad: false })).toEqual(real);
  });
});

describe("readConfig defaults (parity with output-watch.sh)", () => {
  it("uses the bash defaults when env is empty", () => {
    const defaults = readConfig({ env: {} as NodeJS.ProcessEnv });
    expect(defaults.url).toBe("https://joblander-audio-engine-p26anqucmq-ew.a.run.app");
    expect(defaults.project).toBe("meet-assistant-6d8ad");
    expect(defaults.threshold).toBe(3);
    expect(defaults.stateFile).toBe("/home/joblander/.output-watch-state");
    expect(defaults.dryRun).toBe(false);
    expect(defaults.forceBad).toBe(false);
    expect(defaults.dispatchToken).toBeNull();
  });

  it("honours WATCH_THRESHOLD / DRY_RUN / FORCE_BAD / DISPATCH_TOKEN", () => {
    const custom = readConfig({
      env: {
        WATCH_THRESHOLD: "5",
        DRY_RUN: "1",
        FORCE_BAD: "1",
        DISPATCH_TOKEN: "tok",
      } as NodeJS.ProcessEnv,
    });
    expect(custom.threshold).toBe(5);
    expect(custom.dryRun).toBe(true);
    expect(custom.forceBad).toBe(true);
    expect(custom.dispatchToken).toBe("tok");
  });

  it("falls back to threshold 3 on garbage WATCH_THRESHOLD", () => {
    expect(
      readConfig({ env: { WATCH_THRESHOLD: "abc" } as NodeJS.ProcessEnv }).threshold,
    ).toBe(3);
  });
});
