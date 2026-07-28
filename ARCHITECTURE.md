    # pulse-mcp-bridge — Technical Architecture

This document explains how the MCP server actually works under the hood: the protocol, the components, the data flow, and every tool/library involved. For setup instructions, see `README.md`.

## What problem this solves

Normally, checking on a running mobile app (its screen, its logs, whether it's alive) means physically looking at the phone, screen-recording it, or pasting logcat/Xcode console output into a chat. `pulse-mcp-bridge` closes that loop: an IDE assistant (Claude Desktop, Cursor, Claude Code) can ask a running React Native app direct questions and get real answers, without anyone touching the phone.

## High-level architecture

```
┌─────────────────┐   stdio (JSON-RPC / MCP)   ┌──────────────┐   HTTP (LAN/Wi-Fi)   ┌──────────────────────┐
│  IDE / MCP host │ ─────────────────────────▶ │  index.js    │ ────────────────────▶│  Mobile app          │
│  (Claude, etc.) │ ◀───────────────────────── │  (MCP server)│ ◀────────────────────│  (mobile-app-        │
└─────────────────┘                            └──────────────┘   port 8080          │   server.js bridge)  │
                                                                                       └──────────────────────┘
```

There are two processes, running on two different machines/devices, connected by two different transports:

1. **`index.js`** — the actual MCP server. Runs on your dev machine (as a child process spawned by the IDE). Speaks MCP over **stdio** to the IDE, and speaks plain **HTTP** out to the phone.
2. **`mobile-app-server.js`** (copied into the React Native app as e.g. `src/pulseServer.js`) — a tiny HTTP server embedded *inside* the running mobile app, listening on port 8080. It exposes the app's internal state (logs, current screen, battery, etc.) as JSON endpoints.

The IDE never talks to the phone directly — it only ever talks to `index.js` via MCP, and `index.js` is the only thing that knows how to reach the phone over HTTP.

## Component 1: the MCP server (`index.js`)

Built with `@modelcontextprotocol/sdk`, the official MCP SDK. Two SDK pieces are used:

- **`Server`** (`@modelcontextprotocol/sdk/server/index.js`) — the core MCP server object. It's told what capabilities it has (`{ tools: {} }`) and given two request handlers.
- **`StdioServerTransport`** (`@modelcontextprotocol/sdk/server/stdio.js`) — wires the `Server` up to `process.stdin`/`process.stdout`. This is what makes it launchable as a subprocess by any MCP-compatible IDE — no network port of its own, no auth needed, because the IDE spawns it directly and owns the pipe.

Two request handlers are registered:

- **`ListToolsRequestSchema`** — returns the tool catalog (name, description, JSON Schema input) so the IDE/model knows what it can call.
- **`CallToolRequestSchema`** — the actual dispatcher. Given a tool name, it runs the corresponding logic and returns a response shaped as `{ content: [...] }` or `{ isError: true, content: [...] }`.

Talking to the phone is done with **`axios`**, wrapped in a small `fetchFromPhone(path)` helper with a **3-second timeout**. If that call throws (phone off, wrong IP, app crashed, Wi-Fi down — anything), the catch block returns a clean `isError: true` response rather than letting the MCP call hang or throw an unhandled exception up to the IDE.

Git commit history (`get_standup_snapshot`) is read with Node's built-in **`child_process.execSync`**, running `git config user.name` then `git log --author=... --since=00:00:00 --oneline`. This is local to the machine running `index.js`, not the phone.

## Component 2: the in-app bridge (`mobile-app-server.js`)

This file is not part of the MCP server process — it's source code meant to be copied into an existing React Native/Expo app and run *inside* that app's own JS engine (Hermes). It uses:

- **`react-native-http-bridge-refurbished`** — the only thing that makes an in-app HTTP server possible at all. Under the hood it's a native module (`GCDWebServer` on iOS) exposed to JS. Two APIs from this library matter:
  - The low-level `httpServer.start/respond` — **do not use this directly** (see "Lessons learned" below, this was a real bug we hit).
  - The high-level **`BridgeServer`** class — `server.get(path, (request, response) => ...)`, `response.json(obj)`, `server.listen(port)`. This is what `mobile-app-server.js` actually uses; it handles request-ID tracking and JSON serialization correctly.
- **`react-native-device-info`** — supplies `getBatteryLevel()`, `getSystemVersion()` (OS version), `getVersion()`/`getBuildNumber()` (app version).
- **`react-native-view-shot`** — supplies `captureScreen({ format, quality, result: 'base64' })`, used for the screenshot tool. Captures whatever is currently on screen, natively, without a ref to any specific view.

### Routes exposed on port 8080

| Route | Returns | Backed by |
|---|---|---|
| `GET /status` | `{ status, batteryLevel, platform, osVersion, appVersion, buildNumber, activeRoute, connectedAt }` | `react-native-device-info` + in-memory `currentRouteName`; `connectedAt` is set once when `startPulseServer()` runs |
| `GET /logs` | `{ logs: [{ id, timestamp, level, source, message, device }, ...] }` | In-memory ring buffer (`recentLogs`, capped at 100 entries), fed by calling `recordLog(message, level, source)` anywhere in the app; each entry carries a synchronous device snapshot (cached battery level, no per-call `DeviceInfo` await) |
| `GET /screenshot` | `{ image: <base64>, mimeType: "image/png" }` | `react-native-view-shot` |
| `GET /session` | `{ recording: bool, steps: [...] }` | In-memory step list, fed by `recordStep(...)`, only active between `startSessionRecording()`/`stopSessionRecording()` |

All in-memory state (`recentLogs`, `sessionSteps`, `currentRouteName`) lives in that one JS module and is lost whenever the app process restarts — there's no persistence to disk. That's a deliberate simplicity tradeoff, not an oversight.

## Component 3: the MCP tools

Each tool is a thin wrapper: fetch one (or two) routes from the phone, reshape the JSON, return it as MCP `content`.

| Tool | What it does | Phone routes hit |
|---|---|---|
| `get_mobile_device_status` | Battery, screen, platform, OS/app version, connectedAt | `GET /status` |
| `get_mobile_app_logs` | Recent structured console/network logs, optionally filtered by `level` (info/success/error) | `GET /logs` |
| `check_mobile_connection` | Friendly human-readable "is it alive" summary plus raw status JSON, or a clean unreachable error | `GET /status` |
| `diagnose_mobile_error` | Finds the most recent `error`-level log entry and derives a `likelyCause`/`suggestion` from the message text (timeout/404/DNS/network heuristics) | `GET /logs` |
| `get_mobile_screenshot` | Live screenshot as an inline image | `GET /screenshot` — returned as an MCP `image` content block (not text) |
| `get_standup_snapshot` | Device status + today's git commits combined | `GET /status` + local `git log` |
| `get_bug_report` | Numbered repro-steps sequence + likely failure point + device context | `GET /session` + `GET /status` |

`get_bug_report` is the most composed tool: it fetches the step recording, finds the last step, checks it against `/error|fail|fatal|exception/i` to guess where things broke, and merges in device/build info from `/status` — all without the tester having to write up "steps to reproduce" by hand.

`diagnose_mobile_error` is similar in spirit but works off structured logs instead of step recordings: it walks `/logs` backwards for the newest `level: "error"` entry, then pattern-matches the message text (`/timeout/i`, `/404/`, `ENOTFOUND`/DNS, `/network|fetch/i`) to suggest a likely cause, falling back to "inspect the message and device state below for clues" when nothing matches.

## End-to-end request lifecycle (example: `get_mobile_device_status`)

1. User asks the IDE something like *"is my app alive?"*
2. The model decides to call the `get_mobile_device_status` tool.
3. IDE sends a `tools/call` JSON-RPC message over stdin to the running `index.js` process.
4. `index.js`'s `CallToolRequestSchema` handler matches the tool name, calls `fetchFromPhone("/status")`.
5. `axios` sends `GET http://<MOBILE_PHONE_IP>:8080/status` over the LAN/Wi-Fi.
6. Inside the phone's JS engine, the `BridgeServer` instance matches the route, calls `DeviceInfo.getBatteryLevel()` (native call), builds the JSON, calls `response.json(...)`.
7. That response travels back over HTTP, gets parsed by `axios`, returned to the tool handler.
8. `index.js` wraps it as `{ content: [{ type: "text", text: JSON.stringify(status, null, 2) }] }` and writes it to stdout.
9. IDE reads the JSON-RPC response, hands the result back to the model, which turns it into a natural-language answer for the user.

If step 5 fails (phone unreachable), step 8 instead returns `isError: true` with a human-readable message — this is what makes the crash-detection demo work: the tool doesn't hang, it reports failure cleanly and immediately.

## Connectivity requirements

- Phone and dev machine must be on the **same Wi-Fi network** (or, for Simulator testing, the Simulator shares the Mac's own network stack, so `127.0.0.1` works directly).
- `MOBILE_PHONE_IP` (env var read by `index.js`) must point at wherever the bridge is actually listening — `127.0.0.1` for Simulator, the phone's LAN IP for a real device, `127.0.0.1` + `adb forward tcp:8080 tcp:8080` for an Android emulator (NAT'd, can't be reached directly).
- **Real iOS devices**: iOS 14+ will prompt the user for a one-time "Local Network" permission the first time the app starts a local server like this.
- **Real Android devices**: Android 9+ blocks plaintext HTTP by default; local dev builds usually need `android:usesCleartextTraffic="true"` in the manifest.
- No authentication or encryption exists on the port 8080 bridge — it's designed for trusted local dev networks only, never for exposing over the public internet.

## Lessons learned this session (real bugs, not hypothetical)

1. **Wrong API usage crashed the native bridge on every request.** The original `mobile-app-server.js` used the low-level `httpBridge.start/respond` API assuming an Express-style `(request, response)` callback that doesn't exist at that level — only a single `request` object is passed, and `respond()` needs a `requestId` string plus a JSON *string* body, not a raw object. This threw a real native `NSException` (`key cannot be nil`) on every call. Fixed by switching to the library's `BridgeServer` class, which handles all of this correctly. Verified against a real Expo build on the iOS Simulator.
2. **Native module version mismatches.** `react-native-view-shot` and `expo-clipboard` both needed versions matched to the project's Expo SDK (installed via `npx expo install <package>`, not plain `npm install`) — installing the latest version of either broke the native build or crashed at runtime with "Cannot find native module."
3. **Simulator battery is always -100%.** `DeviceInfo.getBatteryLevel()` is unsupported on the iOS Simulator by design; real devices report a real percentage.

## Summary of all libraries used

| Library | Where | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `index.js` | MCP server + stdio transport |
| `axios` | `index.js` | HTTP client to reach the phone |
| Node `child_process` | `index.js` | Reads local git history |
| `react-native-http-bridge-refurbished` | `mobile-app-server.js` | In-app HTTP server (native GCDWebServer/NanoHTTPD wrapper) |
| `react-native-device-info` | `mobile-app-server.js` | Battery, OS version, app version/build |
| `react-native-view-shot` | `mobile-app-server.js` | Screenshot capture |
| `expo-clipboard` | demo/test app only, not the core bridge | Tap-to-copy prompts in the demo UI |
