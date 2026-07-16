import { createHmac } from "node:crypto";

/**
 * Same signing scheme as the bash watcher:
 *   payload = "GET\n/health/output\n{ts}", SHA-256 HMAC, hex digest,
 *   sent as header `Authorization: HMAC {ts}:{sig}`.
 */
export const signRequest = ({ ts, key }: { ts: string; key: string }): string =>
  createHmac("sha256", key).update(`GET\n/health/output\n${ts}`).digest("hex");

export const buildAuthHeader = ({ ts, key }: { ts: string; key: string }): string =>
  `HMAC ${ts}:${signRequest({ ts, key })}`;
