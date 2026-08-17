# Using pulse-mcp without the source code

This guide is for someone who wants to use the pulse-mcp tools against **their own** React Native/Expo app, without cloning or getting access to the `pulse-mcp-bridge` repository itself.

You were given two things by whoever shared this with you:

```
MCP Server URL: <HOSTED_MCP_URL>
Access Key:     <HOSTED_ACCESS_KEY>
```

Keep the access key private — treat it like a password.

Everything below (the relay, the bridge file, your device ID) is **yours** — fully isolated from anyone else using the same hosted MCP server.

---

## Step 1 — Deploy your own relay (one click)

Click **Deploy to Render**:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tarunmalpani/pulse-mcp-bridge)

This deploys just the relay component — a small always-on service that lets your phone and your IDE talk to each other even when they're on different networks.

Once it's live:
1. Note the service's public URL, e.g. `https://your-relay-name.onrender.com` — this is your **relay URL**.
2. In the Render dashboard, open the service's **Environment** tab and copy the auto-generated `PULSE_API_KEY` value — this is your **relay API key**.

## Step 2 — Add the bridge file to your app

Copy the `mobile-app-server.js` file you were given into your app, e.g. as `src/pulseServer.js`.

Install its native dependencies:

```bash
npx expo install react-native-http-bridge-refurbished react-native-device-info react-native-view-shot @react-native-async-storage/async-storage
```

If your app runs on plain Expo Go, you'll need a dev-client build instead (`npx expo prebuild` then `npx expo run:ios` / `npx expo run:android`), since these are native modules.

## Step 3 — Wire it into your app

In your app's entry point (e.g. `App.tsx`):

```js
import { startPulseServer, configurePulseRelay, setCurrentRoute } from "./pulseServer";

useEffect(() => {
  if (__DEV__) startPulseServer();
  configurePulseRelay({
    url: "https://your-relay-name.onrender.com", // your relay URL from Step 1
    apiKey: "your-relay-PULSE_API_KEY",           // your relay API key from Step 1
    deviceId: "my-device-1",                      // any unique ID you choose - just pick one
  });
}, []);

// Optional but recommended - on navigation change:
// setCurrentRoute(routeName);
```

Pick any `deviceId` you like — it just needs to be unique to this device/app. You'll reuse it in Step 4.

## Step 4 — Configure your IDE

Add this to your MCP client config (Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "pulse-mcp": {
      "url": "<HOSTED_MCP_URL>",
      "headers": {
        "Authorization": "Bearer <HOSTED_ACCESS_KEY>",
        "X-Pulse-Relay-Url": "https://your-relay-name.onrender.com",
        "X-Pulse-Relay-Api-Key": "your-relay-PULSE_API_KEY",
        "X-Pulse-Device-Id": "my-device-1"
      }
    }
  }
}
```

Fill in the same relay URL, relay API key, and deviceId from Steps 1–3.

## Step 5 — Test it

Run your app (same Wi-Fi as your dev machine, or anywhere if you've set up the relay), then ask your AI assistant:

> "Check my mobile connection"

If everything's wired up correctly, you should get back your device's battery level, OS version, and current screen.

---

## What you get

Once connected, you can ask your assistant things like:

- "What's my app's battery and OS version?"
- "Show me the recent app logs"
- "Show me my crash logs" / "Why did my app crash?"
- "Take a screenshot of my app right now"
- "What are the repro steps for the bug I just recorded?"

## Troubleshooting

- **"Missing one or more required headers" error** — double-check all 4 header values in your IDE config (`Authorization`, `X-Pulse-Relay-Url`, `X-Pulse-Relay-Api-Key`, `X-Pulse-Device-Id`) are present and correctly spelled.
- **"Could not reach relay ..." error** — your relay isn't reachable at the URL you configured. Confirm it's deployed and "Live" in Render, and that the URL/API key in your app and your IDE config match exactly.
- **Right after deploying**, you may briefly see errors that resolve themselves within a minute — this is normal while Render finishes rolling out the new service.
