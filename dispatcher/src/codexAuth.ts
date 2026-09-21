import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

export function codexHome(): string {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex-shl"));
}
export function credentialFingerprint(): string {
  try { return createHash("sha256").update(fs.readFileSync(path.join(codexHome(), "auth.json"))).digest("hex"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export function readCodexAuthState(): unknown {
  try { return JSON.parse(fs.readFileSync(path.join(codexHome(), "shl-auth-state.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

// The test build retains src/, whereas the production build does not.
export const codexSessionScript = ["../scripts/codex-session.py", "../../scripts/codex-session.py"]
  .map(file => path.resolve(__dirname, file)).find(file => fs.existsSync(file))!;
