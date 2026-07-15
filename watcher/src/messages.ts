/** Message texts — byte-for-byte the same as the bash watcher. */

export const buildRecoveredMessage = ({
  status,
  httpCode,
}: {
  status: string;
  httpCode: string;
}): string =>
  `RECOVERED: /health/output = ${status} (HTTP ${httpCode}). Product output flowing again.`;

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
  title: `[Monitor] /health/output=${status} — product output regression (backend)`,
  description:
    `Fast output-watch (JOB-670) tripped on the codified product-output invariant (JOB-668).\n\n` +
    `- status: **${status}** (HTTP ${httpCode})\n- regions: ${regions}\n\n` +
    `Meaning: input is alive but hints/output are not flowing (or the detector could not measure = fail-closed). ` +
    `This is the JOB-651 class (errors green, output dead). Investigate the STT->LLM->hint path / recent deploy; ` +
    `a rollback may be the fix rather than a code change.`,
});
