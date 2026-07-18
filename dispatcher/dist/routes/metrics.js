"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricsRouter = void 0;
const express_1 = require("express");
const session_1 = require("../session");
const trace_1 = require("../trace");
const healthcheck_1 = require("../healthcheck");
const poller_1 = require("../poller");
const metrics_1 = require("../metrics");
const router = (0, express_1.Router)();
exports.metricsRouter = router;
// GET /metrics — Prometheus text exposition (JOB-731 → free-core observability
// v1). Localhost scrape only: Prometheus scrapes localhost and the VM sits
// behind the IAP firewall, so no auth is applied here. Emits the 0.0.4 text
// format content-type so node_exporter/Prometheus parse it directly.
router.get("/", (_req, res) => {
    const body = (0, metrics_1.renderMetrics)({
        busy: (0, session_1.isBusy)(),
        lastRun: (0, trace_1.getLastRun)(),
        lastHealthcheck: (0, healthcheck_1.getLastHealthcheck)(),
        lastPrecheck: (0, poller_1.getLastPrecheck)(),
    });
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.status(200).send(body);
});
//# sourceMappingURL=metrics.js.map