import type { Readable } from "node:stream";
export async function readProviderPrompt(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  let prompt = "";
  for await (const chunk of stream) {
    prompt += chunk;
    if (Buffer.byteLength(prompt) > 1_000_000) throw new Error("Prompt exceeds 1 MB");
  }
  if (!prompt.trim()) throw new Error("Prompt required on stdin");
  return prompt;
}
