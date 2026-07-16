import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadStateFile,
  parseState,
  saveStateFile,
  serializeState,
} from "../src/state.js";

describe('state file ("COUNT PAGED" — bash-compatible)', () => {
  it("parses bash-written content", () => {
    expect(parseState({ content: "2 1\n" })).toEqual({ count: 2, paged: true });
    expect(parseState({ content: "0 0\n" })).toEqual({ count: 0, paged: false });
    expect(parseState({ content: "5 0" })).toEqual({ count: 5, paged: false });
  });

  it("defaults to 0/unpaged for missing, empty, or garbage files", () => {
    expect(parseState({ content: null })).toEqual({ count: 0, paged: false });
    expect(parseState({ content: "" })).toEqual({ count: 0, paged: false });
    expect(parseState({ content: "garbage" })).toEqual({ count: 0, paged: false });
  });

  it("serializes in the exact bash format (echo adds trailing newline)", () => {
    expect(serializeState({ state: { count: 3, paged: true } })).toBe("3 1\n");
    expect(serializeState({ state: { count: 0, paged: false } })).toBe("0 0\n");
  });

  it("round-trips through a real file and interops with bash mid-incident", async () => {
    const dir = await mkdtemp(join(tmpdir(), "output-watch-"));
    const path = join(dir, "state");

    // TS write -> TS read
    await saveStateFile({ path, state: { count: 2, paged: false } });
    expect(await loadStateFile({ path })).toEqual({ count: 2, paged: false });
    // Exact on-disk bytes bash `read` expects
    expect(await readFile(path, "utf8")).toBe("2 0\n");

    // bash write (echo "4 1" > state) -> TS read
    await writeFile(path, "4 1\n", "utf8");
    expect(await loadStateFile({ path })).toEqual({ count: 4, paged: true });

    // Missing file -> defaults
    expect(await loadStateFile({ path: join(dir, "missing") })).toEqual({
      count: 0,
      paged: false,
    });
  });
});
