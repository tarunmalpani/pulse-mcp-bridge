# pulse-mcp relay

Always-on relay between a remote mobile app (running `mobile-app-server.js`'s `configurePulseRelay()`) and `index.js` (the MCP server), so the two can be on entirely different networks. See the "Remote / cloud relay mode" section of the root `README.md` for the full picture.

## Run locally

```bash
cd relay-server
npm install
cp .env.example .env   # then edit PULSE_API_KEY
node server.js
```

## Deploy to Render — one click

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/tarunmalpani/pulse-mcp-bridge)

This repo includes a `render.yaml` Blueprint at its root, so the button above sets up everything in one go: the web service, the `PULSE_API_KEY` secret (auto-generated — no need to invent one), and the persistent disk for the SQLite file. All you do afterward:

1. Click the button (or paste the repo URL into Render → **New → Blueprint**).
2. Render provisions it. Once live, copy the auto-generated `PULSE_API_KEY` value from the service's **Environment** tab — that's what you'll use as `relayApiKey` in the mobile app and `X-Pulse-Relay-Api-Key` in any hosted MCP config.
3. Your relay's public URL (`https://<name>.onrender.com`) is your `PULSE_RELAY_URL` / `relayUrl`.
4. (Optional, Phase 2 only) Fill in `GITHUB_TOKEN` / `GITHUB_REPO` in the Environment tab if you want the automated crash-fix pipeline — leave them blank otherwise.

### Manual setup (if you'd rather not use the Blueprint)

1. Push this repo to GitHub (already done, if you're reading this from a clone).
2. In Render: **New → Web Service**, connect this repo, set the root directory to `relay-server/`.
3. Build command: `npm install`. Start command: `node server.js`.
4. Add environment variables (Render dashboard → Environment):
   - `PULSE_API_KEY` — required, a random secret shared with the mobile app and `index.js`.
   - `GITHUB_TOKEN` / `GITHUB_REPO` — optional, only needed for the automated crash-fix pipeline (see below).
5. Add a **persistent disk** (Render → Disks) mounted at, e.g., `/data`, and set `DB_PATH=/data/relay.db` — without this, the SQLite file (and all crash history) is wiped on every redeploy.
6. Deploy. Render gives you a public HTTPS URL (`https://<name>.onrender.com`) — that's your `PULSE_RELAY_URL`.

## Routes

| Route | Method | Who calls it | Purpose |
|---|---|---|---|
| `/devices/:deviceId/status`, `/logs`, `/reports`, `/session` | `POST` | phone | Push the latest snapshot for that state kind |
| `/devices/:deviceId/status`, `/logs`, `/crashes`, `/reports`, `/session` | `GET` | `index.js` | Read the latest pushed snapshot |
| `/devices/:deviceId/crashes` | `POST` | phone | Push crashes (also triggers the auto-fix dispatch, de-duped) |
| `/devices/:deviceId/reports/new` | `POST` | phone | Notify of a newly-saved bug report (triggers the auto-fix dispatch, de-duped) |
| `/devices/:deviceId/screenshot` | `GET` | `index.js` | Enqueues a live screenshot request and waits (~10s) for the phone to fulfill it |
| `/devices/:deviceId/commands` | `GET` | phone | Poll for pending on-demand commands |
| `/devices/:deviceId/commands/:commandId/result` | `POST` | phone | Fulfill a pending command |
| `/health` | `GET` | anyone (unauthenticated) | Uptime check |

Every route except `/health` requires the `x-pulse-api-key` header.

## Automated crash-fix pipeline (optional)

If `GITHUB_TOKEN` (a PAT with `repo` + `workflow` scope) and `GITHUB_REPO` (`owner/repo`) are set, every new crash or bug report fires a GitHub `repository_dispatch` event (after a 1-hour de-dupe cooldown per unique error signature — see `lib/githubDispatch.js`), which `.github/workflows/auto-fix-crash.yml` picks up to run Claude Code headlessly and open a PR with a candidate fix. Leave these unset to run the relay without this pipeline.
