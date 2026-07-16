import { describe, expect, it, vi } from "vitest";
import { readConfig, type WatchConfig } from "../src/config.js";
import type { PostFetchLike } from "../src/telegram.js";
import {
  buildNotifyOwner,
  parseEnvFile,
  resolveTelegramCreds,
} from "../src/telegram.js";

/** The exact class of message that killed the real page (JOB-731): Markdown
 *  entities that never close — underscores, brackets, parens. */
const BROKEN_MESSAGE =
  "URGENT P0 [output-watch]: /health/output = fail (HTTP 200). " +
  "Regions: asia-south1:fail_slow (input alive (audio_in 5) but 0 hints generated, _[broken (offset";

const makeConfig = (): WatchConfig =>
  readConfig({
    env: {
      WATCH_NOTIFY_SCRIPT: "/tmp/notify.sh",
      WATCH_TG_ENV_FILE: "/tmp/workspace.env",
    },
  });

const okFetch = (): { fetchImpl: PostFetchLike; calls: { url: string; body: string }[] } => {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl: PostFetchLike = vi.fn(async (url, init) => {
    calls.push({ url, body: init.body });
    return { ok: true, status: 200 };
  });
  return { fetchImpl, calls };
};

describe("parseEnvFile", () => {
  it("parses unquoted, double-quoted and single-quoted values", () => {
    const vars = parseEnvFile({
      content: [
        "TG_BOT_TOKEN=123456:plain-token",
        'TG_CHAT_ID="42424242"',
        "OTHER='single quoted'",
        "",
        "# comment line",
        "export EXPORTED=yes",
        "SPACED = padded value ",
      ].join("\n"),
    });
    expect(vars).toEqual({
      TG_BOT_TOKEN: "123456:plain-token",
      TG_CHAT_ID: "42424242",
      OTHER: "single quoted",
      EXPORTED: "yes",
      SPACED: "padded value",
    });
  });

  it("ignores malformed lines without =", () => {
    expect(parseEnvFile({ content: "not-a-var\n=nokey\n" })).toEqual({});
  });
});

describe("resolveTelegramCreds", () => {
  it("prefers process env and never reads the file when both are set", async () => {
    const readEnvFile = vi.fn(async () => "TG_BOT_TOKEN=file\nTG_CHAT_ID=file\n");
    const creds = await resolveTelegramCreds({
      env: { TG_BOT_TOKEN: "env-token", TG_CHAT_ID: "env-chat" },
      tgEnvFile: "/tmp/workspace.env",
      readEnvFile,
    });
    expect(creds).toEqual({ token: "env-token", chatId: "env-chat" });
    expect(readEnvFile).not.toHaveBeenCalled();
  });

  it("falls back to the env file (quoted values) when env vars are unset", async () => {
    const readEnvFile = vi.fn(
      async () => 'TG_BOT_TOKEN="123:abc"\nTG_CHAT_ID=\'999\'\n',
    );
    const creds = await resolveTelegramCreds({
      env: {},
      tgEnvFile: "/tmp/workspace.env",
      readEnvFile,
    });
    expect(readEnvFile).toHaveBeenCalledWith({ path: "/tmp/workspace.env" });
    expect(creds).toEqual({ token: "123:abc", chatId: "999" });
  });

  it("returns null when neither env nor file yields both values", async () => {
    const creds = await resolveTelegramCreds({
      env: { TG_BOT_TOKEN: "token-only" },
      tgEnvFile: "/tmp/workspace.env",
      readEnvFile: vi.fn(async () => null),
    });
    expect(creds).toBeNull();
  });
});

describe("buildNotifyOwner — direct plain-text send (JOB-731)", () => {
  it("delivers a Markdown-breaking message directly with NO parse_mode", async () => {
    const { fetchImpl, calls } = okFetch();
    const runNotifyScript = vi.fn(async () => {});
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "42" },
      fetchImpl,
      runNotifyScript,
    });

    await notifyOwner({ message: BROKEN_MESSAGE });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
    const body: unknown = JSON.parse(calls[0]?.body ?? "");
    // Plain text: the exact message, and no parse_mode field AT ALL.
    expect(body).toEqual({ chat_id: "42", text: BROKEN_MESSAGE });
    expect(Object.keys(body as Record<string, unknown>)).not.toContain("parse_mode");
    // Fallback untouched on the happy path.
    expect(runNotifyScript).not.toHaveBeenCalled();
  });

  it("resolves creds from the env file when process env is empty", async () => {
    const { fetchImpl, calls } = okFetch();
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: {},
      fetchImpl,
      readEnvFile: vi.fn(async () => 'TG_BOT_TOKEN="777:file"\nTG_CHAT_ID=888\n'),
      runNotifyScript: vi.fn(async () => {}),
    });

    await notifyOwner({ message: "page" });
    expect(calls[0]?.url).toBe("https://api.telegram.org/bot777:file/sendMessage");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ chat_id: "888", text: "page" });
  });

  it("falls back to notify.sh when the direct send returns 400", async () => {
    const fetchImpl: PostFetchLike = vi.fn(async () => ({ ok: false, status: 400 }));
    const runNotifyScript = vi.fn(async () => {});
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "42" },
      fetchImpl,
      runNotifyScript,
    });

    await notifyOwner({ message: BROKEN_MESSAGE });
    expect(runNotifyScript).toHaveBeenCalledWith({
      script: "/tmp/notify.sh",
      message: BROKEN_MESSAGE,
    });
  });

  it("falls back to notify.sh on a fetch/network error too", async () => {
    const fetchImpl: PostFetchLike = vi.fn(async () => {
      throw new Error("ENOTFOUND api.telegram.org");
    });
    const runNotifyScript = vi.fn(async () => {});
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "42" },
      fetchImpl,
      runNotifyScript,
    });

    await notifyOwner({ message: "page" });
    expect(runNotifyScript).toHaveBeenCalledWith({
      script: "/tmp/notify.sh",
      message: "page",
    });
  });

  it("logs one PAGE_FAILED line and does NOT throw when both paths fail", async () => {
    const lines: string[] = [];
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: { TG_BOT_TOKEN: "123:abc", TG_CHAT_ID: "42" },
      fetchImpl: vi.fn(async () => ({ ok: false, status: 400 })),
      runNotifyScript: vi.fn(async () => {
        throw new Error("notify.sh exit 1");
      }),
      log: ({ line }) => {
        lines.push(line);
      },
    });

    await expect(notifyOwner({ message: BROKEN_MESSAGE })).resolves.toBeUndefined();

    const failed = lines.filter((l) => l.startsWith("PAGE_FAILED "));
    expect(failed).toHaveLength(1);
    const payload: unknown = JSON.parse(
      (failed[0] ?? "").replace("PAGE_FAILED ", ""),
    );
    expect(payload).toMatchObject({
      direct: "Error: telegram sendMessage HTTP 400",
      fallback: "Error: notify.sh exit 1",
      message: BROKEN_MESSAGE,
    });
    expect(typeof (payload as { reason: unknown }).reason).toBe("string");
  });

  it("unresolvable creds count as a direct failure and use the fallback", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const runNotifyScript = vi.fn(async () => {});
    const notifyOwner = buildNotifyOwner({
      config: makeConfig(),
      env: {},
      fetchImpl,
      readEnvFile: vi.fn(async () => null),
      runNotifyScript,
    });

    await notifyOwner({ message: "page" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(runNotifyScript).toHaveBeenCalledWith({
      script: "/tmp/notify.sh",
      message: "page",
    });
  });
});

describe("readConfig — tgEnvFile (JOB-731)", () => {
  it("defaults to the workspace .env and honors WATCH_TG_ENV_FILE", () => {
    expect(readConfig({ env: {} }).tgEnvFile).toBe("/home/joblander/workspace/.env");
    expect(
      readConfig({ env: { WATCH_TG_ENV_FILE: "/custom/.env" } }).tgEnvFile,
    ).toBe("/custom/.env");
  });
});
