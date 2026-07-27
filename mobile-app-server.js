/**
 * PulseMCP Mobile Bridge Server
 * ------------------------------
 * Drop this file into your existing React Native / Expo app (e.g. src/pulseServer.js)
 * and call `startPulseServer()` once, early in your app's lifecycle (e.g. in App.tsx
 * after your navigation container mounts), so the IDE-side MCP tool can reach it.
 *
 * Dependency:
 *   npm install react-native-http-bridge-refurbished
 *
 * This exposes two routes on port 8080:
 *   GET /status  -> current battery level, active route, and platform info
 *   GET /logs    -> recent captured console logs / network errors
 *
 * NOTE: Your phone and your dev machine must be on the same Wi-Fi network.
 * Set MOBILE_PHONE_IP on the MCP server side to this device's local IP.
 */

import httpBridge from "react-native-http-bridge-refurbished";
import { Platform } from "react-native";
import DeviceInfo from "react-native-device-info"; // npm install react-native-device-info

const PORT = 8080;

// --- In-memory app state -----------------------------------------------
// Wire these up to your real navigation/logging system.

/** Update this whenever your navigation state changes (e.g. in onStateChange). */
let currentRouteName = "Unknown";

/** Ring buffer of recent logs. Push into this from your logger / error boundary. */
const MAX_LOGS = 100;
const recentLogs = [];

export function recordLog(entry) {
  recentLogs.push(`[${new Date().toISOString()}] ${entry}`);
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.shift();
  }
}

export function setCurrentRoute(routeName) {
  currentRouteName = routeName;
}

// --- Server bootstrap ----------------------------------------------------

export function startPulseServer() {
  httpBridge.start(PORT, "pulse_mcp_service", async (request, response) => {
    const { url, type } = request;

    if (type !== "GET") {
      httpBridge.respond(response, 405, "application/json", {
        error: "Method not allowed",
      });
      return;
    }

    if (url === "/status" || url.startsWith("/status?")) {
      const batteryLevel = await DeviceInfo.getBatteryLevel();
      const payload = {
        status: "online",
        batteryLevel: `${Math.round(batteryLevel * 100)}%`,
        platform: Platform.OS,
        activeRoute: currentRouteName,
      };
      httpBridge.respond(response, 200, "application/json", payload);
      return;
    }

    if (url === "/logs" || url.startsWith("/logs?")) {
      httpBridge.respond(response, 200, "application/json", {
        logs: recentLogs,
      });
      return;
    }

    httpBridge.respond(response, 404, "application/json", {
      error: "Not found",
    });
  });

  console.log(`PulseMCP bridge listening on http://0.0.0.0:${PORT}`);
}

/**
 * Example integration in App.tsx:
 *
 *   import { startPulseServer, setCurrentRoute, recordLog } from "./pulseServer";
 *
 *   useEffect(() => {
 *     if (__DEV__) startPulseServer();
 *   }, []);
 *
 *   <NavigationContainer onStateChange={(state) => {
 *     const routeName = state?.routes[state.index]?.name;
 *     if (routeName) setCurrentRoute(routeName);
 *   }}>
 *
 *   // Anywhere you catch an error or log a network failure:
 *   recordLog(`[Network Error] ${error.message}`);
 */
