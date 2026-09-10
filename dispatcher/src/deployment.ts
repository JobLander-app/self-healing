import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** Set by CD before its final busy check; removed only after activation or
 * rollback finishes. A retained guard keeps failed recovery from claiming work.
 */
export function isDeploymentInProgress(): boolean {
  return existsSync(process.env.DEPLOY_GUARD_FILE || resolve(__dirname, "../../.deploying"));
}
