/**
 * Read-only serving API (§6). GET /changes is the correlation core's Stage-A
 * candidate-gather; GET /healthz exposes liveness for Prometheus/console.
 *
 * No auth — localhost-only, same firewall invariant as the dispatcher's :4100.
 * The router only READS the store; it never writes (single writer = the crons).
 */

import express, { Express, Request, Response } from "express";
import { ChangeStore } from "./store";
import { EntityRef } from "./model";

/** Per-source poll telemetry surfaced by /healthz. */
export interface HealthSnapshot {
  ok: boolean;
  lastPollBySource: Record<string, { at: string; ok: boolean; count: number } | null>;
  rowCount: number;
}

/** Parse repeatable `entity=type:id` into EntityRef[]. Malformed entries (no
 *  colon, empty half) are dropped — a bad param narrows nothing, never 500s. */
function parseEntities(raw: unknown): EntityRef[] {
  const values: string[] = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === "string"
      ? [raw]
      : [];
  const out: EntityRef[] = [];
  for (const v of values) {
    const idx = v.indexOf(":");
    if (idx <= 0) continue;
    const type = v.slice(0, idx).trim();
    const id = v.slice(idx + 1).trim();
    if (type && id) out.push({ type, id });
  }
  return out;
}

function parseIntParam(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function createApp({
  store,
  health,
}: {
  store: ChangeStore;
  health: () => HealthSnapshot;
}): Express {
  const app = express();

  app.get("/changes", (req: Request, res: Response) => {
    const since = parseIntParam(req.query.since);
    if (since === undefined) {
      res.status(400).json({ error: "missing or invalid required param: since (epoch ms)" });
      return;
    }
    const until = parseIntParam(req.query.until);
    const limit = parseIntParam(req.query.limit);
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const entities = parseEntities(req.query.entity);

    const rows = store.queryChanges({ since, until, entities, source, kind, limit });
    res.status(200).json(rows);
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json(health());
  });

  return app;
}
