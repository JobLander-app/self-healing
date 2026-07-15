import type { Decision, WatchState } from "./types.js";

/** Same detection semantics as bash `is_bad`: fail | degraded | HTTP != 200. */
export const isBadSample = ({
  status,
  httpCode,
}: {
  status: string;
  httpCode: string;
}): boolean => status === "fail" || status === "degraded" || httpCode !== "200";

/**
 * Pure hysteresis / exactly-once / recovery core (ports the bash state logic
 * verbatim):
 * - healthy sample: reset state to 0/unpaged; RECOVERED only if we had paged
 * - bad sample: increment count; page only when count reaches threshold AND
 *   we have not yet paged this incident; while paged, keep counting silently
 */
export const decide = ({
  prevState,
  sample,
  threshold,
}: {
  prevState: WatchState;
  sample: { status: string; httpCode: string };
  threshold: number;
}): Decision => {
  if (!isBadSample({ status: sample.status, httpCode: sample.httpCode })) {
    return {
      isBad: false,
      shouldPage: false,
      shouldNotifyRecovered: prevState.paged,
      nextState: { count: 0, paged: false },
    };
  }

  const count = prevState.count + 1;
  if (count < threshold || prevState.paged) {
    // Still building up to the threshold, OR already paged this incident.
    return {
      isBad: true,
      shouldPage: false,
      shouldNotifyRecovered: false,
      nextState: { count, paged: prevState.paged },
    };
  }

  // Sustained bad for `threshold` consecutive samples and not yet paged.
  return {
    isBad: true,
    shouldPage: true,
    shouldNotifyRecovered: false,
    nextState: { count, paged: true },
  };
};
