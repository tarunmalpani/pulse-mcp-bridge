# pulse-mcp-bridge — Reference Document (continuation context for Claude)

**Purpose of this file:** a single, self-contained reference so a fresh Claude session can pick up this project without re-reading the whole codebase. Written at the end of a session that built the cloud relay, the automated crash-fix pipeline, and the in-app "Ask IDE" command feature. Repo: `https://github.com/tarunmalpani/pulse-mcp-bridge` (branch `main`).

For deep implementation detail beyond this summary, see `ARCHITECTURE.md` (original local-bridge architecture) and `relay-server/README.md` (relay deploy instructions) — this file is the index/summary, those are the depth.

---

## 1. What this project is

`pulse-mcp-bridge` is an MCP (Model Context Protocol) server that lets an IDE's AI assistant (Claude Code, Cursor, Claude Desktop) directly query a **running React Native / Expo mobile app**: live device status, structured logs, automatically-captured crashes (with stack traces + breadcrumbs), bug-report step recordings, and live screenshots — without anyone manually copy-pasting logs off a phone.

**The core problem it solves:** normally, "what's happening on this phone right now" requires physically looking at the device or pasting console output into a chat. This closes that loop — the assistant can ask the app direct questions and get real answers.

**Extended problem it solves (this session's work):** the original design only worked when the phone and the developer's machine shared a Wi-Fi network. This session added a **cloud relay** so the phone and the developer can be on entirely different networks (e.g. a client's device in the USA, developer in India) — plus an **automated fix pipeline** so a crash can turn into a candidate PR without a human having to notice it first.

### Phasing

This session's work splits into two phases:

- **Phase 1 — Cloud relay (done, verified working).** The relay itself (§4): phone ↔ relay ↔ `index.js` over HTTPS, cross-network, tested live on a real device including on cellular data. This phase needs no Anthropic account and no GitHub Actions — it's just the relay + the existing 9 MCP tools working across networks instead of only on LAN.
- **Phase 2 — Anthropic + GitHub automated fix pipeline (built, wired up, blocked on billing).** Everything that involves an `ANTHROPIC_API_KEY` and GitHub Actions — the automated crash-fix pipeline (§5) and the "Ask IDE" command box that feeds it (§6). This phase is what turns a captured crash/command into an actual PR. It was explicitly discussed and agreed to be treated as a separate, later phase from the core relay — Phase 1 (relay) is usable and complete on its own without ever turning Phase 2 on.

---

## 2. Architecture — components and file map

```
Mobile app (React Native)          pulse-mcp (index.js)              IDE (Claude Code, etc.)
──────────────────────────         ─────────────────────             ────────────────────────
mobile-app-server.js         ◀───HTTP (LAN)────▶  fetchFromPhone()  ◀──stdio/MCP──▶  model calls tools
  - BridgeServer :8080 (local)
  - OPTIONAL: pushes to relay ──HTTPS──▶  relay-server/  ◀──HTTPS── fetchFromPhone() (relay mode)
                                              │
                                              └─▶ GitHub repository_dispatch ──▶ .github/workflows/auto-fix-crash.yml
                                                                                    (headless Claude Code → PR)
```

| Component | File(s) | Role |
|---|---|---|
| **MCP server** | `index.js` | Runs on the dev machine, spawned by the IDE over stdio. Exposes 9 tools. Talks HTTP to either the phone directly (`MOBILE_PHONE_IP`) or the relay (`PULSE_RELAY_URL`). Generic — never needs to change per app. |
| **In-app bridge** | `mobile-app-server.js` (root) and `demo-app/src/pulseServer.js` (identical copy inside the demo app) | Copied into any target RN app as e.g. `src/pulseServer.js`. Runs a tiny local HTTP server (`BridgeServer`, port 8080) inside the app's own JS engine, AND optionally pushes state to the relay. |
| **Demo/test app** | `demo-app/` | Full Expo app exercising all tools + the relay + the "Ask IDE" command box. Used throughout this session for live device testing (real iPhone, "Tarun Malpani iphone", UDID `00008110-001924613EBA401E`). |
| **Cloud relay** | `relay-server/` (Express + SQLite) | Optional always-on intermediary. Phone pushes to it; `index.js` reads from it. See §4. |
| **Automated fix pipeline** | `.github/workflows/auto-fix-crash.yml`, `.github/scripts/prepare-auto-fix.mjs`, `relay-server/lib/githubDispatch.js` | Fires on new crash/report/command; runs headless Claude Code in CI; opens a PR. See §5. |
| **Shared tool logic** | `lib/mcpToolServer.js` | The 9 tool definitions + handlers, factored out of `index.js` so both it and `hosted-server.js` build an MCP `Server` from one source of truth. Added in a later part of this session — see §10. |
| **Hosted multi-tenant MCP server** | `hosted-server.js` | Same 9 tools over HTTP instead of stdio; lets you share the tool *without* sharing this repo's source. See §10. |
| **One-click relay deploy** | `render.yaml` (repo root) | Render Blueprint — the "Deploy to Render" button in `relay-server/README.md` uses this to auto-provision the service, disk, and a generated `PULSE_API_KEY` in one step. See §10. |
| **Mock phone** | `mock-phone.js` | Fakes `/status`/`/logs` for local testing without a real device. |

---

## 3. The 9 MCP tools (unchanged core, still the foundation)

| Tool | What it does |
|---|---|
| `check_mobile_connection` | Friendly "is it alive" summary + raw status JSON, or a clean unreachable error |
| `get_mobile_device_status` | Battery, active route/screen, OS/platform, `connectedAt` |
| `get_mobile_app_logs` | Recent structured logs, optional `level` filter (info/success/error) |
| `diagnose_mobile_error` | Diagnoses the most recent crash *or* error-level log (whichever is newer), with a heuristic `likelyCause`/`suggestion` |
| `get_mobile_screenshot` | Live screenshot as inline MCP image content (on-demand — see relay command queue, §4) |
| `get_bug_report` | Current/live step recording + device context |
| `get_saved_bug_reports` | All bug reports auto-saved on the device |
| `get_mobile_crash_logs` | All auto-captured crashes with stack trace, breadcrumbs, and diagnosis |
| `get_standup_snapshot` | Device status + today's local git commits |

All 9 work identically whether `index.js` is in local LAN mode or relay mode — the tool handlers don't know which.

**Automatic crash capture** (in `mobile-app-server.js`, needs zero manual instrumentation): three capture paths — `ErrorUtils.setGlobalHandler` (uncaught exceptions), a root `ErrorBoundary` (`PulseCrashBoundary`, render-phase crashes), and Hermes's promise-rejection tracker (unhandled rejections). Every crash gets a ~20-entry breadcrumb trail (navigation + patched `fetch()` calls) and is persisted to `AsyncStorage` *before* anything else runs, so it survives the JS engine dying and is recovered (`recoveredFromDisk: true`) on next launch.

**Bug-report step recording**: `startSessionRecording()`/`stopSessionRecording()` + `recordStep()` — a tester taps Start/Stop Recording, and a full report (numbered steps + logs + device snapshot) is auto-saved.

---

## 4. Cloud relay mode (`relay-server/`) — Phase 1, built this session

**Problem it solves:** the original bridge required the phone and `index.js` to be on the same Wi-Fi. The relay decouples them completely — the phone pushes its state to an always-on HTTPS service; `index.js` reads from that service instead of a LAN IP.

**Stack:** Node + Express + `better-sqlite3` (SQLite for durable per-device state storage).

**Key design choice:** the relay's `GET` routes mirror the phone's local routes 1:1 (`/status`, `/logs`, `/crashes`, `/reports`, `/session`, `/screenshot`), just namespaced under `/devices/:deviceId/...` and behind an `x-pulse-api-key` header. This meant **zero changes** to any of the 9 tool handlers in `index.js` — only `fetchFromPhone()`'s base URL/auth changes (env-gated on `PULSE_RELAY_URL`).

**Routes** (`relay-server/server.js`):
- `POST /devices/:id/{status,logs,reports,session}` — phone pushes latest snapshot
- `POST /devices/:id/crashes` — phone pushes; also triggers the auto-fix dispatch (de-duped)
- `POST /devices/:id/reports/new` — notifies of a newly-saved bug report; also triggers auto-fix dispatch
- `POST /devices/:id/user-commands` — free-text command from the app's "Ask IDE" screen; always dispatches (no de-dupe — see §6)
- `GET /devices/:id/{status,logs,crashes,reports,session}` — `index.js` reads latest pushed snapshot
- `GET /devices/:id/screenshot` — **on-demand**: enqueues a command, holds the HTTP response open (~10s) until the phone's next poll fulfills it. From `index.js`'s side, indistinguishable from a direct phone call.
- `GET /devices/:id/commands` / `POST /devices/:id/commands/:id/result` — phone-side poll/fulfill for on-demand commands (currently just screenshot)
- `GET /health` — unauthenticated uptime check

**Storage** (`relay-server/lib/db.js`): one SQLite row per `(deviceId, kind)` holding the latest JSON blob. Also a `dispatch_dedupe` table for the auto-fix cooldown (see §5).

**Command queue** (`relay-server/lib/commandQueue.js`): in-memory (not persisted — a command that outlives a relay restart has no useful recovery story) poll/fulfill queue with a 10s timeout, used for the screenshot round trip.

**Mobile app side** (`mobile-app-server.js`): `configurePulseRelay({ url, apiKey, deviceId })` — call once alongside `startPulseServer()`. Purely additive; the local `BridgeServer`/port-8080 path is completely untouched, so LAN-only usage is unaffected. Once configured: pushes `/status` on a 20s heartbeat + route changes, pushes `/logs` after every `recordLog()`, pushes `/crashes` immediately inside `captureCrash()` (right after the existing `AsyncStorage` write — a second, best-effort sink, not a replacement), pushes `/reports`/`/session` around the bug-report flow, and polls `/commands` every ~4s for screenshot requests.

**Security note:** the relay is internet-exposed (unlike the LAN-only local bridge). Every route but `/health` requires the shared `x-pulse-api-key` header. No per-device auth beyond that shared key + `deviceId` — fine for a handful of trusted testers, not a public multi-tenant service.

### Verified live (this session)

- Ran the relay locally (`node relay-server/server.js`), tunneled publicly via **cloudflared** (`cloudflared tunnel --url http://localhost:9200`) — quick tunnel URL was `https://toolkit-expand-abstract-trustee.trycloudflare.com` (this is a temporary/free tunnel; it dies whenever the local `cloudflared` process stops, so it's **not** a permanent deployment).
- Rebuilt & installed the demo app on a real iPhone (manual-signing Xcode build, see `README.md` → "Running demo-app on a real iPhone") with `configurePulseRelay()` pointed at that tunnel URL.
- Confirmed `check_mobile_connection`, `get_mobile_device_status`, and `get_mobile_crash_logs` all worked correctly **while the phone was on cellular data** (Wi-Fi off) — proving the actual cross-network case the relay was built for.
- Confirmed a real crash captured by `triggerTestCrash()` (the demo app's test-crash button) was pushed and readable via the relay while on cellular.

### Not yet done

- **`relay-server/` has never been deployed to real hosting** (Render was the planned target — see `relay-server/README.md`). Everything verified above used the temporary local+tunnel setup. Deploying to Render (with a persistent disk for the SQLite file, and `PULSE_API_KEY`/`GITHUB_TOKEN`/`GITHUB_REPO` env vars) is the next real step if this is going into actual use.
- The demo app's `App.js` currently has a **hardcoded temporary block** (`PULSE_RELAY_TEST_URL`, `PULSE_RELAY_TEST_API_KEY = "pulsetest2026"`, `PULSE_RELAY_TEST_DEVICE_ID = "demo-iphone-1"`) pointing at that now-dead cloudflared URL, flagged with a `TEMPORARY` comment. Needs replacing with real relay config once deployed.

---

## 5. Automated crash-fix pipeline — Phase 2, built this session

**Problem it solves:** without this, a crash/bug report just sits in `get_mobile_crash_logs` until a human happens to ask about it. This makes the relay proactively kick off a fix attempt.

**Flow:** relay receives crash/report/command → (crash/report path only) de-dupe check → fires a GitHub `repository_dispatch` event → `.github/workflows/auto-fix-crash.yml` runs on GitHub's infrastructure → checks out `main` → creates a `preview/*` branch → installs and runs **Claude Code CLI headlessly** (`claude -p "<context>"`) → if it made changes, commits, pushes, and opens a PR against `main`. **Nothing merges automatically** — every fix is a PR for human review.

**Three trigger types**, one shared pipeline:
1. `pulse-crash` — from `POST /devices/:id/crashes`. Payload: message, stack, componentStack, breadcrumbs, device, timestamp.
2. `pulse-bug-report` — from `POST /devices/:id/reports/new`. Payload: the tester's numbered repro steps, logs, device info.
3. `pulse-user-command` — from `POST /devices/:id/user-commands` (the "Ask IDE" text box, see §6). Payload: free-text command, deviceId, timestamp.

**De-dupe guard** (`relay-server/lib/db.js` → `shouldDispatch()`, used by `maybeDispatch()` in `githubDispatch.js`): crashes/reports hash on `message + top stack frame` (or step descriptions for reports) with a **1-hour cooldown** — this was added specifically because real session data showed 5 near-identical crashes firing within 4 seconds, which would otherwise spam 5 duplicate PRs. **User-submitted commands bypass de-dupe entirely** (`dispatchNow()`, no cooldown) since every submission is an explicit, intentional one-off action.

**Prompt construction** (`.github/scripts/prepare-auto-fix.mjs`): reads the `repository_dispatch` payload from `$GITHUB_EVENT_PATH`, builds a branch name (`preview/crash-*`, `preview/bug-report-*`, `preview/user-command-*`), a PR title, and a full prompt file (`.github/auto-fix-prompt.txt`) tailored per event type — crash prompts include the stack/breadcrumbs; bug-report prompts include the repro steps/logs; user-command prompts include the verbatim text.

**Guardrails:**
- Every run isolated to its own branch; `main` never touched directly.
- No PR opened if Claude Code made no changes (checked via `git status --porcelain`).
- Secrets split: the **relay** holds a `GITHUB_TOKEN` (PAT, `repo` scope) used only to fire the dispatch event. **GitHub Actions** holds `ANTHROPIC_API_KEY` (repo secret) used only inside the CI job. Neither system holds the other's credential.

### Status: wired up but blocked on billing

Verified working end-to-end **except the final step**:
- ✅ Relay → dispatch → GitHub Actions triggering → checkout → branch creation → Claude Code CLI install all succeed (confirmed via real workflow runs, e.g. `https://github.com/tarunmalpani/pulse-mcp-bridge/actions/runs/31793289486`).
- ❌ The `claude -p` step fails with **`Credit balance is too low`** — an `ANTHROPIC_API_KEY` was added to the repo's Actions secrets and correctly authenticates (confirmed: the earlier failure of "key came through blank" was fixed once the secret was actually added), but the Anthropic Console account behind that key has no billing/credits.

**To unblock:** add a payment method / credits at `https://console.anthropic.com/settings/billing` for the account owning that key (or provide a different key that has balance), then re-trigger a test command from the app's "Ask IDE" screen (or `curl -X POST <relay>/devices/<id>/user-commands -H "x-pulse-api-key: ..." -d '{"text":"..."}'`) and check `https://github.com/tarunmalpani/pulse-mcp-bridge/actions` for a run that completes and opens a PR.

**Explored and explicitly abandoned:** using `ant auth login` (OAuth tied to a Claude Pro/Max subscription) instead of a billed API key, specifically to avoid metered API costs in CI. This was actually set up and tested locally (login succeeded, credential files at `~/.config/anthropic/`) but reverted because: (a) Anthropic's own guidance says interactive OAuth login is for local dev, not unattended CI — the intended non-interactive path is Workload Identity Federation (an enterprise feature, not a quick fix); (b) OAuth access tokens expire and need refresh-token handling that isn't a supported flow for a disposable CI runner; (c) it would mean storing a personal account credential (not just an API scope) as a CI secret. The user explicitly said to drop this and use a plain API key instead (`ant auth logout` was run to clean up the local profile).

### Not yet done

- **Per-device repo mapping.** The pipeline currently hardcodes `tarunmalpani/pulse-mcp-bridge` as the target repo (`GITHUB_REPO` env var on the relay). If this bridge is ever dropped into other teams' apps, each device/app's crashes need to open PRs against *that app's own repo*, not this one — would need a `deviceId → repo` mapping stored on the relay, plus a PAT with dispatch access to each target repo, plus that repo having its own copy of the workflow + its own `ANTHROPIC_API_KEY` secret.
- No rate/volume cap beyond the 1-hour de-dupe — a crash-looping device could still trigger many CI runs across different error signatures.

---

## 6. "Ask IDE" command box — Phase 2, built this session

**Problem it solves:** lets a user type a plain-English bug/request directly into the app (rather than waiting for an automatic crash) and have it flow into the same fix pipeline.

- **UI**: `demo-app/App.js` → `AskCommandBox` component, rendered at the top of the existing "Ask IDE" tab (which otherwise just shows copyable MCP prompt suggestions). Text input + Send button; shows sending/sent/error states; disabled if the relay isn't configured (`isRelayConfigured()`).
- **Bridge function**: `sendUserCommand(text)` in `mobile-app-server.js` — throws if no relay configured (unlike the other `push*` functions, this one is **not** fire-and-forget, since it's a direct user action and the UI needs to know if it failed). Also calls `recordLog()` for visibility in the local log feed.
- **Relay endpoint**: `POST /devices/:id/user-commands` → validates non-empty `text` → `dispatchNow("pulse-user-command", ...)` (no de-dupe, see §5) → returns `501` if the relay's own `GITHUB_TOKEN`/`GITHUB_REPO` aren't configured, `400` for missing/empty text, `401` for a bad API key.

Verified live: sent a real test command from a curl call standing in for the UI, watched the relay dispatch it, and watched the GitHub Actions run start and progress through to the (currently billing-blocked) Claude Code step.

---

## 7. Third-party tools / libraries used, and why

| Library / Tool | Where | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | `index.js` | MCP server + stdio transport — the actual protocol this whole project implements |
| `axios` | `index.js` | HTTP client to reach the phone or the relay |
| Node `child_process` | `index.js` | Reads local git history for `get_standup_snapshot` |
| `react-native-http-bridge-refurbished` | `mobile-app-server.js` | In-app HTTP server (native GCDWebServer/NanoHTTPD wrapper) — what makes port 8080 possible inside a React Native app at all |
| `react-native-device-info` | `mobile-app-server.js` | Battery, OS version, app version/build |
| `react-native-view-shot` | `mobile-app-server.js` | Screenshot capture |
| `@react-native-async-storage/async-storage` | `mobile-app-server.js` | Persists crashes to disk so they survive the JS engine dying |
| `expo-clipboard` | `demo-app/` only | Tap-to-copy prompts in the demo UI |
| `express` | `relay-server/` | HTTP server for the cloud relay |
| `better-sqlite3` | `relay-server/` | Durable storage for pushed device state + the dispatch de-dupe table |
| **cloudflared** (Cloudflare Tunnel, Homebrew) | local testing only | Gave the local relay a public HTTPS URL for the cross-network/cellular test, without deploying anywhere real. Chosen over `ngrok`/`localtunnel` because it has no click-through interstitial page that would break the phone's raw `fetch()` calls. **Temporary** — not a deployment strategy. |
| **GitHub Actions** | `.github/workflows/auto-fix-crash.yml` | Runs the headless Claude Code fix step — chosen over running Claude Code directly on the relay so the relay (internet-exposed) never holds an `ANTHROPIC_API_KEY` or a repo checkout |
| **Claude Code CLI** (`@anthropic-ai/claude-code`) | installed fresh in each CI run | The actual agent that reads the crash/command context and writes the fix |
| **`ant` CLI** (Homebrew, `anthropics/tap/ant`) | tried, then removed | Anthropic's terminal client; used to attempt the OAuth (`ant auth login`) approach — see §5, abandoned and logged out |
| **PyNaCl** (Python, throwaway venv) | one-off script, deleted after use | Used to encrypt the `ANTHROPIC_API_KEY` value client-side before uploading it via GitHub's "create/update repository secret" API, which requires libsodium sealed-box encryption against the repo's public key |
| **Render** | planned, not yet done | Intended permanent host for `relay-server/` (see `relay-server/README.md`) — free TLS domain, persistent disk for SQLite |

---

## 8. Credentials / secrets touched this session (values not repeated here — check current state before assuming any are still valid)

- A **GitHub PAT** (`repo` scope) was created and set as `GITHUB_TOKEN` on the *locally-running* relay process's environment (not persisted anywhere — the relay was never deployed, so this only exists in that terminal session's env vars while it's running) and used to encrypt/upload the `ANTHROPIC_API_KEY` repo secret.
- **`ANTHROPIC_API_KEY`** is set as a real GitHub Actions repository secret on `tarunmalpani/pulse-mcp-bridge` — confirmed present and authenticating, but the account behind it currently has no credit balance (see §5).
- A temporary relay test key `pulsetest2026` and a temporary cloudflared URL were used for local verification — both are dead once the local process/tunnel stopped, and the value is also hardcoded (temporarily) in `demo-app/App.js`.
- An `ant auth login` OAuth profile was created locally, then explicitly logged out (`ant auth logout`) and its packaging attempt abandoned — no lingering credential from that path.

**Before resuming work**, don't assume any of the above are still valid — check `gh`/GitHub repo secrets settings, re-run `ant auth status` if relevant, and check whether the local relay/tunnel processes are still running (they almost certainly are not, since they were manual foreground/background processes on one machine, not a deployment).

---

## 9. Sharing without sharing source (`hosted-server.js`) — Phase 1, built this session

**Problem it solves:** the user wanted to give a friend access to the MCP tools (against the friend's own app/relay) without handing over this repo's source code, and without the friend needing anything from the user beyond a URL + key. Plain `index.js` doesn't fit — it's spawned locally over stdio, requires the source file, and is single-tenant (one fixed relay config via env vars).

**What was built:**
- **`lib/mcpToolServer.js`** — the 9 tool definitions + all handler logic, extracted out of `index.js` into `createPulseServer({ fetchFromPhone, unreachableMessage, getTodayGitCommits })`, a factory that returns a configured MCP `Server`. `index.js` was refactored to call this factory instead of inlining everything — verified byte-for-byte identical behavior via a real MCP client test (same 9 tools, same relay round trip) before and after the refactor.
- **`hosted-server.js`** — a new Express app exposing the same 9 tools over **`StreamableHTTPServerTransport`** (from `@modelcontextprotocol/sdk`, stateless mode: `sessionIdGenerator: undefined`, `enableJsonResponse: true`) instead of stdio. Deployed once, reused by anyone.
  - **Multi-tenant per request, not per deployment:** each incoming `POST /mcp` reads `X-Pulse-Relay-Url` / `X-Pulse-Relay-Api-Key` / `X-Pulse-Device-Id` from that request's own headers (not server env vars) and builds a fresh `fetchFromPhone` scoped to just that caller. A separate `Authorization: Bearer <HOSTED_ACCESS_KEY>` header gates who can reach the server at all, independent of each caller's own relay credentials. Nothing is persisted between requests — a new `Server`+transport pair is created per request and closed on `res.on("close")`.
  - Verified live: two simultaneous "callers" with completely different relay ports/keys/deviceIds (one iOS/HomeScreen, one Android/SettingsScreen) got back their own isolated data with zero cross-talk, through the same running hosted-server.js process.
  - `get_standup_snapshot`'s git-log feature returns a fixed "not available in hosted mode" message here (reading the *hosted server's* git history would be meaningless for a remote multi-tenant caller) — this is the one behavioral difference from `index.js`.
- **`render.yaml`** (repo root) — a Render Blueprint for `relay-server/` (`rootDir: relay-server`, auto-generated `PULSE_API_KEY` via `generateValue: true`, a persistent disk at `/data`, optional `GITHUB_TOKEN`/`GITHUB_REPO` via `sync: false`). Lets `relay-server/README.md`'s new "Deploy to Render" button provision the whole relay in one click instead of the manual multi-step Render setup — this was specifically to reduce the number of steps a friend/third party needs to do to get their own isolated relay running.

**What a friend needs to do now** (see root `README.md` → "Sharing this with someone else, without sharing the source code"):
1. Click **Deploy to Render** for their own relay (one click, thanks to `render.yaml`).
2. Add `mobile-app-server.js` to their own app + call `configurePulseRelay()` with their own relay's URL/key + a deviceId of their choice.
3. Point their IDE's MCP config at the hosted `hosted-server.js` URL (deployed by the pulse-mcp-bridge owner, not the friend) with the 4 headers above.

No source code, no per-person setup work from the repo owner beyond deploying `hosted-server.js` once.

### Deployed and verified live (this session)

`hosted-server.js` is deployed on Render as a manual Web Service (root directory blank/repo root, build `npm install`, start `node hosted-server.js`, env var `HOSTED_ACCESS_KEY` set) at:

- **URL**: `https://pulse-mcp-bridge.onrender.com/mcp`
- **Access key**: `33084e448c80da8879dfdc59ac9637a27de7e810232a092a` (treat like a password — this is what gates who can reach the hosted server at all, separate from each caller's own relay credentials)

Verified end-to-end against this live deployment: health check, auth gate (401 with no/wrong key), header validation (400 on missing relay headers), and a full real tool call (`get_mobile_device_status`, `check_mobile_connection`) round-tripping through a temporary relay+cloudflared tunnel — confirmed correct data returned through the live Render URL.

**Quirk observed during deploy:** right after a deploy finishes, requests can flip between a working response and a generic `404 Not Found` (not Express's own 404 format) for roughly a minute — looks like Render briefly running old+new instances during the transition. It self-resolves; if you see this right after deploying, just retry after ~30-60s rather than assuming something's broken.

**Not yet done:** nothing outstanding for this specific piece — this is the one item from the original next-steps list that's now complete. `render.yaml` still only covers `relay-server/` (each friend's own relay); `hosted-server.js` was deployed manually since it's a one-time deploy by the repo owner, not something each friend repeats.

---

## 10. Suggested next steps (in likely priority order)

**Phase 1 (relay) next steps:**
1. Deploy `relay-server/` to Render (or equivalent) for a permanent, always-on relay URL — replace the temporary cloudflared reference in `demo-app/App.js`'s `PULSE_RELAY_TEST_*` constants with the real deployed values, and remove the "TEMPORARY" comment/config once done.
2. ~~Deploy `hosted-server.js`~~ — **done** (see §9): live at `https://pulse-mcp-bridge.onrender.com/mcp`, verified end-to-end.

**Phase 2 (Anthropic + GitHub auto-fix pipeline) next steps — pick up only when ready to move to Phase 2:**
1. Add billing/credits to the Anthropic Console account backing the `ANTHROPIC_API_KEY` secret, then re-verify the auto-fix pipeline produces an actual PR.
2. If this is meant to serve more than one app/repo, design the per-device → target-repo mapping described in §5.
3. Consider a rate/volume cap on the auto-fix dispatch beyond the existing 1-hour de-dupe.
