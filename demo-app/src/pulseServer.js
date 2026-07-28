/**
 * PulseMCP Mobile Bridge Server
 * ------------------------------
 * Drop this file into your existing React Native / Expo app (e.g. src/pulseServer.js)
 * and call `startPulseServer()` once, early in your app's lifecycle (e.g. in App.tsx
 * after your navigation container mounts), so the IDE-side MCP tool can reach it.
 *
 * Dependencies:
 *   npm install react-native-http-bridge-refurbished react-native-view-shot
 *
 * This exposes five routes on port 8080:
 *   GET /status     -> current battery level, active route, platform info, and connectedAt timestamp
 *   GET /logs       -> recent captured structured log entries (see recordLog below)
 *   GET /screenshot -> live screenshot of the current screen (base64 PNG)
 *   GET /session    -> the current bug-report step recording, if any (see recordStep below)
 *   GET /reports    -> all saved bug reports (auto-snapshotted every time recording stops)
 *
 * NOTE: Your phone and your dev machine must be on the same Wi-Fi network.
 * Set MOBILE_PHONE_IP on the MCP server side to this device's local IP.
 */

import { BridgeServer } from "react-native-http-bridge-refurbished";
import { Platform } from "react-native";
import DeviceInfo from "react-native-device-info"; // npm install react-native-device-info
import { captureScreen } from "react-native-view-shot"; // npm install react-native-view-shot

const PORT = 8080;

// --- In-memory app state -----------------------------------------------
// Wire these up to your real navigation/logging system.

/** Update this whenever your navigation state changes (e.g. in onStateChange). */
let currentRouteName = "Unknown";

/**
 * Last-known battery level, refreshed whenever GET /status is polled (or a log is
 * recorded, whichever comes first). Avoids awaiting DeviceInfo.getBatteryLevel() on
 * every single recordLog() call, which would make logging an async operation.
 */
let lastKnownBatteryLevel = null;

/** ISO timestamp set once when startPulseServer() runs. */
let connectedAt = null;

/** Ring buffer of recent logs. Push into this from your logger / error boundary. */
const MAX_LOGS = 100;
const recentLogs = [];
let logIdCounter = 0;

/** Synchronous device snapshot using cached/last-known values (non-blocking). */
function getDeviceSnapshot() {
  return {
    platform: Platform.OS,
    osVersion: DeviceInfo.getSystemVersion(),
    appVersion: DeviceInfo.getVersion(),
    buildNumber: DeviceInfo.getBuildNumber(),
    batteryLevel: lastKnownBatteryLevel ?? "unknown",
    activeRoute: currentRouteName,
  };
}

/**
 * Records a structured log entry.
 * @param {string} message
 * @param {"info"|"success"|"error"} [level="info"]
 * @param {string} [source="App"]
 */
export function recordLog(message, level = "info", source = "App") {
  logIdCounter += 1;
  recentLogs.push({
    id: logIdCounter,
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    device: getDeviceSnapshot(),
  });
  if (recentLogs.length > MAX_LOGS) {
    recentLogs.shift();
  }
}

export function setCurrentRoute(routeName) {
  currentRouteName = routeName;
}

// --- Bug-report step recording -------------------------------------------
// A tester taps "Start Recording", performs the steps that reproduce a bug,
// then taps "Stop Recording". get_bug_report returns the exact numbered
// sequence of what they did, so there's no manual repro-steps writeup.

let isRecording = false;
let sessionSteps = [];
let stepCounter = 0;
const savedReports = [];
let reportIdCounter = 0;

export function isSessionRecording() {
  return isRecording;
}

export function startSessionRecording() {
  isRecording = true;
  sessionSteps = [];
  stepCounter = 0;
  recordLog('[Session] Recording started', 'info', 'Session');
}

/**
 * Stops recording and auto-saves everything captured (steps + full log
 * buffer + a device-info snapshot) as one shareable report. Returns the
 * saved report so the caller can navigate straight to its detail screen.
 */
export async function stopSessionRecording() {
  isRecording = false;
  const batteryLevel = await DeviceInfo.getBatteryLevel().catch(() => -1);
  reportIdCounter += 1;
  const report = {
    id: reportIdCounter,
    stoppedAt: new Date().toISOString(),
    steps: [...sessionSteps],
    logs: [...recentLogs],
    deviceInfo: {
      platform: Platform.OS,
      osVersion: DeviceInfo.getSystemVersion(),
      appVersion: DeviceInfo.getVersion(),
      buildNumber: DeviceInfo.getBuildNumber(),
      batteryLevel: `${Math.round(batteryLevel * 100)}%`,
      activeRoute: currentRouteName,
    },
  };
  savedReports.unshift(report);
  recordLog('[Session] Recording stopped - report saved', 'info', 'Session');
  return report;
}

/** Call alongside recordLog at any point you want captured as a numbered repro step. */
export function recordStep(description) {
  if (!isRecording) return;
  stepCounter += 1;
  sessionSteps.push({
    step: stepCounter,
    description,
    timestamp: new Date().toISOString(),
  });
}

/** All auto-saved reports, most recent first. */
export function getSavedReports() {
  return savedReports;
}

// --- Server bootstrap ----------------------------------------------------

let serverInstance = null;

export function startPulseServer() {
  connectedAt = new Date().toISOString();
  const server = new BridgeServer("pulse_mcp_service", __DEV__);

  server.get("/status", async (request, response) => {
    const batteryLevel = await DeviceInfo.getBatteryLevel();
    lastKnownBatteryLevel = `${Math.round(batteryLevel * 100)}%`;
    response.json({
      status: "online",
      batteryLevel: lastKnownBatteryLevel,
      platform: Platform.OS,
      osVersion: DeviceInfo.getSystemVersion(),
      appVersion: DeviceInfo.getVersion(),
      buildNumber: DeviceInfo.getBuildNumber(),
      activeRoute: currentRouteName,
      connectedAt,
    });
  });

  server.get("/logs", (request, response) => {
    response.json({ logs: recentLogs });
  });

  server.get("/screenshot", async (request, response) => {
    const base64 = await captureScreen({ format: "png", quality: 0.8, result: "base64" });
    response.json({ image: base64, mimeType: "image/png" });
  });

  server.get("/session", (request, response) => {
    response.json({ recording: isRecording, steps: sessionSteps });
  });

  server.get("/reports", (request, response) => {
    response.json({ reports: savedReports });
  });

  server.listen(PORT);
  serverInstance = server;

  console.log(`PulseMCP bridge listening on http://0.0.0.0:${PORT}`);
}

/** Stops the bridge server, e.g. during teardown or a controlled restart. */
export function stopPulseServer() {
  serverInstance?.stop();
  serverInstance = null;
}

/**
 * Example integration in App.tsx:
 *
 *   import {
 *     startPulseServer, setCurrentRoute, recordLog,
 *     startSessionRecording, stopSessionRecording, recordStep, isSessionRecording,
 *   } from "./pulseServer";
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
 *   recordLog(`Network request failed: ${error.message}`, "error", "NetworkClient");
 *   recordLog("Synced dashboard data", "success", "SyncService");
 *
 *   // Bug-report recording - wire a "Start/Stop Recording" toggle to these,
 *   // then call recordStep(...) at any point worth capturing as a repro step:
 *   recordStep("Tapped 'Sync Now' on Dashboard");
 *   recordStep("Sync failed: request timed out after 3000ms");
 */
