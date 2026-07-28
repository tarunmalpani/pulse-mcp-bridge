/**
 * Mock mobile HTTP server for local testing of pulse-mcp without a physical device.
 * Listens on port 8080 and mimics the routes from mobile-app-server.js.
 */
import http from "http";

const PORT = 8080;
const connectedAt = new Date().toISOString();

const logs = [
  {
    id: 1,
    timestamp: new Date().toISOString(),
    level: "info",
    source: "App",
    message: "App started",
    device: { platform: "ios", osVersion: "17.4", appVersion: "1.0.0", buildNumber: "12", batteryLevel: "90%", activeRoute: "HomeScreen" },
  },
  {
    id: 2,
    timestamp: new Date().toISOString(),
    level: "success",
    source: "SyncService",
    message: "Synced dashboard data",
    device: { platform: "ios", osVersion: "17.4", appVersion: "1.0.0", buildNumber: "12", batteryLevel: "90%", activeRoute: "HomeScreen" },
  },
  {
    id: 3,
    timestamp: new Date().toISOString(),
    level: "error",
    source: "NetworkClient",
    message: "Network request failed: timeout after 3000ms",
    device: { platform: "ios", osVersion: "17.4", appVersion: "1.0.0", buildNumber: "12", batteryLevel: "89%", activeRoute: "DashboardScreen" },
  },
];

const session = {
  recording: false,
  steps: [
    { step: 1, description: "Tapped 'Sync Now' on Dashboard", timestamp: new Date().toISOString() },
    { step: 2, description: "Sync failed: request timed out after 3000ms", timestamp: new Date().toISOString() },
  ],
};

const savedReports = [
  {
    id: 1,
    stoppedAt: new Date().toISOString(),
    steps: session.steps,
    logs,
    deviceInfo: { platform: "ios", osVersion: "17.4", appVersion: "1.0.0", buildNumber: "12", batteryLevel: "89%", activeRoute: "DashboardScreen" },
  },
];

// 1x1 transparent PNG, base64-encoded
const FAKE_SCREENSHOT =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/status") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "online",
        batteryLevel: "90%",
        platform: "ios",
        osVersion: "17.4",
        appVersion: "1.0.0",
        buildNumber: "12",
        activeRoute: "HomeScreen",
        connectedAt,
      })
    );
    return;
  }

  if (req.url === "/logs") {
    res.writeHead(200);
    res.end(JSON.stringify({ logs }));
    return;
  }

  if (req.url === "/screenshot") {
    res.writeHead(200);
    res.end(JSON.stringify({ image: FAKE_SCREENSHOT, mimeType: "image/png" }));
    return;
  }

  if (req.url === "/session") {
    res.writeHead(200);
    res.end(JSON.stringify(session));
    return;
  }

  if (req.url === "/reports") {
    res.writeHead(200);
    res.end(JSON.stringify({ reports: savedReports }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Mock phone server listening on http://localhost:${PORT}`);
});
