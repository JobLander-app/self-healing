import { readFile, writeFile } from "node:fs/promises";
import type { WatchState } from "./types.js";

/**
 * State file format is UNCHANGED from bash ("COUNT PAGED" text line) so the
 * bash and TS watchers are interchangeable mid-incident.
 */
export const parseState = ({ content }: { content: string | null }): WatchState => {
  if (content === null) return { count: 0, paged: false };
  const [countRaw, pagedRaw] = content.trim().split(/\s+/);
  const count = Number.parseInt(countRaw ?? "", 10);
  return {
    count: Number.isFinite(count) ? count : 0,
    paged: pagedRaw === "1",
  };
};

export const serializeState = ({ state }: { state: WatchState }): string =>
  `${state.count} ${state.paged ? 1 : 0}\n`;

export const loadStateFile = async ({ path }: { path: string }): Promise<WatchState> => {
  try {
    const content = await readFile(path, "utf8");
    return parseState({ content });
  } catch {
    return parseState({ content: null });
  }
};

export const saveStateFile = async ({
  path,
  state,
}: {
  path: string;
  state: WatchState;
}): Promise<void> => {
  await writeFile(path, serializeState({ state }), "utf8");
};
