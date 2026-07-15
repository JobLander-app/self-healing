"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.feedRouter = void 0;
const express_1 = require("express");
const trace_1 = require("../trace");
const router = (0, express_1.Router)();
exports.feedRouter = router;
// GET /feed — recent dispatch runs (read from the in-memory ring, hydrated
// from disk on startup). Optional ?limit= and ?outcome= filters.
router.get("/", (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const outcome = typeof req.query.outcome === "string" ? req.query.outcome : undefined;
    let runs = (0, trace_1.getRecentRuns)(limit);
    if (outcome)
        runs = runs.filter((r) => r.outcome === outcome);
    res.json({ runs });
});
//# sourceMappingURL=feed.js.map