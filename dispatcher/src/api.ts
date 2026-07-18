import express from "express";
import { config } from "./config";
import { statusRouter } from "./routes/status";
import { triggerRouter } from "./routes/trigger";
import { feedRouter } from "./routes/feed";
import { metricsRouter } from "./routes/metrics";

export function startApi(): Promise<void> {
  const app = express();
  app.use(express.json());

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
      description: "Autonomous JobLander Linear ticket fixer — self-poll, no human in the loop",
      endpoints: ["/health", "/status", "/trigger", "/feed", "/metrics"],
    });
  });

  return new Promise((resolve) => {
    app.listen(config.httpPort, "0.0.0.0", () => {
      console.log(`[api] HTTP server on :${config.httpPort}`);
      resolve();
    });
  });
}
