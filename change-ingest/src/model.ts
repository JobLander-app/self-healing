/**
 * The ChangeEvent contract — the normalized store row every source maps into.
 *
 * This is the boundary the intent-correlation core reads (see
 * docs/DESIGN-change-ingest-infra.md §2 and docs/DESIGN-intent-correlation.md
 * §0.1). One row per prod change, source-agnostic. Entities live in a separate
 * generic join table (see store.ts) — `type` stays OPAQUE text, never a
 * per-type column, so a future consumer can declare its own entity types with
 * no store migration.
 *
 * NO inference lives anywhere near this file: ingest → store → serving is fully
 * deterministic. The "is this anomaly explained?" judgment is the dispatcher's
 * own Claude CLI session reading these rows — not a call from this package.
 */

/** Sources slice-0 ingests. `deploy` rides the audit-log poller (a deploy IS an
 *  audit event); `notion` is a later slice. Kept as a string in the row so an
 *  unknown future source never needs a schema change. */
export type ChangeSource = "github" | "deploy" | "gcp_audit" | "linear" | "notion";

/** A scope handle the correlation core joins on. `type` is opaque (§2). */
export interface EntityRef {
  /** e.g. "gcp_instance" | "region" | "service" | "repo" — opaque to the store. */
  type: string;
  /** e.g. "lk-au-southeast1" | "australia-southeast1" | "joblander-audio-engine". */
  id: string;
}

/** The persisted/served row shape (§2). `ts` = EFFECTIVE time in prod. */
export interface ChangeEvent {
  /** source-prefixed, stable, idempotent PK: `gh:owner/repo#12`, `audit:<insertId>`, `linear:JOB-710`. */
  id: string;
  source: string;
  /** fine-grained: pr_merged | instance_delete | run_deploy | iam_change | issue_status … */
  kind: string;
  /** epoch ms, EFFECTIVE time in prod — the axis correlation ranges over. */
  ts: number;
  /** github login | SA email | linear user — context, NOT indexed. */
  actor: string | null;
  /** human one-line summary. */
  title: string;
  /** bounded ~2KB NL essence the LLM judges "expected?" on. */
  intent_text: string;
  /** pointer to full payload (gh url / log insertId / linear id). Never the raw payload. */
  raw_ref: string | null;
  /** epoch ms, when we recorded it (lag visibility). Stamped by the store on insert. */
  ingested_at: number;
}

/** A ChangeEvent before the store stamps `ingested_at`. Extractors produce this
 *  (they stay pure — no clock read), the store stamps the time on write. */
export type NewChangeEvent = Omit<ChangeEvent, "ingested_at">;

/** What a pure extractor returns and what a poller yields: a draft row + its
 *  entities, ready for an idempotent store upsert. */
export interface ExtractedChange {
  event: NewChangeEvent;
  entities: EntityRef[];
}

/** A served row: the ChangeEvent plus its entities, as returned by GET /changes. */
export interface ServedChange extends ChangeEvent {
  entities: EntityRef[];
}

/** Truncate NL text to the ~2KB inline budget for `intent_text` (§2). */
export const INTENT_TEXT_MAX = 2048;
export function truncateIntent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= INTENT_TEXT_MAX) return trimmed;
  return `${trimmed.slice(0, INTENT_TEXT_MAX - 1)}…`;
}
