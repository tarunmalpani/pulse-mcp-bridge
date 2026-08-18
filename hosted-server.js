#!/usr/bin/env node
/**
 * Hosted, multi-tenant version of the pulse-mcp MCP server.
 *
 * Unlike index.js (spawned locally over stdio, single-tenant via env vars),
 * this runs as a shared HTTP service: deploy it once, and anyone can point
 * their IDE's MCP client at its URL - each caller supplies their OWN relay
 * URL/API key/deviceId via request headers, so no source code or per-person
 * config needs to be handed out. This file never sees or shares anyone's
 * relay credentials with anyone else - they're read fresh per request and
 * never persisted.
 *
 * Required headers on every request to /mcp:
 *   Authorization: Bearer <HOSTED_ACCESS_KEY>   - gate for reaching this server at all
 *   X-Pulse-Relay-Url: https://your-relay.example.com
 *   X-Pulse-Relay-Api-Key: <the caller's own relay's PULSE_API_KEY>
 *   X-Pulse-Device-Id: <the caller's own deviceId>
 *
 * get_standup_snapshot's git-log feature is intentionally disabled here -
 * "today's local commits" has no meaning for a shared remote server.
 */

import express from "express";
import axios from "axios";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createPulseServer } from "./lib/mcpToolServer.js";

const PORT = process.env.PORT || 8787;
const HOSTED_ACCESS_KEY = process.env.HOSTED_ACCESS_KEY;

if (!HOSTED_ACCESS_KEY) {
  console.error("HOSTED_ACCESS_KEY is required - refusing to start an unauthenticated hosted MCP server.");
  process.exit(1);
}

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/mcp", async (req, res) => {
  if (req.headers["authorization"] !== `Bearer ${HOSTED_ACCESS_KEY}`) {
    return res.status(401).json({ error: "Missing or invalid Authorization header." });
  }

  const relayUrl = req.headers["x-pulse-relay-url"];
  const relayApiKey = req.headers["x-pulse-relay-api-key"];
  const deviceId = req.headers["x-pulse-device-id"];

  if (!relayUrl || !relayApiKey || !deviceId) {
    return res.status(400).json({
      error: "Missing one or more required headers: X-Pulse-Relay-Url, X-Pulse-Relay-Api-Key, X-Pulse-Device-Id.",
    });
  }

  const targetBase = `${String(relayUrl).replace(/\/$/, "")}/devices/${encodeURIComponent(String(deviceId))}`;

  async function fetchFromPhone(path) {
    const response = await axios.get(`${targetBase}${path}`, {
      timeout: 8000,
      headers: { "x-pulse-api-key": relayApiKey },
    });
    return response.data;
  }

  function unreachableMessage() {
    return `Could not reach relay ${relayUrl} (device "${deviceId}"). Make sure that relay is running and the device ID/API key you provided are correct.`;
  }

  function getTodayGitCommits() {
    return "Not available in hosted mode - this tool reads local git history from the machine running the MCP server, which has no meaning for a shared remote service.";
  }

  async function fetchDeviceList() {
    const response = await axios.get(`${String(relayUrl).replace(/\/$/, "")}/devices`, {
      timeout: 8000,
      headers: { "x-pulse-api-key": relayApiKey },
    });
    return response.data.devices;
  }

  // Stateless: a fresh Server + transport per request, scoped to this
  // caller's own relay config. Nothing here is retained after the response.
  const server = createPulseServer({ fetchFromPhone, unreachableMessage, getTodayGitCommits, fetchDeviceList });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal error handling MCP request." });
    }
  }
});

app.listen(PORT, () => {
  console.log(`pulse-mcp hosted server listening on port ${PORT}`);
});
