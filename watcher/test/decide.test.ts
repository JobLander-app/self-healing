import { describe, expect, it } from "vitest";
import { decide, isBadSample } from "../src/decide.js";
import type { WatchState } from "../src/types.js";

const HEALTHY = { status: "pass", httpCode: "200" };
const BAD = { status: "degraded", httpCode: "503" };

describe("isBadSample", () => {
  it("flags fail, degraded, and non-200 HTTP", () => {
    expect(isBadSample({ status: "fail", httpCode: "200" })).toBe(true);
    expect(isBadSample({ status: "degraded", httpCode: "200" })).toBe(true);
    expect(isBadSample({ status: "pass", httpCode: "500" })).toBe(true);
    // unreachable: curl printed nothing -> code "" -> bad
    expect(isBadSample({ status: "unreachable", httpCode: "" })).toBe(true);
    expect(isBadSample({ status: "pass", httpCode: "200" })).toBe(false);
  });
});

describe("decide — hysteresis", () => {
  it("pages only on the 3rd consecutive bad sample (THRESHOLD=3)", () => {
    let state: WatchState = { count: 0, paged: false };

    const first = decide({ prevState: state, sample: BAD, threshold: 3 });
    expect(first.shouldPage).toBe(false);
    expect(first.nextState).toEqual({ count: 1, paged: false });
    state = first.nextState;

    const second = decide({ prevState: state, sample: BAD, threshold: 3 });
    expect(second.shouldPage).toBe(false);
    expect(second.nextState).toEqual({ count: 2, paged: false });
    state = second.nextState;

    const third = decide({ prevState: state, sample: BAD, threshold: 3 });
    expect(third.shouldPage).toBe(true);
    expect(third.nextState).toEqual({ count: 3, paged: true });
  });

  it("flap (bad, bad, good) never pages and resets state", () => {
    let state: WatchState = { count: 0, paged: false };
    state = decide({ prevState: state, sample: BAD, threshold: 3 }).nextState;
    state = decide({ prevState: state, sample: BAD, threshold: 3 }).nextState;

    const recovery = decide({ prevState: state, sample: HEALTHY, threshold: 3 });
    expect(recovery.shouldPage).toBe(false);
    // Never paged -> no RECOVERED message either.
    expect(recovery.shouldNotifyRecovered).toBe(false);
    expect(recovery.nextState).toEqual({ count: 0, paged: false });
  });

  it("dedups while PAGED: continued bad samples never re-page", () => {
    let state: WatchState = { count: 3, paged: true };
    for (let i = 0; i < 5; i += 1) {
      const decision = decide({ prevState: state, sample: BAD, threshold: 3 });
      expect(decision.shouldPage).toBe(false);
      expect(decision.nextState.paged).toBe(true);
      expect(decision.nextState.count).toBe(state.count + 1);
      state = decision.nextState;
    }
  });

  it("recovery message fires only if this incident actually paged", () => {
    const paged = decide({
      prevState: { count: 7, paged: true },
      sample: HEALTHY,
      threshold: 3,
    });
    expect(paged.shouldNotifyRecovered).toBe(true);
    expect(paged.nextState).toEqual({ count: 0, paged: false });

    const unpaged = decide({
      prevState: { count: 2, paged: false },
      sample: HEALTHY,
      threshold: 3,
    });
    expect(unpaged.shouldNotifyRecovered).toBe(false);
    expect(unpaged.nextState).toEqual({ count: 0, paged: false });
  });

  it("respects a custom threshold (WATCH_THRESHOLD)", () => {
    const atOne = decide({
      prevState: { count: 0, paged: false },
      sample: BAD,
      threshold: 1,
    });
    expect(atOne.shouldPage).toBe(true);

    const atFive = decide({
      prevState: { count: 3, paged: false },
      sample: BAD,
      threshold: 5,
    });
    expect(atFive.shouldPage).toBe(false);
    expect(atFive.nextState).toEqual({ count: 4, paged: false });
  });
});
