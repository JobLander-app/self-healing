/**
 * JOB-731: direct plain-text Telegram pager.
 *
 * Incident (2026-07): the bash watcher paged through workspace notify.sh,
 * which always sends parse_mode=Markdown with no escaping. An enriched
 * regions string ("asia-south1:fail_slow (input alive (audio_in 5) ...)")
 * broke Telegram entity parsing (HTTP 400) and the P0 page was LOST.
 *
 * Fix: the watcher sends to api.telegram.org DIRECTLY with NO parse_mode
 * (a pager needs delivery, not formatting). notify.sh remains only as a
 * fallback; if both paths fail we log one structured PAGE_FAILED line and
 * never throw — the tick must continue.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { WatchConfig } from "./config.js";

const execFileAsync = promisify(execFile);

export interface TelegramCreds {
  token: string;
  chatId: string;
}

/** Minimal POST-shaped fetch so tests can assert the exact request body. */
export type PostFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number }>;

/**
 * Parse simple KEY=VALUE lines (the workspace .env format). Values may be
 * single- or double-quoted; blank lines, comments and `export ` prefixes
 * are tolerated. No interpolation, no multi-line values.
 */
export const parseEnvFile = ({
  content,
}: {
  content: string;
}): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (key.length === 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
};

export type EnvFileReader = (input: { path: string }) => Promise<string | null>;

export const fsEnvFileReader: EnvFileReader = async ({ path }) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Resolve bot token + chat id: process env TG_BOT_TOKEN / TG_CHAT_ID first,
 * then the env file at config.tgEnvFile (the same .env notify.sh sources).
 * Returns null when either value is missing everywhere.
 */
export const resolveTelegramCreds = async ({
  env,
  tgEnvFile,
  readEnvFile,
}: {
  env: NodeJS.ProcessEnv;
  tgEnvFile: string;
  readEnvFile: EnvFileReader;
}): Promise<TelegramCreds | null> => {
  let token = env.TG_BOT_TOKEN ?? "";
  let chatId = env.TG_CHAT_ID ?? "";
  if (token.length === 0 || chatId.length === 0) {
    const content = await readEnvFile({ path: tgEnvFile });
    const fileVars = content === null ? {} : parseEnvFile({ content });
    if (token.length === 0) token = fileVars["TG_BOT_TOKEN"] ?? "";
    if (chatId.length === 0) chatId = fileVars["TG_CHAT_ID"] ?? "";
  }
  if (token.length === 0 || chatId.length === 0) return null;
  return { token, chatId };
};

/**
 * POST sendMessage with chat_id + text and deliberately NO parse_mode:
 * plain text cannot fail Telegram entity parsing, so the page always lands.
 */
export const sendTelegramDirect = async ({
  creds,
  message,
  fetchImpl,
}: {
  creds: TelegramCreds;
  message: string;
  fetchImpl?: PostFetchLike;
}): Promise<void> => {
  const doFetch: PostFetchLike = fetchImpl ?? fetch;
  const response = await doFetch(
    `https://api.telegram.org/bot${creds.token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: creds.chatId, text: message }),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    throw new Error(`telegram sendMessage HTTP ${response.status}`);
  }
};

export type NotifyScriptRunner = (input: {
  script: string;
  message: string;
}) => Promise<void>;

const bashNotifyScriptRunner: NotifyScriptRunner = async ({ script, message }) => {
  await execFileAsync("bash", [script, message]);
};

/**
 * The notifyOwner effect (JOB-731 pager path):
 *   1. direct plain-text Telegram send (primary),
 *   2. legacy notify.sh (fallback — still Markdown, but better than nothing
 *      for messages that happen to parse),
 *   3. both failed → one structured `PAGE_FAILED {json}` stdout line, no
 *      throw: the tick (state save / Linear / trigger) must continue.
 */
export const buildNotifyOwner = ({
  config,
  env,
  fetchImpl,
  readEnvFile = fsEnvFileReader,
  runNotifyScript = bashNotifyScriptRunner,
  log = ({ line }) => {
    console.log(line);
  },
}: {
  config: WatchConfig;
  env: NodeJS.ProcessEnv;
  fetchImpl?: PostFetchLike;
  readEnvFile?: EnvFileReader;
  runNotifyScript?: NotifyScriptRunner;
  log?: (input: { line: string }) => void;
}): ((input: { message: string }) => Promise<void>) => {
  return async ({ message }) => {
    let directReason: string;
    try {
      const creds = await resolveTelegramCreds({
        env,
        tgEnvFile: config.tgEnvFile,
        readEnvFile,
      });
      if (creds === null) {
        throw new Error(
          `TG_BOT_TOKEN/TG_CHAT_ID unresolved (env + ${config.tgEnvFile})`,
        );
      }
      await sendTelegramDirect({ creds, message, fetchImpl });
      return;
    } catch (error) {
      directReason = String(error);
    }
    try {
      await runNotifyScript({ script: config.notifyScript, message });
      return;
    } catch (fallbackError) {
      log({
        line: `PAGE_FAILED ${JSON.stringify({
          reason: "direct telegram send and notify.sh fallback both failed",
          direct: directReason,
          fallback: String(fallbackError),
          message,
        })}`,
      });
    }
  };
};
