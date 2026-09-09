import * as fs from "node:fs";
import * as path from "node:path";
import { config } from "./config";

export const ledgerPath = path.join(path.dirname(config.logDir), "usage-ledger.jsonl");
let error: string | null = null;
let rejectedRecords = 0;
export function accountingFailed(message: string): void { error = message; console.error(`[accounting] ${message}`); }
export function resetAccountingState(): void { error = null; rejectedRecords = 0; }
export function accountForRejectedRecords(count: number): void { rejectedRecords = count; }
export function accountingStatus() {
  let bytes = 0;
  try {
    const stat = fs.statSync(ledgerPath);
    bytes = stat.size;
    if (!stat.isFile()) error = "Ledger path is not a regular file";
    if (bytes >= config.ledgerMaxBytes) error = "Ledger size cap reached; preserve ledger and increase capacity before resuming";
  } catch (err: any) { if (err.code !== "ENOENT") error = `Ledger stat failed: ${err.code ?? "unknown"}`; }
  return { healthy: error === null, error, bytes, rejectedRecords,
    warning: bytes >= config.ledgerMaxBytes / 2 || rejectedRecords > 0, maxBytes: config.ledgerMaxBytes };
}
