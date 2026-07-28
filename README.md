# pulse-mcp-bridge

An MCP (Model Context Protocol) server that bridges your IDE to a running React Native / Expo mobile app on your local Wi-Fi network, so tools like Claude Code or Cursor can pull live device status, app logs, and a combined standup snapshot (device status + today's git commits).

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

Copy `mobile-app-server.js` into your React Native / Expo app (e.g. `src/pulseServer.js`) and follow the integration comments at the top of the file:

```bash
npm install react-native-http-bridge-refurbished react-native-device-info react-native-view-shot
```

Then in `App.tsx`:

```js
import { startPulseServer, setCurrentRoute, recordLog } from "./pulseServer";

useEffect(() => {
  if (__DEV__) startPulseServer();
}, []);

// Anywhere in the app:
recordLog("Synced dashboard data", "success", "SyncService");
recordLog(`Network request failed: ${error.message}`, "error", "NetworkClient");
```

Make sure your phone and dev machine are on the same Wi-Fi network.

**Verified:** this integration has been tested end-to-end against a real Expo/React Native app running on the iOS Simulator (Expo SDK 51 / RN 0.74), including a live crash scenario — the bridge correctly goes unreachable when the app stops responding. Android has not been tested yet.

## Available MCP tools

| Tool | Description |
|---|---|
| `get_mobile_device_status` | Battery level, active route/screen, OS/platform, and `connectedAt` from the running app |
| `get_mobile_app_logs` | Recent structured log entries (`{ id, timestamp, level, source, message, device }`) captured in the app; optionally filter by `level` (info/success/error) |
| `check_mobile_connection` | Pings `/status` and returns a friendly human-readable connection summary plus the raw status JSON, or a clean unreachable error |
| `diagnose_mobile_error` | Finds the most recent `error`-level log and returns a structured diagnosis (`likelyCause`/`suggestion`) derived from the message text |
| `get_standup_snapshot` | Combines live device status with today's local git commits (falls back gracefully outside a git repo) |
| `get_mobile_screenshot` | Live screenshot of whatever screen is currently showing on the app, returned as an inline image |
| `get_bug_report` | The current/live step recording (see below) plus device context, for reproducing a bug in progress |
| `get_saved_bug_reports` | All bug reports auto-saved on the device, each with its full steps, logs, and device info snapshot |

### Bug-report step recording

Wire a "Start/Stop Recording" toggle in your app to `startSessionRecording()` / `stopSessionRecording()`, and call `recordStep(...)` at any point worth capturing (button taps, network results, errors). When recording stops, a complete report — numbered steps, full logs, and a device/build info snapshot — is auto-saved and instantly queryable via `get_bug_report` / `get_saved_bug_reports`. No manual "steps to reproduce" writeup needed.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MOBILE_PHONE_IP` | `192.168.1.50` | IP address of the phone/mock server running the HTTP bridge |
