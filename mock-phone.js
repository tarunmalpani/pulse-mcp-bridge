/**
 * Mock mobile HTTP server for local testing of pulse-mcp without a physical device.
 * Listens on port 8080 and mimics the /status and /logs routes from mobile-app-server.js.
 */
import http from "http";

const PORT = 8080;

const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");

  if (req.url === "/status") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: "online",
        batteryLevel: "90%",
        platform: "iOS",
        activeRoute: "HomeScreen",
      })
    );
    return;
  }

  if (req.url === "/logs") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        logs: ["[App Started]", "[Mock Log] App rendered"],
      })
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Mock phone server listening on http://localhost:${PORT}`);
});
