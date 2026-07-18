"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startApi = startApi;
const express_1 = __importDefault(require("express"));
const config_1 = require("./config");
const status_1 = require("./routes/status");
const trigger_1 = require("./routes/trigger");
const feed_1 = require("./routes/feed");
const metrics_1 = require("./routes/metrics");
function startApi() {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    // CORS — allow Owner dashboards / any operator UI.
    app.use((_req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Dispatch-Token");
        if (_req.method === "OPTIONS") {
            res.status(204).end();
            return;
        }
        next();
    });
    app.use("/trigger", trigger_1.triggerRouter);
    app.use("/feed", feed_1.feedRouter);
    app.use("/metrics", metrics_1.metricsRouter);
    app.use("/", status_1.statusRouter);
    app.get("/", (_req, res) => {
        res.json({
            name: "claude-code-vm-job-dispatcher",
            version: "1.0.0",
            description: "Autonomous JobLander Linear ticket fixer — self-poll, no human in the loop",
            endpoints: ["/health", "/status", "/trigger", "/feed", "/metrics"],
        });
    });
    return new Promise((resolve) => {
        app.listen(config_1.config.httpPort, "0.0.0.0", () => {
            console.log(`[api] HTTP server on :${config_1.config.httpPort}`);
            resolve();
        });
    });
}
//# sourceMappingURL=api.js.map