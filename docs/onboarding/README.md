# PulseMCP — Onboarding Guide for New Teams

PulseMCP lets your IDE's AI assistant (Claude Code, Cursor, Claude Desktop, Windsurf, etc.)
see what's happening on a **real running React Native / Expo app** — device status,
logs, crashes with stack traces, bug-report step recordings, and live screenshots —
without any manual copy-pasting of logs.

This guide walks a new team through adding it to **any** React Native app, running it
on a real device, and wiring it up to an MCP client.

---

## 1. How it fits together

```
IDE (MCP client) <--stdio--> pulse-mcp (index.js) <--HTTP--> your app (pulseServer.js)
```

- `index.js` is the **MCP server**. It is generic — you never need to modify it,
  no matter which app you point it at.
- `pulseServer.js` (copied from this repo's `mobile-app-server.js`) is a small
  in-app HTTP server. It's the **only** piece that lives inside your app.
- They talk over plain HTTP on port `8080`, so your phone and your dev machine
  must be reachable from each other (same Wi-Fi, or `127.0.0.1` for a Simulator).

---

## 2. Add the bridge to your app

1. **Copy the bridge file** into your app:
   ```bash
   cp mobile-app-server.js /path/to/your-app/src/pulseServer.js
   ```

2. **Install its native dependencies:**
   ```bash
   npx expo install react-native-http-bridge-refurbished react-native-device-info \
     react-native-view-shot @react-native-async-storage/async-storage
   ```
   These are native modules. If your app currently runs on plain **Expo Go**, it
   won't be able to load them — you need a dev-client build instead:
   ```bash
   npx expo prebuild
   npx expo run:ios      # or: npx expo run:android
   ```

3. **Wire it into your root component** (e.g. `App.tsx`):
   ```js
   import { startPulseServer, setCurrentRoute, recordLog } from "./pulseServer";

   useEffect(() => {
     if (__DEV__) startPulseServer();
   }, []);

   // Call this on every navigation change:
   setCurrentRoute(routeName);

   // Call this anywhere worth logging:
   recordLog("Synced dashboard data", "success", "SyncService");
   recordLog(`Network request failed: ${error.message}`, "error", "NetworkClient");
   ```

   **Automatic crash capture needs no extra wiring at all** — just calling
   `startPulseServer()` is enough. It catches:
   - Uncaught exceptions (`ErrorUtils.setGlobalHandler`)
   - Render errors (via an `ErrorBoundary` you wrap your tree in — see
     `PulseCrashBoundary` in the demo app's `App.js` for a working example)
   - Unhandled promise rejections

   Optional: wire a Start/Stop Recording toggle to `startSessionRecording()` /
   `stopSessionRecording()` and call `recordStep(...)` at points worth capturing,
   to get full step-by-step bug reports via `get_bug_report`.

4. **iOS Local Network permission.** Add this to `app.json` under `expo.ios.infoPlist`
   (iOS 14+ will prompt the user for it the first time the bridge starts):
   ```json
   "NSLocalNetworkUsageDescription": "This app runs a local debug bridge so your IDE's MCP tools can read device status, logs, and screenshots."
   ```

---

## 3. Register the MCP server with your IDE

Copy the relevant block from `mcp-config.example.json` into your IDE's MCP config
(Cursor's `.cursor/mcp.json`, Claude Desktop's `claude_desktop_config.json`, etc.):

```json
{
  "mcpServers": {
    "pulse-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/pulse-mcp-bridge/index.js"],
      "env": {
        "MOBILE_PHONE_IP": "192.168.1.42"
      }
    }
  }
}
```

Set `MOBILE_PHONE_IP` to:
- `127.0.0.1` — testing against the iOS **Simulator** (shares the Mac's network stack), or `mock-phone.js`
- your phone's **real LAN IP** — testing against a **real device**
  (Settings → Wi-Fi → ⓘ next to your network → IP Address)

> ⚠️ A very common mistake: leaving `MOBILE_PHONE_IP` at `127.0.0.1` while testing
> on a real device. `localhost` on your Mac is not your phone — the MCP tools will
> report the bridge as unreachable. Update it to the phone's actual IP.

Your phone and dev machine must be on the **same Wi-Fi network**, since the bridge
is plain HTTP with no tunneling.

---

## 4. Running on a real device (not Simulator)

If you just need the Simulator, `npx expo run:ios` / `npx expo run:android` is
enough and you can skip this section.

For a **real iPhone**, `npx expo run:ios --device <udid>` frequently trips over
code-signing — the recommended path is to build and install directly with the
Apple toolchain:

```bash
# 1. Find your device's UDID — it must show under "Devices", not "Devices Offline".
#    (Plug the phone in, unlock it, and tap "Trust This Computer" if prompted.)
xcrun xctrace list devices

# 2. Build for that device.
cd ios
xcodebuild -workspace <yourapp>.xcworkspace -scheme <yourapp> -configuration Debug \
  -destination "id=<UDID>" build

# 3. Install and launch the built app.
APP_PATH=$(find ~/Library/Developer/Xcode/DerivedData/<yourapp>-*/Build/Products/Debug-iphoneos -maxdepth 1 -name "*.app")
xcrun devicectl device install app --device <UDID> "$APP_PATH"
xcrun devicectl device process launch --device <UDID> <your.bundle.id>
```

### Fixing signing errors

If `xcodebuild` fails with:

> `demoapp has conflicting provisioning settings. demoapp is automatically signed,
> but provisioning profile ... has been manually specified.`

or:

> `No profiles for '<bundle-id>' were found`

— the project's signing state in `project.pbxproj` is out of sync with what Xcode's
UI expects. **Don't hand-edit the pbxproj signing fields.** Instead, open the
`.xcodeproj` in Xcode, select your app target → **Signing & Capabilities**, and
either:

- Check **"Automatically manage signing"** and pick your Team, **or**
- Uncheck it and manually select your provisioning profile from the dropdown
  (screenshots below show both states)

Xcode will rewrite `project.pbxproj` correctly when you do this in the UI.

**Device target picker in Xcode:**

![Xcode device target picker](screenshots/01-xcode-device-target.png)

**Signing & Capabilities panel — manual signing, working state:**

![Xcode Signing & Capabilities](screenshots/02-xcode-signing-capabilities.png)

If instead you get `No Accounts: Add a new account in Accounts settings`, open
**Xcode → Settings → Accounts** and sign in with the Apple ID tied to your team —
this can't be done from the command line.

### "No bundle URL present" after install

This means the app launched but can't find the Metro bundler (Debug builds load
JS from Metro, not from a bundled file). Fix:

```bash
npx expo start --port 8081
```

Then on the device, **shake it** to open the React Native dev menu → "Configure
Bundler" / "Change Bundle Location" → enter `<your-mac's-LAN-IP>:8081` → reload.
Find your Mac's LAN IP with `ipconfig getifaddr en0`.

---

## 5. Verifying it works

Once the bridge is running (toggle it on in-app if your app has a toggle, like the
demo app does) and the app is in the foreground:

**App showing the bridge online:**

![App with bridge online](screenshots/03-app-bridge-online.png)

Quick sanity check straight from the terminal, before even touching your MCP
client — replace with your phone's IP:

```bash
curl http://<phone-ip>:8080/status
curl http://<phone-ip>:8080/crashes
```

If those return JSON, the bridge is reachable and your MCP client's tool calls
(`get_mobile_device_status`, `get_mobile_crash_logs`, etc.) will work too.

If `curl` hangs or refuses the connection:
- Confirm phone and Mac are on the same Wi-Fi network (same subnet — check with
  `ifconfig en0` on the Mac and Settings → Wi-Fi → ⓘ on the phone)
- Confirm the app is in the foreground and the bridge toggle (if present) is on
- Confirm the iOS "Local Network" permission prompt was accepted

---

## 6. Available MCP tools

| Tool | What it gives your AI assistant |
|---|---|
| `get_mobile_device_status` | Battery level, active screen, OS/platform |
| `get_mobile_app_logs` | Recent structured logs, optionally filtered by level |
| `check_mobile_connection` | A friendly reachability check |
| `diagnose_mobile_error` | Best-guess cause/suggestion from the latest crash or log |
| `get_standup_snapshot` | Device status + today's git commits |
| `get_mobile_screenshot` | Live screenshot of the current screen |
| `get_bug_report` | The in-progress step recording, if any |
| `get_saved_bug_reports` | All auto-saved bug reports (steps + logs + device info) |
| `get_mobile_crash_logs` | All captured crashes, each with stack trace, breadcrumbs, and likely cause |

---

## 7. Known limitations

- **Android is untested.** It should work in principle
  (`react-native-http-bridge-refurbished` supports Android), but Android 9+
  blocks plaintext HTTP by default — you'll likely need
  `android:usesCleartextTraffic="true"` in `AndroidManifest.xml` for dev builds.
- **Android emulator** is NAT'd and unreachable directly — use `127.0.0.1` plus
  `adb forward tcp:8080 tcp:8080`.
- The bridge is plain HTTP with **no auth** — it's meant for local dev only, never
  ship a production build with `startPulseServer()` reachable (guard it behind
  `if (__DEV__)` as shown above).
