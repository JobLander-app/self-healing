import { Router, Request, Response } from "express";
import { getRecentRuns } from "../trace";

const router = Router();

// GET /feed — recent dispatch runs (read from the in-memory ring, hydrated
// from disk on startup). Optional ?limit= and ?outcome= filters.
router.get("/", (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 20;
  const outcome = typeof req.query.outcome === "string" ? req.query.outcome : undefined;
  let runs = getRecentRuns(limit);
  if (outcome) runs = runs.filter((r) => r.outcome === outcome);
  res.json({ runs });
});

export { router as feedRouter };
