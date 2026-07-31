# pulse-mcp-bridge

An MCP (Model Context Protocol) server that bridges your IDE to a running React Native / Expo mobile app on your local Wi-Fi network, so tools like Claude Code or Cursor can pull live device status, app logs, automatically-captured crashes (with stack traces and breadcrumbs, no manual instrumentation required), and a combined standup snapshot (device status + today's git commits).

## How it fits together

```
IDE (MCP client) <--stdio--> pulse-mcp (index.js) <--HTTP--> mobile app (mobile-app-server.js)
                                                         or  <--HTTP--> mock-phone.js (for local testing)
```

## Setup

```bash
npm install
```

### 1. Try it locally with the mock phone (no device needed)

In one terminal, start the mock phone server:

```bash
node mock-phone.js
```

This listens on `http://localhost:8080` and fakes `/status` and `/logs` responses.

### 2. Register the MCP server with your IDE

See `mcp-config.example.json` for ready-to-paste config blocks for Cursor, Claude Desktop, and Windsurf. Point `MOBILE_PHONE_IP` at:

- `127.0.0.1` when testing against `mock-phone.js`
- your phone's local IP (e.g. `192.168.1.50`) when testing against a real device

### 3. Wire up the real mobile app

`index.js` (the MCP server) is generic and reusable as-is — it never needs to change per app. The only thing that changes per app is `mobile-app-server.js`, the tiny HTTP bridge that runs *inside* the app.

**Setup, once per new app:**

1. **Copy the bridge file** into the target app, e.g. as `src/pulseServer.js`:
   ```bash
   cp mobile-app-server.js /path/to/your-app/src/pulseServer.js
   ```
2. **Install its native dependencies** in that app:
   ```bash
   npx expo install react-native-http-bridge-refurbished react-native-device-info react-native-view-shot @react-native-async-storage/async-storage
   ```
   These are native modules — if the app runs on plain Expo Go, you'll need a dev-client build instead (`npx expo prebuild` then `npx expo run:ios` / `npx expo run:android`).
3. **Wire it into `App.tsx`**:
   ```js
   import { startPulseServer, setCurrentRoute, recordLog } from "./pulseServer";

   useEffect(() => {
     if (__DEV__) startPulseServer();
   }, []);

   // On navigation change:
   setCurrentRoute(routeName);

   // Anywhere in the app:
   recordLog("Synced dashboard data", "success", "SyncService");
   recordLog(`Network request failed: ${error.message}`, "error", "NetworkClient");
   ```
   Add the bug-report recording hooks too if you want `get_bug_report` / `get_saved_bug_reports` — see "Bug-report step recording" below.

   Crash capture needs no extra wiring at all beyond `startPulseServer()` — see "Automatic crash capture" below.
4. **Same Wi-Fi network** — your phone/emulator and dev machine must be on the same Wi-Fi network (or use `127.0.0.1` for the iOS Simulator, which shares the Mac's own network stack).
5. **Point your MCP config at this device**: set `MOBILE_PHONE_IP` (in your IDE's MCP config, see `mcp-config.example.json`) to that device's IP — `127.0.0.1` for Simulator, the phone's LAN IP (e.g. `192.168.1.50`) for a real device.

**Real device notes:**

- **Real iPhone — verified.** This integration has been tested end-to-end against a real Expo/React Native app on a real iPhone, including a live crash scenario — the bridge correctly goes unreachable when the app stops responding. iOS 14+ will prompt for a one-time **"Local Network" permission** the first time the app starts the bridge server — the user must tap Allow, or the bridge will be unreachable.
- **Real Android — not yet verified**, though it should work in principle (`react-native-http-bridge-refurbished` supports Android too). Android 9+ blocks plaintext HTTP by default, so you'll likely need `android:usesCleartextTraffic="true"` in `AndroidManifest.xml` for local dev builds, or the bridge will silently fail to connect.
- **Android emulator**: since it's NAT'd and can't be reached directly, use `127.0.0.1` plus `adb forward tcp:8080 tcp:8080`.

## Available MCP tools

| Tool | Description |
|---|---|
| `get_mobile_device_status` | Battery level, active route/screen, OS/platform, and `connectedAt` from the running app |
| `get_mobile_app_logs` | Recent structured log entries (`{ id, timestamp, level, source, message, device }`) captured in the app; optionally filter by `level` (info/success/error) |
| `check_mobile_connection` | Pings `/status` and returns a friendly human-readable connection summary plus the raw status JSON, or a clean unreachable error |
| `diagnose_mobile_error` | Diagnoses the most recent problem, preferring a captured crash (with its real stack trace and breadcrumbs) over a plain log message when both exist. Returns a structured `likelyCause`/`suggestion`, plus `topStackFrames`, `componentStack`, and `breadcrumbsBeforeCrash` when the diagnosis came from a crash |
| `get_standup_snapshot` | Combines live device status with today's local git commits (falls back gracefully outside a git repo) |
| `get_mobile_screenshot` | Live screenshot of whatever screen is currently showing on the app, returned as an inline image |
| `get_bug_report` | The current/live step recording (see below) plus device context, for reproducing a bug in progress |
| `get_saved_bug_reports` | All bug reports auto-saved on the device, each with its full steps, logs, and device info snapshot |
| `get_mobile_crash_logs` | All crashes automatically captured on the device (see "Automatic crash capture" below), each with a stack trace, breadcrumb trail, and a best-guess `likelyCause`/`suggestion` |

### Bug-report step recording

Wire a "Start/Stop Recording" toggle in your app to `startSessionRecording()` / `stopSessionRecording()`, and call `recordStep(...)` at any point worth capturing (button taps, network results, errors). When recording stops, a complete report — numbered steps, full logs, and a device/build info snapshot — is auto-saved and instantly queryable via `get_bug_report` / `get_saved_bug_reports`. No manual "steps to reproduce" writeup needed.

### Automatic crash capture

Unlike bug-report recording, this needs **no toggle and no manual `recordLog`/`recordStep` calls at all** — it's live the moment `startPulseServer()` runs, and catches three distinct failure paths that would otherwise vanish without a trace:

| Failure path | Caught by | `source` value |
|---|---|---|
| Uncaught exception in an event handler or async code | `ErrorUtils.setGlobalHandler` | `uncaught-exception` |
| A crash during React's render phase | A root `ErrorBoundary` | `render-error-boundary` |
| A rejected promise nobody `.catch()`'d | Hermes's rejection tracker (falls back to the `promise` package on JSC) | `unhandled-promise-rejection` |

Every crash automatically includes a **breadcrumb trail** — the last ~20 things that happened right before it, built with zero developer effort:
- every navigation change (from `setCurrentRoute()`)
- every `fetch()` call your app makes, success or failure (`global.fetch` is patched transparently; requests to `localhost`/Metro's own dev tooling are excluded)

**Crashes survive the app dying.** The instant a crash is captured, it's written to `AsyncStorage` before anything else runs. If the crash kills the whole JS engine before the in-memory list or an HTTP request could reflect it, it's recovered automatically the next time the app launches (tagged `recoveredFromDisk: true`) and cleared from disk so it isn't re-flushed again.

This is what makes `get_mobile_crash_logs`/`diagnose_mobile_error` answer *"why did my app crash"* for a crash that happened five minutes ago and killed the app, not just one you're actively watching for.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MOBILE_PHONE_IP` | `192.168.1.50` | IP address of the phone/mock server running the HTTP bridge |
