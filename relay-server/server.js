#!/usr/bin/env node

import express from "express";
import { putDeviceState, getDeviceState } from "./lib/db.js";
import { enqueueCommand, drainPendingCommands, fulfillCommand } from "./lib/commandQueue.js";
import { maybeDispatch, dispatchNow } from "./lib/githubDispatch.js";

const PORT = process.env.PORT || 9000;
const API_KEY = process.env.PULSE_API_KEY;

if (!API_KEY) {
  console.error("PULSE_API_KEY is required - refusing to start an unauthenticated relay.");
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: "10mb" })); // screenshots are base64 PNG, can be a few MB

// Unauthenticated - hosting platforms (Render, etc.) hit this for uptime checks.
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use((req, res, next) => {
  if (req.headers["x-pulse-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Missing or invalid x-pulse-api-key header." });
  }
  next();
});

const DEFAULTS = {
  status: null,
  logs: { logs: [] },
  crashes: { crashes: [] },
  reports: { reports: [] },
  session: { recording: false, steps: [] },
};

/** Registers the identical POST (push) / GET (read) pair for a state kind like "status" or "logs". */
function registerStateRoutes(kind, { onPush } = {}) {
  app.post(`/devices/:deviceId/${kind}`, async (req, res) => {
    const { deviceId } = req.params;
    putDeviceState(deviceId, kind, req.body);
    if (onPush) {
      try {
        await onPush(deviceId, req.body);
      } catch (err) {
        console.error(`[relay] onPush hook for ${kind} failed:`, err.message);
      }
    }
    res.json({ ok: true });
  });

  app.get(`/devices/:deviceId/${kind}`, (req, res) => {
    const { deviceId } = req.params;
    const data = getDeviceState(deviceId, kind);
    if (data === null && DEFAULTS[kind] === null) {
      return res.status(404).json({ error: `No ${kind} pushed yet for device "${deviceId}".` });
    }
    res.json(data ?? DEFAULTS[kind]);
  });
}

registerStateRoutes("status");
registerStateRoutes("logs");
registerStateRoutes("reports");
registerStateRoutes("session");

registerStateRoutes("crashes", {
  onPush: async (deviceId, body) => {
    const crash = (body.crashes && body.crashes[0]) || null; // phone pushes newest-first
    if (!crash) return;
    const dedupeInput = `crash:${crash.message}:${(crash.stack || "").split("\n")[1] || ""}`;
    await maybeDispatch(
      "pulse-crash",
      dedupeInput,
      { deviceId, message: crash.message, stack: crash.stack, componentStack: crash.componentStack, breadcrumbs: crash.breadcrumbs, device: crash.device, timestamp: crash.timestamp }
    );
  },
});

app.post("/devices/:deviceId/reports/new", async (req, res) => {
  // Separate endpoint for "a report was just saved" so the dispatch fires once
  // per new report rather than every time the /reports push resends the whole list.
  const { deviceId } = req.params;
  const report = req.body;
  const dedupeInput = `report:${deviceId}:${report.id}`;
  await maybeDispatch("pulse-bug-report", dedupeInput, {
    deviceId,
    steps: report.steps,
    logs: report.logs,
    deviceInfo: report.deviceInfo,
  });
  res.json({ ok: true });
});

// --- User-submitted commands (from the app's "Ask IDE" screen) -----------
// Unlike crashes/bug-reports (which push data for index.js to read), this is
// the client explicitly asking for a fix right now - always dispatches, no
// de-dupe cooldown, since a repeated identical request is presumably
// intentional (e.g. "still broken, try again").

app.post("/devices/:deviceId/user-commands", async (req, res) => {
  const { deviceId } = req.params;
  const { text } = req.body;
  if (!text || typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Missing required \"text\" field." });
  }
  const result = await dispatchNow("pulse-user-command", {
    deviceId,
    text: text.trim(),
    submittedAt: new Date().toISOString(),
  });
  if (!result.dispatched) {
    return res.status(result.reason === "not_configured" ? 501 : 502).json({
      ok: false,
      error:
        result.reason === "not_configured"
          ? "The auto-fix pipeline isn't configured on this relay (GITHUB_TOKEN/GITHUB_REPO unset)."
          : "Failed to dispatch to GitHub.",
    });
  }
  res.json({ ok: true });
});

// --- On-demand screenshot (command queue) ---------------------------------

app.get("/devices/:deviceId/screenshot", async (req, res) => {
  const { deviceId } = req.params;
  try {
    const result = await enqueueCommand(deviceId, "screenshot");
    res.json(result);
  } catch (err) {
    res.status(504).json({ error: err.message });
  }
});

app.get("/devices/:deviceId/commands", (req, res) => {
  const { deviceId } = req.params;
  res.json({ commands: drainPendingCommands(deviceId) });
});

app.post("/devices/:deviceId/commands/:commandId/result", (req, res) => {
  const { commandId } = req.params;
  const fulfilled = fulfillCommand(commandId, req.body);
  if (!fulfilled) {
    return res.status(404).json({ error: `No pending command "${commandId}" (it may have already timed out).` });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`pulse-mcp relay listening on port ${PORT}`);
});
