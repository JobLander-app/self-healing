import type { WatchConfig } from "./config.js";
import { SECRETS } from "./config.js";
import type { SecretReader } from "./effects.js";
import { buildAuthHeader } from "./hmac.js";
import { extractStatus } from "./regions.js";
import type { Sample } from "./types.js";

export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

/**
 * Poll /health/output with HMAC auth (same scheme and 90s budget as bash).
 * Any transport failure maps to the bash "unreachable" sample: status
 * "unreachable", httpCode "" (which is_bad, since "" !== "200").
 */
export const fetchSample = async ({
  config,
  secretReader,
  fetchImpl,
  now,
}: {
  config: WatchConfig;
  secretReader: SecretReader;
  fetchImpl?: FetchLike;
  now?: () => number;
}): Promise<Sample> => {
  try {
    // Empty key mirrors bash: sign anyway, let the server reject with non-200.
    const key =
      (await secretReader({ secret: SECRETS.hmacKey, project: config.project })) ?? "";
    const ts = String(Math.floor((now ?? Date.now)() / 1000));
    const doFetch: FetchLike = fetchImpl ?? fetch;
    const response = await doFetch(`${config.url}/health/output?window_min=30`, {
      headers: { Authorization: buildAuthHeader({ ts, key }) },
      signal: AbortSignal.timeout(90_000),
    });
    const bodyText = await response.text();
    return {
      status: extractStatus({ bodyText }),
      httpCode: String(response.status),
      bodyText,
    };
  } catch {
    return { status: "unreachable", httpCode: "", bodyText: "" };
  }
};

/**
 * FORCE_BAD=1 test hook (never set in cron): forces the incident branch by
 * overriding status/code, but keeps the real body — exactly like bash, where
 * REGIONS is still rendered from the actual response.
 */
export const applyForceBad = ({
  sample,
  forceBad,
}: {
  sample: Sample;
  forceBad: boolean;
}): Sample =>
  forceBad ? { ...sample, status: "degraded", httpCode: "503" } : sample;
