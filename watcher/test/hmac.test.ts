import { describe, expect, it } from "vitest";
import { buildAuthHeader, signRequest } from "../src/hmac.js";

describe("HMAC signing (same scheme as bash/openssl)", () => {
  it("matches the openssl reference digest", () => {
    // printf 'GET\n/health/output\n1234567890' | openssl dgst -sha256 -hmac "testkey"
    expect(signRequest({ ts: "1234567890", key: "testkey" })).toBe(
      "c319472942b828ad2bb6e2cf52a392b696ed8ac8cdba053bfd0f15ea5e981e9c",
    );
  });

  it("builds the Authorization header as `HMAC {ts}:{sig}`", () => {
    expect(buildAuthHeader({ ts: "1234567890", key: "testkey" })).toBe(
      "HMAC 1234567890:c319472942b828ad2bb6e2cf52a392b696ed8ac8cdba053bfd0f15ea5e981e9c",
    );
  });
});
