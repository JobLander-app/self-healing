/**
 * JOB-731 Phase 1: TypeScript port of watcher/output-watch.sh (JOB-670).
 * Single run, cron-compatible: `node dist/tick.js` every minute.
 * The bash script stays in place until cutover; the state file format is
 * shared, so the two are interchangeable mid-incident.
 */
import { readConfig } from "./config.js";
import { buildRealEffects, gcloudSecretReader } from "./effects.js";
import { processSample } from "./processSample.js";
import { applyForceBad, fetchSample } from "./sample.js";
import { loadStateFile } from "./state.js";

const main = async (): Promise<void> => {
  const config = readConfig({ env: process.env });
  const secretReader = gcloudSecretReader;

  const rawSample = await fetchSample({ config, secretReader });
  const sample = applyForceBad({ sample: rawSample, forceBad: config.forceBad });
  const prevState = await loadStateFile({ path: config.stateFile });
  const effects = buildRealEffects({ config, secretReader });

  await processSample({
    sample,
    prevState,
    threshold: config.threshold,
    url: config.url,
    dryRun: config.dryRun,
    effects,
  });
};

main().catch((error: unknown) => {
  // No heartbeat on a crashed tick — the Cloud Monitoring absence alert is
  // exactly what should catch a broken watcher.
  console.error(`output-watch tick failed: ${String(error)}`);
  process.exitCode = 1;
});
