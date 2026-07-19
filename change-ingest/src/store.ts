/**
 * The change store — SQLite (WAL), single writer, embedded via better-sqlite3
 * (§5). Three tables:
 *   change_event   — one normalized row per prod change (model.ts).
 *   change_entity  — generic (change_id, type, id) join; INDEX(type,id) drives
 *                    the hot "changes touching entity X" query. `type` opaque.
 *   ingest_cursor  — one advisory cursor per source (the id PK is the real
 *                    dedupe; a reset cursor re-ingests a window harmlessly).
 *
 * Every write is idempotent: INSERT … ON CONFLICT DO NOTHING on the
 * source-prefixed id, so overlap on restart never double-counts.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { ChangeEvent, EntityRef, ExtractedChange, ServedChange } from "./model";

export interface QueryChangesOptions {
  /** required — lower bound on ts (inclusive), epoch ms. */
  since: number;
  /** optional — upper bound on ts (inclusive), epoch ms. Omit = up to now. */
  until?: number;
  /** optional — OR-matched (ANY of these entities touched). */
  entities?: EntityRef[];
  source?: string;
  kind?: string;
  /** default 200. */
  limit?: number;
}

interface EntityRow {
  change_id: string;
  type: string;
  id: string;
}

export class ChangeStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS change_event (
        id          TEXT PRIMARY KEY,
        source      TEXT NOT NULL,
        kind        TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        actor       TEXT,
        title       TEXT NOT NULL,
        intent_text TEXT NOT NULL,
        raw_ref     TEXT,
        ingested_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_change_event_ts ON change_event(ts);
      CREATE INDEX IF NOT EXISTS idx_change_event_source ON change_event(source);

      CREATE TABLE IF NOT EXISTS change_entity (
        change_id TEXT NOT NULL,
        type      TEXT NOT NULL,
        id        TEXT NOT NULL,
        PRIMARY KEY (change_id, type, id),
        FOREIGN KEY (change_id) REFERENCES change_event(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_change_entity_type_id ON change_entity(type, id);

      CREATE TABLE IF NOT EXISTS ingest_cursor (
        source TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );
    `);
  }

  /**
   * Idempotently write a change + its entities. ON CONFLICT the event row is
   * left untouched (first-write wins, incl. its ingested_at) and entity rows
   * are likewise INSERT OR IGNORE. Safe to call repeatedly for the same id.
   */
  upsert({ event, entities, ingestedAt }: ExtractedChange & { ingestedAt?: number }): void {
    const stamped = ingestedAt ?? Date.now();
    const insertEvent = this.db.prepare(
      `INSERT INTO change_event (id, source, kind, ts, actor, title, intent_text, raw_ref, ingested_at)
       VALUES (@id, @source, @kind, @ts, @actor, @title, @intent_text, @raw_ref, @ingested_at)
       ON CONFLICT(id) DO NOTHING`,
    );
    const insertEntity = this.db.prepare(
      `INSERT INTO change_entity (change_id, type, id) VALUES (?, ?, ?)
       ON CONFLICT(change_id, type, id) DO NOTHING`,
    );
    const tx = this.db.transaction(() => {
      insertEvent.run({ ...event, actor: event.actor, raw_ref: event.raw_ref, ingested_at: stamped });
      for (const e of entities) insertEntity.run(event.id, e.type, e.id);
    });
    tx();
  }

  /**
   * The hot query (§6): changes with ts in [since, until], optionally narrowed
   * by OR-matched entities / source / kind, ordered ts DESC. Each returned row
   * carries its entities inline (served shape).
   */
  queryChanges(opts: QueryChangesOptions): ServedChange[] {
    const clauses: string[] = ["e.ts >= ?"];
    const params: (string | number)[] = [opts.since];

    if (opts.until !== undefined) {
      clauses.push("e.ts <= ?");
      params.push(opts.until);
    }
    if (opts.source) {
      clauses.push("e.source = ?");
      params.push(opts.source);
    }
    if (opts.kind) {
      clauses.push("e.kind = ?");
      params.push(opts.kind);
    }
    if (opts.entities && opts.entities.length > 0) {
      const pairOr = opts.entities.map(() => "(ce.type = ? AND ce.id = ?)").join(" OR ");
      clauses.push(
        `e.id IN (SELECT ce.change_id FROM change_entity ce WHERE ${pairOr})`,
      );
      for (const ent of opts.entities) params.push(ent.type, ent.id);
    }

    const limit = opts.limit ?? 200;
    const sql = `SELECT e.* FROM change_event e WHERE ${clauses.join(" AND ")} ORDER BY e.ts DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as ChangeEvent[];
    if (rows.length === 0) return [];

    // Attach entities in one batched lookup.
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(", ");
    const entityRows = this.db
      .prepare(`SELECT change_id, type, id FROM change_entity WHERE change_id IN (${placeholders})`)
      .all(...ids) as EntityRow[];
    const byChange = new Map<string, EntityRef[]>();
    for (const er of entityRows) {
      const list = byChange.get(er.change_id) ?? [];
      list.push({ type: er.type, id: er.id });
      byChange.set(er.change_id, list);
    }
    return rows.map((r) => ({ ...r, entities: byChange.get(r.id) ?? [] }));
  }

  getCursor(source: string): string | null {
    const row = this.db.prepare("SELECT value FROM ingest_cursor WHERE source = ?").get(source) as
      | { value: string }
      | undefined;
    return row ? row.value : null;
  }

  setCursor(source: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO ingest_cursor (source, value) VALUES (?, ?)
         ON CONFLICT(source) DO UPDATE SET value = excluded.value`,
      )
      .run(source, value);
  }

  rowCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM change_event").get() as { n: number };
    return row.n;
  }

  /** Delete rows with ts older than `olderThanMs` ago. Returns rows removed.
   *  change_entity cascades via the FK. */
  prune(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const info = this.db.prepare("DELETE FROM change_event WHERE ts < ?").run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
  }
}
