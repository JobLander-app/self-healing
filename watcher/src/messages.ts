/** Message texts — byte-for-byte the same as the bash watcher. */

export const buildRecoveredMessage = ({
  status,
  httpCode,
}: {
  status: string;
  httpCode: string;
}): string =>
  `RECOVERED: /health/output = ${status} (HTTP ${httpCode}). Product output flowing again.`;

/**
 * Second lifecycle Telegram, sent only after a Linear ticket is created:
 * tells the owner the self-healing loop has picked the incident up.
 */
export const buildTicketCreatedMessage = ({
  identifier,
}: {
  identifier: string;
}): string => `🎫 ${identifier} created — self-healing engaged`;

export const buildPageMessage = ({
  status,
  httpCode,
  regions,
  url,
}: {
  status: string;
  httpCode: string;
  regions: string;
  url: string;
}): string =>
  `URGENT P0 [output-watch]: /health/output = ${status} (HTTP ${httpCode}). ` +
  `Input alive, output dead/unmeasurable. Regions: ${regions}. ${url}/health/output`;

export const buildLinearTicket = ({
  status,
  httpCode,
  regions,
}: {
  status: string;
  httpCode: string;
  regions: string;
}): { title: string; description: string } => ({
  title: `[Monitor] /health/output=${status} — product output regression`,
  description:
    `The output watcher detected a sustained product-output failure.\n\n` +
    `- status: **${status}** (HTTP ${httpCode})\n- regions: ${regions}\n\n` +
    `Input may be alive while output is missing, or the detector could not measure it. ` +
    `Investigate the configured output contract and recent deployments using the consumer policy.`,
});
