import { describe, expect, it, vi } from "vitest";
import type { TickEffects } from "../src/processSample.js";
import { processSample } from "../src/processSample.js";
import type { Sample } from "../src/types.js";

const URL = "https://example.a.run.app";

const badSample = ({ bodyText }: { bodyText?: string } = {}): Sample => ({
  status: "fail",
  httpCode: "200",
  bodyText:
    bodyText ??
    JSON.stringify({
      status: "fail",
      regions: { "europe-west1": { verdict: "fail_slow", reason: "hints dead" } },
    }),
});

const healthySample = (): Sample => ({
  status: "pass",
  httpCode: "200",
  bodyText: JSON.stringify({ status: "pass", regions: {} }),
});

const makeEffects = (): { effects: TickEffects; order: string[]; lines: string[] } => {
  const order: string[] = [];
  const lines: string[] = [];
  const effects: TickEffects = {
    notifyOwner: vi.fn(async () => {
      order.push("telegram");
    }),
    createLinearTicket: vi.fn(async () => {
      order.push("linear");
    }),
    triggerDispatcher: vi.fn(async () => {
      order.push("trigger");
    }),
    saveState: vi.fn(async () => {
      order.push("saveState");
    }),
    log: vi.fn(({ line }: { line: string }) => {
      lines.push(line);
    }),
  };
  return { effects, order, lines };
};

const heartbeats = ({ lines }: { lines: string[] }): string[] =>
  lines.filter((line) => line.startsWith("WATCHER_HEARTBEAT "));

describe("processSample — incident sequence", () => {
  it("pages with state persisted first, then Telegram, Linear, trigger", async () => {
    const { effects, order } = makeEffects();
    const decision = await processSample({
      sample: badSample({}),
      prevState: { count: 2, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });

    expect(decision.shouldPage).toBe(true);
    expect(order).toEqual(["saveState", "telegram", "linear", "trigger"]);
    expect(effects.saveState).toHaveBeenCalledWith({
      state: { count: 3, paged: true },
    });
    expect(effects.notifyOwner).toHaveBeenCalledWith({
      message:
        "URGENT P0 [output-watch]: /health/output = fail (HTTP 200). " +
        "Input alive, output dead/unmeasurable. " +
        "Regions: europe-west1:fail_slow (hints dead). " +
        `${URL}/health/output`,
    });
    expect(effects.createLinearTicket).toHaveBeenCalledWith({
      status: "fail",
      httpCode: "200",
      regions: "europe-west1:fail_slow (hints dead)",
    });
  });

  it("Telegram fires FIRST and is not failed by a throwing Linear ticket", async () => {
    const { effects, order, lines } = makeEffects();
    effects.createLinearTicket = vi.fn(async () => {
      order.push("linear");
      throw new Error("linear 500");
    });

    await expect(
      processSample({
        sample: badSample({}),
        prevState: { count: 2, paged: false },
        threshold: 3,
        url: URL,
        dryRun: false,
        effects,
      }),
    ).resolves.toMatchObject({ shouldPage: true });

    // Page already sent before Linear ran; trigger still ran after the throw.
    expect(order).toEqual(["saveState", "telegram", "linear", "trigger"]);
    expect(lines.some((l) => l.includes("linear create failed"))).toBe(true);
    expect(heartbeats({ lines })).toHaveLength(1);
  });

  it("trigger failure is logged, never thrown", async () => {
    const { effects, lines } = makeEffects();
    effects.triggerDispatcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED 4100");
    });

    await expect(
      processSample({
        sample: badSample({}),
        prevState: { count: 2, paged: false },
        threshold: 3,
        url: URL,
        dryRun: false,
        effects,
      }),
    ).resolves.toBeDefined();
    expect(lines.some((l) => l.includes("dispatcher trigger failed"))).toBe(true);
  });

  it("a failing Telegram page still lets Linear + trigger run (bash parity)", async () => {
    const { effects, order } = makeEffects();
    effects.notifyOwner = vi.fn(async () => {
      order.push("telegram");
      throw new Error("notify.sh exit 1");
    });

    await processSample({
      sample: badSample({}),
      prevState: { count: 2, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    expect(order).toEqual(["saveState", "telegram", "linear", "trigger"]);
  });

  it("below threshold: only saves state, no page actions", async () => {
    const { effects, order } = makeEffects();
    await processSample({
      sample: badSample({}),
      prevState: { count: 0, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    expect(order).toEqual(["saveState"]);
    expect(effects.saveState).toHaveBeenCalledWith({
      state: { count: 1, paged: false },
    });
  });

  it("dedup while PAGED: no second page for the same incident", async () => {
    const { effects, order } = makeEffects();
    await processSample({
      sample: badSample({}),
      prevState: { count: 3, paged: true },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    expect(order).toEqual(["saveState"]);
    expect(effects.notifyOwner).not.toHaveBeenCalled();
    expect(effects.saveState).toHaveBeenCalledWith({
      state: { count: 4, paged: true },
    });
  });
});

describe("processSample — recovery", () => {
  it("sends RECOVERED (before state reset) only if the incident paged", async () => {
    const { effects, order } = makeEffects();
    await processSample({
      sample: healthySample(),
      prevState: { count: 6, paged: true },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    // bash notifies RECOVERED, then writes "0 0"
    expect(order).toEqual(["telegram", "saveState"]);
    expect(effects.notifyOwner).toHaveBeenCalledWith({
      message:
        "RECOVERED: /health/output = pass (HTTP 200). Product output flowing again.",
    });
    expect(effects.saveState).toHaveBeenCalledWith({
      state: { count: 0, paged: false },
    });
  });

  it("healthy without prior page: silent state reset", async () => {
    const { effects, order } = makeEffects();
    await processSample({
      sample: healthySample(),
      prevState: { count: 2, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    expect(order).toEqual(["saveState"]);
    expect(effects.notifyOwner).not.toHaveBeenCalled();
  });
});

describe("processSample — DRY_RUN hook", () => {
  it("prints [DRY] lines instead of executing page actions (state still saved)", async () => {
    const { effects, order, lines } = makeEffects();
    await processSample({
      sample: badSample({}),
      prevState: { count: 2, paged: false },
      threshold: 3,
      url: URL,
      dryRun: true,
      effects,
    });

    expect(order).toEqual(["saveState"]);
    expect(effects.notifyOwner).not.toHaveBeenCalled();
    expect(effects.createLinearTicket).not.toHaveBeenCalled();
    expect(effects.triggerDispatcher).not.toHaveBeenCalled();
    expect(lines).toContainEqual(
      "[DRY] notify P0 status=fail http=200 regions=europe-west1:fail_slow (hints dead)",
    );
    expect(
      lines.some((l) => l.startsWith("[DRY] create [Monitor] ticket status=fail")),
    ).toBe(true);
    expect(lines).toContain("[DRY] POST dispatcher /trigger");
  });

  it("prints [DRY] for the RECOVERED notify too", async () => {
    const { effects, lines } = makeEffects();
    await processSample({
      sample: healthySample(),
      prevState: { count: 4, paged: true },
      threshold: 3,
      url: URL,
      dryRun: true,
      effects,
    });
    expect(lines).toContain("[DRY] notify RECOVERED pass");
    expect(effects.notifyOwner).not.toHaveBeenCalled();
  });
});

describe("processSample — heartbeat", () => {
  it("emits exactly one structured WATCHER_HEARTBEAT line per tick", async () => {
    const { effects, lines } = makeEffects();
    await processSample({
      sample: badSample({}),
      prevState: { count: 2, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });

    const beats = heartbeats({ lines });
    expect(beats).toHaveLength(1);
    const payload: unknown = JSON.parse(
      (beats[0] ?? "").replace("WATCHER_HEARTBEAT ", ""),
    );
    expect(payload).toMatchObject({
      status: "fail",
      http: "200",
      bad: true,
      count: 3,
      paged: true,
      pagedThisTick: true,
      recovered: false,
      dryRun: false,
    });
    expect(typeof (payload as { ts: unknown }).ts).toBe("string");
  });

  it("emits the heartbeat on healthy ticks as well", async () => {
    const { effects, lines } = makeEffects();
    await processSample({
      sample: healthySample(),
      prevState: { count: 0, paged: false },
      threshold: 3,
      url: URL,
      dryRun: false,
      effects,
    });
    const beats = heartbeats({ lines });
    expect(beats).toHaveLength(1);
    expect(JSON.parse((beats[0] ?? "").replace("WATCHER_HEARTBEAT ", ""))).toMatchObject(
      { bad: false, count: 0, paged: false, pagedThisTick: false },
    );
  });
});
