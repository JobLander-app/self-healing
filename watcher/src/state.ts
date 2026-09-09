import { open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { WatchState } from "./types.js";

/**
 * Legacy COUNT PAGED header remains readable by older releases; v2 appends
 * the durable outbox. Old readers do not maintain that second line.
 */
export const parseState = ({ content }: { content: string | null }): WatchState => {
  if (content === null) return { count: 0, paged: false };
  const [legacy, ...rest] = content.trim().split("\n");
  const [countRaw, pagedRaw] = (legacy ?? "").trim().split(/\s+/);
  const count = Number(countRaw);
  if (!/^\d+$/.test(countRaw ?? "") || !Number.isSafeInteger(count) || count < 0 || !["0", "1"].includes(pagedRaw ?? "")) {
    throw new Error("Corrupt watcher state; refusing to erase delivery history");
  }
  let outbox: WatchState["outbox"];
  if (rest.length > 0) {
    const extra = JSON.parse(rest.join("\n"));
    const actions = new Set(["page", "ticket", "announcement", "trigger", "recovery"]);
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value);
    const fields = (value: unknown, valid: (v: unknown) => boolean) =>
      record(value) && Object.entries(value).every(([key, v]) => actions.has(key) && valid(v));
    const counter = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (!record(extra) || extra.version !== 2 || !Array.isArray(extra.outbox) || extra.outbox.some((i: unknown) =>
      !record(i) || typeof i.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(i.id) ||
      typeof i.status !== "string" || typeof i.httpCode !== "string" || typeof i.regions !== "string" ||
      typeof i.recovered !== "boolean" || (i.ticketIdentifier !== undefined && typeof i.ticketIdentifier !== "string") ||
      !fields(i.delivered, v => typeof v === "boolean") || !fields(i.attempts, counter) || !fields(i.retryAt, counter))) {
      throw new Error("Invalid watcher outbox; refusing to erase delivery history");
    }
    if (new Set(extra.outbox.map(i => i.id)).size !== extra.outbox.length) {
      throw new Error("Duplicate watcher incident IDs");
    }
    outbox = extra.outbox;
  }
  return {
    count,
    paged: pagedRaw === "1",
    ...(outbox ? { outbox } : {}),
  };
};

export const serializeState = ({ state }: { state: WatchState }): string =>
  `${state.count} ${state.paged ? 1 : 0}\n` +
  (state.outbox ? JSON.stringify({ version: 2, outbox: state.outbox }) + "\n" : "");

export const loadStateFile = async ({ path }: { path: string }): Promise<WatchState> => {
  try {
    const content = await readFile(path, "utf8");
    return parseState({ content });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseState({ content: null });
    throw error;
  }
};

export const saveStateFile = async ({
  path,
  state,
}: {
  path: string;
  state: WatchState;
}): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    const handle = await open(tmp, "w", 0o600);
    try { await handle.writeFile(serializeState({ state }), "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(tmp, path);
    const directory = await open(dirname(path), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await unlink(tmp).catch(() => {});
  }
};
