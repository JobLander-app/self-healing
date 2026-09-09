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
  const count = Number.parseInt(countRaw ?? "", 10);
  if (!Number.isSafeInteger(count) || count < 0 || !["0", "1"].includes(pagedRaw ?? "")) {
    throw new Error("Corrupt watcher state; refusing to erase delivery history");
  }
  let outbox: WatchState["outbox"];
  if (rest.length > 0) {
    const extra = JSON.parse(rest.join("\n"));
    if (extra.version !== 2 || !Array.isArray(extra.outbox) || extra.outbox.some((i: Record<string, unknown>) =>
      !i || typeof i.id !== "string" || typeof i.status !== "string" || typeof i.httpCode !== "string" ||
      typeof i.regions !== "string" || typeof i.recovered !== "boolean" || !i.delivered || !i.attempts || !i.retryAt)) {
      throw new Error("Invalid watcher outbox; refusing to erase delivery history");
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
