/** Persistent hysteresis state — mirrors the bash "COUNT PAGED" state file. */
export interface WatchState {
  /** Consecutive bad samples in the current (potential) incident. */
  count: number;
  /** Whether this incident has already paged (exactly-once dedup). */
  paged: boolean;
}

/**
 * One observation of /health/output.
 * httpCode is a STRING to mirror bash curl semantics: "" when unreachable
 * (curl printed nothing), so `httpCode !== "200"` is bad — same as the bash
 * `[ "$CODE" != "200" ]` test.
 */
export interface Sample {
  /** body.status, or "unreachable" when the body is missing/unparsable. */
  status: string;
  /** HTTP status as text; "" when the request itself failed. */
  httpCode: string;
  /** Raw response body (used for regions rendering). */
  bodyText: string;
}

/** Output of the pure decision core. */
export interface Decision {
  isBad: boolean;
  /** Fire the full incident sequence (Telegram -> Linear -> trigger). */
  shouldPage: boolean;
  /** Send the RECOVERED message (only if this incident actually paged). */
  shouldNotifyRecovered: boolean;
  nextState: WatchState;
}
