/** Plain-text Telegram messages use a stable sender tag and bounded chunks. */
import { config } from "./config";

const SENDER_TAG = "[dispatcher]";

export async function sendTelegram(message: string): Promise<boolean> {
  if (config.dryRun) return false;
  if (!config.tgBotToken) {
    console.warn("[notify] No TG_BOT_TOKEN, skipping notification");
    return false;
  }

  const tagged = message.startsWith(SENDER_TAG) ? message : `${SENDER_TAG} ${message}`;
  const chunks = chunkMessage(tagged, 4000);

  try {
    const url = `https://api.telegram.org/bot${config.tgBotToken}/sendMessage`;
    for (const chunk of chunks) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          chat_id: config.tgChatId,
          text: chunk,
          // No parse_mode: run summaries carry arbitrary error text, PR urls,
          // `$`/`_`/`[`/backtick chars that break Markdown entity parsing
          // (Telegram 400 "can't parse entities"). Plain text is robust.
          disable_web_page_preview: true,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[notify] TG send failed: ${res.status} ${body.slice(0, 200)}`);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error("[notify] Telegram send threw:", err);
    return false;
  }
}

function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf("\n", maxLen);
    if (cut < maxLen / 2) cut = remaining.lastIndexOf(" ", maxLen);
    if (cut < maxLen / 2) cut = maxLen;

    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
