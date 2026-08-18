#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import axios from "axios";
import { execSync } from "child_process";
import { createPulseServer } from "./lib/mcpToolServer.js";

const PHONE_IP = process.env.MOBILE_PHONE_IP || "192.168.1.50";
const PHONE_URL = `http://${PHONE_IP}:8080`;

// Optional remote/cross-network mode: when PULSE_RELAY_URL is set, talk to the
// hosted relay (see relay-server/) instead of the phone directly over LAN.
// This lets the phone and this MCP server be on entirely different networks.
const PULSE_RELAY_URL = process.env.PULSE_RELAY_URL;
const PULSE_API_KEY = process.env.PULSE_API_KEY;
const PULSE_DEVICE_ID = process.env.PULSE_DEVICE_ID;

const TARGET_BASE_URL = PULSE_RELAY_URL ? `${PULSE_RELAY_URL}/devices/${PULSE_DEVICE_ID}` : PHONE_URL;
const TARGET_DESCRIPTION = PULSE_RELAY_URL
  ? `relay ${PULSE_RELAY_URL} (device "${PULSE_DEVICE_ID}")`
  : `phone at ${PHONE_URL}`;

/**
 * Returns today's local commits authored by the current git user.
 * Falls back to a friendly message when not in a git repo or git is unavailable.
 */
function getTodayGitCommits() {
  try {
    const authorName = execSync('git config user.name', {
      encoding: "utf8",
    }).trim();
    const log = execSync(
      `git log --author="${authorName}" --since="00:00:00" --oneline`,
      { encoding: "utf8" }
    ).trim();
    return log.length > 0 ? log : "No commits found for today.";
  } catch (err) {
    return "No git commits found today or not in a git repo.";
  }
}

/** Wraps a GET request to the mobile bridge (or relay, in remote mode) with a short timeout. */
async function fetchFromPhone(path) {
  const headers = PULSE_RELAY_URL ? { "x-pulse-api-key": PULSE_API_KEY } : undefined;
  const response = await axios.get(`${TARGET_BASE_URL}${path}`, { timeout: 3000, headers });
  return response.data;
}

function unreachableMessage() {
  return PULSE_RELAY_URL
    ? `Could not reach ${TARGET_DESCRIPTION}. Make sure the relay is running and the device ID/API key are correct.`
    : `Mobile device at ${PHONE_URL} is unreachable. Make sure the app is running and on the same Wi-Fi.`;
}

/** Lists all devices known to the relay. Only meaningful in relay mode - there's no equivalent concept when talking directly to one phone over LAN. */
async function fetchDeviceList() {
  if (!PULSE_RELAY_URL) return null;
  const response = await axios.get(`${PULSE_RELAY_URL}/devices`, {
    timeout: 3000,
    headers: { "x-pulse-api-key": PULSE_API_KEY },
  });
  return response.data.devices;
}

const server = createPulseServer({
  fetchFromPhone,
  unreachableMessage,
  getTodayGitCommits,
  fetchDeviceList: PULSE_RELAY_URL ? fetchDeviceList : undefined,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error running pulse-mcp server:", err);
  process.exit(1);
});
