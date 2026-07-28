#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import { execSync } from "child_process";

const PHONE_IP = process.env.MOBILE_PHONE_IP || "192.168.1.50";
const PHONE_URL = `http://${PHONE_IP}:8080`;

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

const server = new Server(
  {
    name: "pulse-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_mobile_device_status",
        description:
          "Fetches active mobile device battery level, current route/screen name, OS version, app version/build number, and platform telemetry from the running mobile app.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_mobile_app_logs",
        description:
          "Retrieves recent structured console logs and network errors captured in the running mobile app's state. Optionally filter by level.",
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "string",
              enum: ["info", "success", "error"],
              description: "Only return logs at this level. Omit to return all logs.",
            },
          },
        },
      },
      {
        name: "check_mobile_connection",
        description:
          "Checks whether the mobile bridge is reachable and returns a friendly human-readable connection summary plus the raw device status.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "diagnose_mobile_error",
        description:
          "Finds the most recent error-level log entry captured on the device and returns a structured diagnosis with a likely cause and suggested fix.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_standup_snapshot",
        description:
          "Combines the live mobile device status with today's local Git commit log into a single structured standup summary.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_mobile_screenshot",
        description:
          "Captures and returns a live screenshot of whatever screen is currently showing on the running mobile app.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_bug_report",
        description:
          "Retrieves the numbered sequence of steps a tester recorded on the device (via a Start/Stop Recording toggle in the app), for reproducing and diagnosing a bug without a manual writeup.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_saved_bug_reports",
        description:
          "Lists all bug reports previously saved on the device (one auto-saved every time Stop Recording is tapped), each with its full steps, logs, and device info snapshot.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
    ],
  };
});

/** Wraps a GET request to the mobile bridge with a short timeout. */
async function fetchFromPhone(path) {
  const response = await axios.get(`${PHONE_URL}${path}`, { timeout: 3000 });
  return response.data;
}

function unreachableResponse() {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Mobile device at ${PHONE_URL} is unreachable. Make sure the app is running and on the same Wi-Fi.`,
      },
    ],
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === "get_mobile_device_status") {
      const status = await fetchFromPhone("/status");
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    if (name === "get_mobile_app_logs") {
      const { logs } = await fetchFromPhone("/logs");
      const filtered = args.level
        ? logs.filter((entry) => entry.level === args.level)
        : logs;
      return {
        content: [
          { type: "text", text: JSON.stringify({ logs: filtered }, null, 2) },
        ],
      };
    }

    if (name === "check_mobile_connection") {
      const status = await fetchFromPhone("/status");
      const platformLabel =
        status.platform === "ios" ? "iOS" : status.platform === "android" ? "Android" : status.platform;
      const summary = `✅ Connected to ${platformLabel} device (${platformLabel} ${status.osVersion}) — app v${status.appVersion} (build ${status.buildNumber}), battery ${status.batteryLevel}, screen: ${status.activeRoute}`;
      return {
        content: [
          { type: "text", text: summary },
          { type: "text", text: JSON.stringify(status, null, 2) },
        ],
      };
    }

    if (name === "diagnose_mobile_error") {
      const { logs } = await fetchFromPhone("/logs");
      const errorEntry = [...logs].reverse().find((entry) => entry.level === "error");

      if (!errorEntry) {
        return {
          content: [
            {
              type: "text",
              text: "No errors recorded. No log entry with level 'error' was found on the device.",
            },
          ],
        };
      }

      const message = errorEntry.message || "";
      let likelyCause = "unknown";
      let suggestion = "inspect the message and device state below for clues";

      if (/timeout/i.test(message)) {
        likelyCause = "network timeout";
        suggestion = "network timeout — check connectivity or API responsiveness";
      } else if (/404/.test(message)) {
        likelyCause = "endpoint not found";
        suggestion = "endpoint not found — check the URL/route";
      } else if (/enotfound|dns/i.test(message)) {
        likelyCause = "DNS/host resolution failure";
        suggestion = "DNS/host resolution failure";
      } else if (/network/i.test(message) || /fetch/i.test(message)) {
        likelyCause = "network request failed";
        suggestion = "network request failed";
      } else {
        likelyCause = "unclear from message alone";
      }

      const diagnosis = {
        found: true,
        errorMessage: errorEntry.message,
        source: errorEntry.source,
        occurredAt: errorEntry.timestamp,
        device: errorEntry.device,
        likelyCause,
        suggestion,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(diagnosis, null, 2) }],
      };
    }

    if (name === "get_mobile_screenshot") {
      const { image, mimeType } = await fetchFromPhone("/screenshot");
      return {
        content: [{ type: "image", data: image, mimeType }],
      };
    }

    if (name === "get_bug_report") {
      const session = await fetchFromPhone("/session");
      if (!session.steps || session.steps.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: session.recording
                ? "Recording is active but no steps have been captured yet."
                : "No bug report recorded. Tap 'Start Recording' in the app, reproduce the issue, then tap 'Stop Recording'.",
            },
          ],
        };
      }
      const lastStep = session.steps[session.steps.length - 1];
      const looksLikeFailure = /error|fail|fatal|exception/i.test(
        lastStep.description
      );
      const status = await fetchFromPhone("/status").catch(() => null);
      const report = {
        recording: session.recording,
        totalSteps: session.steps.length,
        steps: session.steps,
        likelyFailurePoint: looksLikeFailure ? lastStep : null,
        deviceContext: status
          ? {
              platform: status.platform,
              osVersion: status.osVersion,
              appVersion: status.appVersion,
              buildNumber: status.buildNumber,
            }
          : null,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
      };
    }

    if (name === "get_saved_bug_reports") {
      const { reports } = await fetchFromPhone("/reports");
      if (!reports || reports.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No saved bug reports yet. Reports are auto-saved every time 'Stop Recording' is tapped in the app.",
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ reports }, null, 2) }],
      };
    }

    if (name === "get_standup_snapshot") {
      const status = await fetchFromPhone("/status");
      const commits = getTodayGitCommits();
      const snapshot = {
        mobileDeviceStatus: status,
        todayGitCommits: commits,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
      };
    }

    return {
      isError: true,
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
    };
  } catch (err) {
    return unreachableResponse();
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error running pulse-mcp server:", err);
  process.exit(1);
});
