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
- **`@react-native-async-storage/async-storage`** — the only piece of state here that's persisted to disk rather than kept purely in memory. Used exclusively by crash capture (see below) so a crash survives even if it kills the JS engine before anything else could report it.

### Routes exposed on port 8080

| Route | Returns | Backed by |
|---|---|---|
| `GET /status` | `{ status, batteryLevel, platform, osVersion, appVersion, buildNumber, activeRoute, connectedAt }` | `react-native-device-info` + in-memory `currentRouteName`; `connectedAt` is set once when `startPulseServer()` runs |
| `GET /logs` | `{ logs: [{ id, timestamp, level, source, message, device }, ...] }` | In-memory ring buffer (`recentLogs`, capped at 100 entries), fed by calling `recordLog(message, level, source)` anywhere in the app; each entry carries a synchronous device snapshot (cached battery level, no per-call `DeviceInfo` await) |
| `GET /screenshot` | `{ image: <base64>, mimeType: "image/png" }` | `react-native-view-shot` |
| `GET /session` | `{ recording: bool, steps: [...] }` | In-memory step list, fed by `recordStep(...)`, only active between `startSessionRecording()`/`stopSessionRecording()` |
| `GET /reports` | `{ reports: [...] }` | All bug reports auto-saved by `stopSessionRecording()` |
| `GET /crashes` | `{ crashes: [{ id, timestamp, isFatal, message, stack, componentStack, source, device, breadcrumbs, recoveredFromDisk? }, ...] }` | In-memory ring buffer (capped at 20), fed automatically by three capture paths — see "Crash capture & breadcrumbs" below |

Most in-memory state (`recentLogs`, `sessionSteps`, `currentRouteName`, `breadcrumbs`) lives in that one JS module and is lost whenever the app process restarts — a deliberate simplicity tradeoff for those. **Crashes are the one exception**: they're persisted to `AsyncStorage` the instant they're captured and recovered on the next launch if the process died before anything else could report them.

### Crash capture & breadcrumbs

Three independent capture paths, registered at module load time (not inside `startPulseServer()`, so they're active as early as possible):

| Failure path | Caught by | `source` value |
|---|---|---|
| Uncaught exception in an event handler or async code | `global.ErrorUtils.setGlobalHandler` (wraps, doesn't replace, the previous handler) | `uncaught-exception` |
| A crash during React's render phase | A root `ErrorBoundary` around the whole app (`App.js` in the demo app); calls `recordCrash()` with `componentStack` | `render-error-boundary` |
| A rejected promise nobody `.catch()`'d | `global.HermesInternal.enablePromiseRejectionTracker` (falls back to the `promise` package's tracker on JSC) | `unhandled-promise-rejection` |

Every captured crash also gets a snapshot of the current **breadcrumb trail** attached (`breadcrumbs: [...]`, oldest first, capped at 20) — built automatically from:
- `setCurrentRoute()` calls (navigation), deduped so setting the same route twice in a row is a no-op
- a monkey-patched `global.fetch` that logs every request's method/URL/status/duration on success or failure; requests to `localhost`/`127.0.0.1` (Metro's own dev tooling, e.g. source map symbolication) are filtered out as noise

**Persistence sequence** (`persistCrash()` inside `captureCrash()`): the very first thing that happens on any crash is a fire-and-forget `AsyncStorage.setItem()` under a crash-specific key (`@pulse-mcp/pending-crash/<id>-<timestamp>`) — before the crash is even pushed into the in-memory list. Each crash gets its own key rather than one shared array key, so two crashes happening close together never race on a read-modify-write. On the next `startPulseServer()`/module load, `flushPendingCrashesFromDisk()` reads back any keys under that prefix, merges them into the in-memory list tagged `recoveredFromDisk: true`, and deletes them from storage so they aren't flushed again.

## Component 3: the MCP tools

Each tool is a thin wrapper: fetch one (or two) routes from the phone, reshape the JSON, return it as MCP `content`.

| Tool | What it does | Phone routes hit |
|---|---|---|
| `get_mobile_device_status` | Battery, screen, platform, OS/app version, connectedAt | `GET /status` |
| `get_mobile_app_logs` | Recent structured console/network logs, optionally filtered by `level` (info/success/error) | `GET /logs` |
| `check_mobile_connection` | Friendly human-readable "is it alive" summary plus raw status JSON, or a clean unreachable error | `GET /status` |
| `diagnose_mobile_error` | Diagnoses the most recent problem — a captured crash if one exists and is newer than the latest error-level log, otherwise falls back to the log. Returns `likelyCause`/`suggestion`, plus `topStackFrames`/`componentStack`/`breadcrumbsBeforeCrash` when the diagnosis came from a crash | `GET /crashes` + `GET /logs` |
| `get_mobile_screenshot` | Live screenshot as an inline image | `GET /screenshot` — returned as an MCP `image` content block (not text) |
| `get_standup_snapshot` | Device status + today's git commits combined | `GET /status` + local `git log` |
| `get_bug_report` | Numbered repro-steps sequence + likely failure point + device context | `GET /session` + `GET /status` |
| `get_saved_bug_reports` | All auto-saved bug reports | `GET /reports` |
| `get_mobile_crash_logs` | All captured crashes, each annotated with a `likelyCause`/`suggestion` from the same categorization heuristic `diagnose_mobile_error` uses | `GET /crashes` |

`get_bug_report` is the most composed tool: it fetches the step recording, finds the last step, checks it against `/error|fail|fatal|exception/i` to guess where things broke, and merges in device/build info from `/status` — all without the tester having to write up "steps to reproduce" by hand.

`diagnose_mobile_error` picks whichever of "the latest captured crash" or "the latest error-level log entry" is more recent by timestamp, then runs `categorizeErrorMessage()` (shared with `get_mobile_crash_logs`) against its message — pattern-matching for null/undefined property access, "is not a function", timeout, 404, DNS/ENOTFOUND, generic network/fetch failure, and permission-denied — falling back to "inspect the stack trace and breadcrumbs below for clues" when nothing matches. When the diagnosis came from a crash, `parseTopStackFrames()` also extracts function name + line/column from the first few stack frames, stripping away the long bundler query-string URLs Metro embeds in dev-mode stack traces.

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
3. **Simulator battery is always -100%.** `DeviceInfo.getBatteryLevel()` is unsupported on the iOS Simulator by design; real devices report a real percentage. Fixed by clamping any negative reading to a placeholder (`formatBatteryLevel()`) rather than showing `-100%`.
4. **Adding any new native module (e.g. `@react-native-async-storage/async-storage`) needs a full clean rebuild, not just `pod install`.** An incremental `expo run:ios` after installing a new native dependency intermittently failed with "Cannot find native module" even though the pod was installed correctly — the fix was deleting `~/Library/Developer/Xcode/DerivedData/<app>-*` and rebuilding from scratch. Budget for this every time a new native dependency is added, not just the first one.
5. **Wrapping the root component in an `ErrorBoundary` changes what `registerRootComponent()` sees.** Splitting the default export into a separate `AppRoot` wrapper (`<ErrorBoundary><App /></ErrorBoundary>`) is straightforward, but doing it as several small edits in sequence can leave a moment with no valid default export at all, which Metro happily bundles into a runtime "Element type is invalid... got: object" error. Make the export-restructuring edit atomic, or expect a transient error on the next Fast Refresh that resolves once the file is internally consistent again.

## Summary of all libraries used

| Library | Where | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `index.js` | MCP server + stdio transport |
| `axios` | `index.js` | HTTP client to reach the phone |
| Node `child_process` | `index.js` | Reads local git history |
| `react-native-http-bridge-refurbished` | `mobile-app-server.js` | In-app HTTP server (native GCDWebServer/NanoHTTPD wrapper) |
| `react-native-device-info` | `mobile-app-server.js` | Battery, OS version, app version/build |
| `react-native-view-shot` | `mobile-app-server.js` | Screenshot capture |
| `@react-native-async-storage/async-storage` | `mobile-app-server.js` | Persists crashes to disk so they survive the process dying |
| `expo-clipboard` | demo/test app only, not the core bridge | Tap-to-copy prompts in the demo UI |
