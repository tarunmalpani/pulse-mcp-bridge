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
          "Fetches active mobile device battery level, current route/screen name, and OS/platform telemetry from the running mobile app.",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_mobile_app_logs",
        description:
          "Retrieves recent console logs and network errors captured in the running mobile app's state.",
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
  const { name } = request.params;

  try {
    if (name === "get_mobile_device_status") {
      const status = await fetchFromPhone("/status");
      return {
        content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
      };
    }

    if (name === "get_mobile_app_logs") {
      const logs = await fetchFromPhone("/logs");
      return {
        content: [{ type: "text", text: JSON.stringify(logs, null, 2) }],
      };
    }

    if (name === "get_mobile_screenshot") {
      const { image, mimeType } = await fetchFromPhone("/screenshot");
      return {
        content: [{ type: "image", data: image, mimeType }],
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
