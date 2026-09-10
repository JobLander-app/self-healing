import { describe, expect, it, vi } from "vitest";
import { processSample, type TickEffects } from "../src/processSample.js";
import type { Sample, WatchState } from "../src/types.js";
import { parseState, serializeState } from "../src/state.js";

const bad: Sample = { status: "fail", httpCode: "200", bodyText: '{"status":"fail"}' };
const good: Sample = { status: "pass", httpCode: "200", bodyText: '{"status":"pass"}' };
function harness() {
  let state: WatchState = { count: 2, paged: false };
  const lines: string[] = [];
  const effects: TickEffects = {
    notifyOwner: vi.fn(async () => {}), createLinearTicket: vi.fn(async () => "JOB-999"),
    triggerDispatcher: vi.fn(async () => {}),
    saveState: vi.fn(async ({ state: next }) => { state = parseState({ content: serializeState({ state: next }) }); }),
    log: ({ line }) => lines.push(line), writeMetrics: vi.fn(async () => {}),
  };
  const tick = (sample = bad, now = 1_000_000, dryRun = false) => processSample({ sample,
    prevState: state, threshold: 3, url: "https://detector.test", dryRun, effects, now });
  return { effects, tick, state: () => state, set: (next: WatchState) => { state = next; }, lines };
}

describe("durable watcher delivery", () => {
  it("checkpoints before effects; continued bad ticks do not repeat confirmed actions", async () => {
    const h = harness();
    h.effects.notifyOwner = vi.fn(async () => {
      expect(h.state().outbox?.[0]?.id).toBeTruthy();
    });
    await h.tick();
    const id = h.state().outbox![0]!.id;
    await h.tick(bad, 2_000_000);
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(2); // page + created
    expect(h.effects.createLinearTicket).toHaveBeenCalledTimes(1);
    expect(h.effects.createLinearTicket).toHaveBeenCalledWith(expect.objectContaining({ incidentId: id }));
    expect(h.effects.triggerDispatcher).toHaveBeenCalledWith({ incidentId: id });
    expect(h.effects.writeMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ pagedThisTick: false, pendingActions: 0 }));
  });
  it("retries transient page failure after backoff across serialization without duplicating ticket", async () => {
    const h = harness();
    h.effects.notifyOwner = vi.fn().mockRejectedValueOnce(new Error("timeout after possible delivery")).mockResolvedValue(undefined);
    await h.tick();
    const first = h.state().outbox![0]!;
    expect(first.delivered.page).toBeUndefined();
    expect(first.delivered.ticket).toBe(true);
    await h.tick(bad, 1_030_000);
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(2);
    await h.tick(bad, 1_060_000);
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(3);
    expect(h.effects.notifyOwner).toHaveBeenLastCalledWith(expect.objectContaining({ message: expect.stringContaining(first.id) }));
    expect(h.effects.createLinearTicket).toHaveBeenCalledTimes(1);
    expect(h.state().outbox![0]!.delivered.page).toBe(true);
    expect(h.lines.some(l => l.includes("at-least-once"))).toBe(true);
  });
  it("retries failed Linear create with same UUID, and only triggers after a confirmed ticket", async () => {
    const h = harness();
    h.effects.createLinearTicket = vi.fn().mockRejectedValueOnce(new Error("lost response")).mockResolvedValue("JOB-999");
    await h.tick();
    expect(h.effects.triggerDispatcher).not.toHaveBeenCalled();
    const id = h.state().outbox![0]!.id;
    await h.tick(bad, 1_060_000);
    expect(h.effects.createLinearTicket).toHaveBeenLastCalledWith(expect.objectContaining({ incidentId: id }));
    expect(h.effects.triggerDispatcher).toHaveBeenCalledOnce();
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(2);
  });
  it("retries failed trigger alone with same receipt key", async () => {
    const h = harness();
    h.effects.triggerDispatcher = vi.fn().mockRejectedValueOnce(new Error("503")).mockResolvedValue(undefined);
    await h.tick();
    await h.tick(bad, 1_060_000);
    expect(h.effects.triggerDispatcher).toHaveBeenCalledTimes(2);
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(2);
    expect(h.effects.createLinearTicket).toHaveBeenCalledTimes(1);
  });
  it("recovery cancels stale pages/tickets, but retains failed recovery when a new incident starts", async () => {
    const h = harness();
    await h.tick();
    const oldId = h.state().outbox![0]!.id;
    h.effects.notifyOwner = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await h.tick(good, 1_060_000);
    expect(h.state().paged).toBe(false);
    expect(h.state().outbox![0]!.recovered).toBe(true);
    await h.tick(bad, 1_080_000);
    await h.tick(bad, 1_090_000);
    await h.tick(bad, 1_100_000);
    expect(h.state().outbox).toHaveLength(2);
    await h.tick(bad, 1_120_000);
    expect(h.state().outbox).toHaveLength(1);
    expect(h.state().outbox![0]!.id).not.toBe(oldId);
    expect(h.effects.createLinearTicket).toHaveBeenCalledTimes(2);
  });
  it("malformed HTTP 200 never clears active incident or emits recovery", async () => {
    const h = harness();
    await h.tick();
    await h.tick({ status: "unreachable", httpCode: "200", bodyText: "{broken" }, 1_060_000);
    expect(h.state().paged).toBe(true);
    expect(h.state().count).toBe(4);
    expect(h.effects.notifyOwner).toHaveBeenCalledTimes(2);
  });
  it("legacy PAGED migration avoids new page/ticket and retries recovery", async () => {
    const h = harness();
    h.set(parseState({ content: "15 1\n" }));
    await h.tick();
    expect(h.effects.createLinearTicket).not.toHaveBeenCalled();
    h.effects.notifyOwner = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await h.tick(good);
    expect(h.state().outbox).toHaveLength(1);
    await h.tick(good, 1_060_000);
    expect(h.state().outbox).toHaveLength(0);
  });
  it("durable checkpoint failure stops before external mutations", async () => {
    const h = harness();
    h.effects.saveState = vi.fn(async () => { throw new Error("disk full"); });
    await expect(h.tick()).rejects.toThrow("disk full");
    expect(h.effects.notifyOwner).not.toHaveBeenCalled();
    expect(h.effects.createLinearTicket).not.toHaveBeenCalled();
  });
  it("dry-run neither mutates delivery state nor sends notifications", async () => {
    const h = harness();
    await h.tick(bad, 1_000_000, true);
    expect(h.effects.saveState).not.toHaveBeenCalled();
    expect(h.effects.notifyOwner).not.toHaveBeenCalled();
  });
});
