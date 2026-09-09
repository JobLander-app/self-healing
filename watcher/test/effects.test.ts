import { afterEach, expect, it, vi } from "vitest";
import { buildRealEffects } from "../src/effects.js";
import { readConfig } from "../src/config.js";

const config = readConfig({ env: { DISPATCH_TOKEN: "test-only" } });
const input = { incidentId: "cfec85b7-8f53-430a-a7d1-a413b8b66857", status: "fail", httpCode: "200", regions: "test" };
const effects = () => buildRealEffects({ config, secretReader: async () => "test-only" });
afterEach(() => vi.unstubAllGlobals());

it("reconciles an accepted create after a lost response without another mutation", async () => {
  let created = false;
  let mutations = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.query.startsWith("query")) {
      return new Response(JSON.stringify({ data: { issues: { nodes: created ? [{ identifier: "JOB-999" }] : [] } } }));
    }
    mutations++;
    expect(body.variables.i.id).toBe(input.incidentId);
    created = true;
    throw new Error("response lost after commit");
  }));
  await expect(effects().createLinearTicket(input)).rejects.toThrow("response lost");
  expect(await effects().createLinearTicket(input)).toBe("JOB-999");
  expect(mutations).toBe(1);
});

it("GraphQL HTTP200 errors and missing credentials remain retryable", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: "denied" }] }))));
  await expect(effects().createLinearTicket(input)).rejects.toThrow("GraphQL");
  const missing = buildRealEffects({ config, secretReader: async () => null });
  await expect(missing.createLinearTicket(input)).rejects.toThrow("credential unavailable");
});

it("checks trigger HTTP status and sends a stable idempotency receipt key", async () => {
  const request = vi.fn(async () => new Response("error", { status: 503 }));
  vi.stubGlobal("fetch", request);
  await expect(effects().triggerDispatcher({ incidentId: input.incidentId })).rejects.toThrow("503");
  expect(request).toHaveBeenCalledWith(config.triggerUrl, expect.objectContaining({
    headers: expect.objectContaining({ "Idempotency-Key": `output-watch:${input.incidentId}` }),
  }));
});
