import express from "express";
import { config } from "./config";
import { statusRouter } from "./routes/status";
import { triggerRouter } from "./routes/trigger";
import { feedRouter } from "./routes/feed";
import { metricsRouter } from "./routes/metrics";
import { configuredMonitorIngress, MonitorWakeups, monitorRouter, runTriggeredMonitor } from "./monitorWebhook";

export function startApi(): Promise<void> {
  const app = express();
  app.use(express.json());

  const ingress = configuredMonitorIngress();
  if (ingress) {
    const wakeups = new MonitorWakeups(ingress.stateFile, runTriggeredMonitor);
    app.use("/monitor/alerts", monitorRouter(ingress, wakeups));
    // Local operations endpoint, deliberately not exposed through Caddy.
    app.get("/monitor/status", (_req, res) => res.json(wakeups.status()));
    setInterval(() => { void wakeups.tick().catch(() => {
      console.error("MONITOR_WEBHOOK_ERROR queue processing failed");
    }); }, 5_000).unref();
  }

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

  app.use("/trigger", triggerRouter);
  app.use("/feed", feedRouter);
  app.use("/metrics", metricsRouter);
  app.use("/", statusRouter);

  app.get("/", (_req, res) => {
    res.json({
      name: "claude-code-vm-job-dispatcher",
      version: "1.0.0",
      description: "Consumer-configured incident investigation and repair",
      endpoints: ["/health", "/live", "/ready", "/status", "/trigger", "/feed", "/metrics"],
    });
  });

  return new Promise((resolve) => {
    app.listen(config.httpPort, "127.0.0.1", () => {
      console.log(`[api] HTTP server on :${config.httpPort}`);
      resolve();
    });
  });
}
