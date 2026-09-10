import * as fs from "node:fs";
import * as path from "node:path";

// Allow new issues to reach Linear indexing without agent discovery.
export const EMPTY_QUEUE_GRACE_MS = 2 * 60_000;

interface Receipt { done: boolean; at: number }
type Poll = () => Promise<{ ran: boolean; note: string }>;

/** Durable trigger receipts. A response lost after acceptance can be retried
 * without paying for another run. Pending receipts survive restart and are
 * retried until a poll runs or confirms there is no eligible work after a bounded
 * indexing grace period. The persisted acceptance time survives restarts. A crash in
 * the run/receipt commit gap is safe through the poller's normal queue claims;
 * exactly-once inference across process crashes is not promised.
 */
export class TriggerReceipts {
  private running = false;
  constructor(private file: string, private poll: Poll, private now = Date.now) {}
  private read(): Record<string, Receipt> {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data) || Object.values(data).some(value => {
      const receipt = value as Receipt;
      return !receipt || typeof receipt.done !== "boolean" || !Number.isFinite(receipt.at);
    })) throw new Error("Invalid trigger receipt store");
    return data;
  }
  private write(data: Record<string, Receipt>): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    const dir = fs.openSync(path.dirname(this.file), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
  accept(key: string): boolean {
    const data = this.read();
    if (Object.hasOwn(data, key)) return false;
    for (const [id, receipt] of Object.entries(data)) {
      if (receipt.done && receipt.at < this.now() - 7 * 86_400_000) delete data[id];
    }
    // A null-prototype input is unnecessary here: endpoint restricts keys and
    // defineProperty makes even __proto__ an ordinary serialized property.
    Object.defineProperty(data, key, { value: { done: false, at: this.now() }, enumerable: true });
    this.write(data);
    return true;
  }
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pending = Object.entries(this.read()).filter(([, receipt]) => !receipt.done).map(([id]) => id);
      if (!pending.length) return;
      // A run handles at most one ticket, so it consumes only one wakeup. An
      // empty queue only acknowledges receipts past their indexing grace;
      // fresh receipts and keys arriving during this poll retry on the next drain.
      const result = await this.poll();
      if (result.ran || result.note === "precheck-skip") {
        const data = this.read();
        const now = this.now();
        const acknowledged = result.note === "precheck-skip"
          ? pending.filter(id => now - data[id].at >= EMPTY_QUEUE_GRACE_MS)
          : pending.slice(0, 1);
        if (!acknowledged.length) return;
        for (const id of acknowledged) data[id] = { done: true, at: now };
        this.write(data);
      }
    } finally { this.running = false; }
  }
}
