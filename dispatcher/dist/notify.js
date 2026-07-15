"use strict";
/**
 * Outbound Telegram via the Bot API directly (no MCP hop).
 *
 * Adapted from handy-daemon/src/notify.ts. Two things matter:
 *
 *   1. Unforgeable sender identity prefix `[dispatcher]` on every message —
 *      the Owner shares one TG inbox with Beacon, Symphony, Handy, Monitor,
 *      etc., and the 2026-04 Ghost Orchestrator incident happened precisely
 *      because multiple agents wrote with no visible identity. Do not remove.
 *   2. 4096-char Telegram limit — chunk at paragraph boundaries.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTelegram = sendTelegram;
const config_1 = require("./config");
const SENDER_TAG = "[dispatcher]";
async function sendTelegram(message) {
    if (!config_1.config.tgBotToken) {
        console.warn("[notify] No TG_BOT_TOKEN, skipping notification");
        return false;
    }
    const tagged = message.startsWith(SENDER_TAG) ? message : `${SENDER_TAG} ${message}`;
    const chunks = chunkMessage(tagged, 4000);
    try {
        const url = `https://api.telegram.org/bot${config_1.config.tgBotToken}/sendMessage`;
        for (const chunk of chunks) {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    chat_id: config_1.config.tgChatId,
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
    }
    catch (err) {
        console.error("[notify] Telegram send threw:", err);
        return false;
    }
}
function chunkMessage(text, maxLen) {
    if (text.length <= maxLen)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > maxLen) {
        let cut = remaining.lastIndexOf("\n\n", maxLen);
        if (cut < maxLen / 2)
            cut = remaining.lastIndexOf("\n", maxLen);
        if (cut < maxLen / 2)
            cut = remaining.lastIndexOf(" ", maxLen);
        if (cut < maxLen / 2)
            cut = maxLen;
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut).trim();
    }
    if (remaining.length > 0)
        chunks.push(remaining);
    return chunks;
}
//# sourceMappingURL=notify.js.map