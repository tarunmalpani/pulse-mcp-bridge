/**
 * PulseMCP Mobile Bridge Server
 * ------------------------------
 * Drop this file into your existing React Native / Expo app (e.g. src/pulseServer.js)
 * and call `startPulseServer()` once, early in your app's lifecycle (e.g. in App.tsx
 * after your navigation container mounts), so the IDE-side MCP tool can reach it.
 *
 * Dependencies:
 *   npm install react-native-http-bridge-refurbished react-native-view-shot @react-native-async-storage/async-storage
 *
 * This exposes six routes on port 8080:
 *   GET /status     -> current battery level, active route, platform info, and connectedAt timestamp
 *   GET /logs       -> recent captured structured log entries (see recordLog below)
 *   GET /screenshot -> live screenshot of the current screen (base64 PNG)
 *   GET /session    -> the current bug-report step recording, if any (see recordStep below)
 *   GET /reports    -> all saved bug reports (auto-snapshotted every time recording stops)
 *   GET /crashes    -> automatically captured crashes (uncaught exceptions, render errors,
 *                      unhandled promise rejections), including any recovered after a restart
 *
 * NOTE: Your phone and your dev machine must be on the same Wi-Fi network.
 * Set MOBILE_PHONE_IP on the MCP server side to this device's local IP.
 */

import { Component } from "react";
import { BridgeServer } from "react-native-http-bridge-refurbished";
import { Platform, SafeAreaView, Text, TouchableOpacity } from "react-native";
import DeviceInfo from "react-native-device-info"; // npm install react-native-device-info
import { captureScreen } from "react-native-view-shot"; // npm install react-native-view-shot
import AsyncStorage from "@react-native-async-storage/async-storage"; // npm install @react-native-async-storage/async-storage

const PORT = 8080;

/**
 * DeviceInfo.getBatteryLevel() returns -1 on the iOS Simulator (unsupported
 * there by design), which would otherwise render as "-100%". Real devices
 * always report 0-1, so any negative reading is treated as simulator/unknown
 * and clamped to a plausible placeholder instead of going negative.
 */
function formatBatteryLevel(level) {
  if (typeof level !== "number" || level < 0) return "100%";
  return `${Math.round(level * 100)}%`;
}

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

// --- Breadcrumbs ------------------------------------------------------------
// A running trail of "what was the user doing" (navigation, network calls),
// built up automatically with no developer action required. Unlike
// recordStep(), which only captures anything while a bug-report recording is
// active, this always runs - so even a crash nobody was "recording" still
// gets real context: the last N things that happened right before it.

const MAX_BREADCRUMBS = 20;
const breadcrumbs = [];

function addBreadcrumb(type, message) {
  breadcrumbs.push({ type, message, timestamp: new Date().toISOString() });
  if (breadcrumbs.length > MAX_BREADCRUMBS) {
    breadcrumbs.shift();
  }
}

/** The most recent breadcrumbs, oldest first - i.e. in the order they happened. */
export function getBreadcrumbs() {
  return breadcrumbs;
}

export function setCurrentRoute(routeName) {
  if (routeName === currentRouteName) return;
  currentRouteName = routeName;
  addBreadcrumb("navigation", `Navigated to ${routeName}`);
}

// Wraps the app's real fetch calls so every network request/response becomes
// a breadcrumb automatically - no recordLog() call needed at each call site.
// This is what answers "which API call failed right before the crash"
// without a developer having had to instrument that specific call in advance.
// Metro's own dev-tooling (source map symbolication, etc.) also calls fetch
// against localhost - that's noise, not the app's own network activity, and
// won't exist at all in a production build, so it's excluded here rather
// than showing up alongside real API calls.
function isDevToolingUrl(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);
}

if (typeof global !== "undefined" && typeof global.fetch === "function") {
  const originalFetch = global.fetch;
  global.fetch = async function patchedFetch(input, init) {
    const method = (init?.method || "GET").toUpperCase();
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const startedAt = Date.now();
    try {
      const response = await originalFetch(input, init);
      const durationMs = Date.now() - startedAt;
      if (!isDevToolingUrl(url)) {
        addBreadcrumb("network", `${method} ${url} -> ${response.status} in ${durationMs}ms`);
      }
      return response;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (!isDevToolingUrl(url)) {
        addBreadcrumb("network", `${method} ${url} -> failed after ${durationMs}ms (${error?.message ?? error})`);
      }
      throw error;
    }
  };
}

// --- Crash capture --------------------------------------------------------
// Unlike recordLog (which only fires when your own code calls it), this
// catches *uncaught* JS exceptions anywhere in the app automatically - no
// developer action required at the moment of the crash.

const MAX_CRASHES = 20;
const crashes = [];
let crashIdCounter = 0;

/**
 * Every persisted crash gets its own AsyncStorage key (rather than one key
 * holding a JSON array) so a write never needs to read-then-write the
 * previous value first - if the JS engine dies moments after a crash, we
 * don't want two near-simultaneous crashes racing on the same key.
 */
const PENDING_CRASH_KEY_PREFIX = "@pulse-mcp/pending-crash/";

function persistCrash(crash) {
  // Fire-and-forget: this call must happen before anything else in
  // captureCrash, since if the JS engine is going to die because of this
  // crash, it could die at any point after we return. AsyncStorage.setItem
  // dispatches the write to native immediately, which is what lets the data
  // survive even if the JS side doesn't live long enough to see the promise
  // resolve.
  AsyncStorage.setItem(`${PENDING_CRASH_KEY_PREFIX}${crash.id}-${Date.now()}`, JSON.stringify(crash)).catch(() => {});
}

function captureCrash(error, isFatal, extra = {}) {
  crashIdCounter += 1;
  const crash = {
    id: crashIdCounter,
    timestamp: new Date().toISOString(),
    isFatal: !!isFatal,
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
    componentStack: extra.componentStack ?? null,
    source: extra.source ?? "uncaught-exception",
    device: getDeviceSnapshot(),
    breadcrumbs: [...breadcrumbs],
  };
  persistCrash(crash);
  crashes.unshift(crash);
  if (crashes.length > MAX_CRASHES) {
    crashes.length = MAX_CRASHES;
  }
  console.log(`[PulseMCP] Crash captured (isFatal=${crash.isFatal}, source=${crash.source}): ${crash.message}`);
  return crash;
}

/**
 * Debug helper for verifying persistence directly (Task A4 confirmation) -
 * A5 will use this same prefix to flush pending crashes into getCrashes()
 * on the next app launch instead of just inspecting them.
 */
export async function debugListPersistedCrashKeys() {
  const allKeys = await AsyncStorage.getAllKeys();
  return allKeys.filter((k) => k.startsWith(PENDING_CRASH_KEY_PREFIX));
}

/** All captured crashes, most recent first. */
export function getCrashes() {
  return crashes;
}

/**
 * Runs once at module load (i.e. on every app launch, including the first
 * launch after a crash that killed the whole process). Any crash that was
 * persisted by persistCrash() but never got read back into `crashes` -
 * because the app died before this same session could do it - is restored
 * here, tagged as recovered, then removed from disk so it isn't flushed
 * again on the next launch too.
 */
async function flushPendingCrashesFromDisk() {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const pendingKeys = allKeys.filter((k) => k.startsWith(PENDING_CRASH_KEY_PREFIX));
    if (pendingKeys.length === 0) return;

    const entries = await AsyncStorage.multiGet(pendingKeys);
    const recovered = entries
      .map(([, value]) => {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Re-assign fresh ids rather than keeping the ones from the previous
    // session - crashIdCounter resets to 0 on every launch, so a recovered
    // crash's old id could otherwise collide with one captured live in this
    // session (both starting from 1), which shows up as a React "duplicate
    // key" warning wherever crashes are rendered as a list.
    for (const crash of recovered) {
      crashIdCounter += 1;
      crashes.unshift({ ...crash, id: crashIdCounter, recoveredFromDisk: true });
    }
    if (crashes.length > MAX_CRASHES) {
      crashes.length = MAX_CRASHES;
    }

    await AsyncStorage.multiRemove(pendingKeys);
    console.log(`[PulseMCP] Flushed ${recovered.length} pending crash(es) persisted from a previous session`);
  } catch (e) {
    console.log(`[PulseMCP] Failed to flush pending crashes from disk: ${e?.message}`);
  }
}

flushPendingCrashesFromDisk();

/**
 * Manually report a crash caught outside the global JS handler - e.g. from a
 * React ErrorBoundary (render-time crashes) or a promise-rejection tracker.
 * @param {Error} error
 * @param {{ isFatal?: boolean, componentStack?: string, source?: string }} [options]
 */
export function recordCrash(error, options = {}) {
  return captureCrash(error, options.isFatal ?? false, options);
}

/**
 * Wrap your app's root component with this to catch crashes during React's
 * render phase - the one failure path that ErrorUtils and the promise
 * rejection tracker below can't see, since it happens inside React's own
 * reconciler rather than as a normal thrown/rejected JS value.
 *
 *   import { PulseCrashBoundary } from "./pulseServer";
 *   export default function Root() {
 *     return <PulseCrashBoundary><App /></PulseCrashBoundary>;
 *   }
 *
 * On catching a crash it reports it (tagged source: "render-error-boundary")
 * and shows a minimal fallback screen with a Reset button, rather than
 * leaving the app fully torn down.
 */
export class PulseCrashBoundary extends Component {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error, info) {
    recordCrash(error, {
      isFatal: false,
      componentStack: info.componentStack,
      source: "render-error-boundary",
    });
  }

  render() {
    if (this.state.crashed) {
      return (
        <SafeAreaView style={{ flex: 1, backgroundColor: "#0B0D12", justifyContent: "center", padding: 24 }}>
          <Text style={{ color: "#F87171", fontSize: 20, fontWeight: "700", marginBottom: 8 }}>
            App crashed while rendering
          </Text>
          <Text style={{ color: "#9CA3AF", fontSize: 14, marginBottom: 20 }}>
            Captured automatically - query get_mobile_crash_logs to see the full stack trace.
          </Text>
          <TouchableOpacity
            style={{ backgroundColor: "#4F46E5", borderRadius: 10, paddingVertical: 12, alignItems: "center" }}
            onPress={() => this.setState({ crashed: false })}
          >
            <Text style={{ color: "#fff", fontWeight: "700" }}>Reset</Text>
          </TouchableOpacity>
        </SafeAreaView>
      );
    }
    return this.props.children;
  }
}

// Registered at module load time (not inside startPulseServer) so crashes
// are captured even before the bridge server has started listening.
if (typeof global !== "undefined" && global.ErrorUtils) {
  const previousHandler = global.ErrorUtils.getGlobalHandler();
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    captureCrash(error, isFatal, { source: "uncaught-exception" });
    if (previousHandler) previousHandler(error, isFatal);
  });
}

// Promise rejections that nobody .catch()'d never reach ErrorUtils or an
// ErrorBoundary - they're a third, separate failure path (e.g. an async
// network call that rejects with no error handling anywhere in the chain).
// Hermes (RN's default JS engine) exposes its own tracker for this; engines
// without Hermes (e.g. JSC) fall back to the `promise` package's tracker,
// which ships as a transitive dependency of react-native itself.
function handleUnhandledRejection(error) {
  captureCrash(error instanceof Error ? error : new Error(String(error)), false, {
    source: "unhandled-promise-rejection",
  });
}

if (typeof global !== "undefined" && global.HermesInternal?.enablePromiseRejectionTracker) {
  global.HermesInternal.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (id, error) => handleUnhandledRejection(error),
    onHandled: () => {},
  });
} else {
  try {
    // eslint-disable-next-line global-require
    const rejectionTracking = require("promise/setimmediate/rejection-tracking");
    rejectionTracking.enable({
      allRejections: true,
      onUnhandled: (id, error) => handleUnhandledRejection(error),
      onHandled: () => {},
    });
  } catch {
    // Neither tracker is available in this environment - unhandled promise
    // rejections simply won't be captured, but everything else still works.
  }
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
      batteryLevel: formatBatteryLevel(batteryLevel),
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
    lastKnownBatteryLevel = formatBatteryLevel(batteryLevel);
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

  server.get("/crashes", (request, response) => {
    response.json({ crashes });
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
 *     startPulseServer, setCurrentRoute, recordLog, PulseCrashBoundary,
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
 *   // Crash capture is otherwise fully automatic (uncaught exceptions and
 *   // unhandled promise rejections need zero wiring), EXCEPT render-phase
 *   // crashes, which only PulseCrashBoundary can see - wrap your root once:
 *   export default function Root() {
 *     return <PulseCrashBoundary><App /></PulseCrashBoundary>;
 *   }
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
