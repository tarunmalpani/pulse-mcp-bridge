import crypto from "crypto";
import { shouldDispatch } from "./db.js";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO; // e.g. "tarunmalpani/pulse-mcp-bridge"
const DISPATCH_COOLDOWN_MS = Number(process.env.DISPATCH_COOLDOWN_MS || 60 * 60 * 1000); // 1 hour

function hashOf(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/**
 * Fires a GitHub repository_dispatch event for a new crash/bug-report, unless
 * an event with the same de-dupe hash already fired within the cooldown
 * window, or GITHUB_TOKEN/GITHUB_REPO aren't configured (in which case this
 * silently no-ops - the relay still works fully without the auto-fix pipeline).
 */
export async function maybeDispatch(eventType, dedupeInput, clientPayload) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return { dispatched: false, reason: "not_configured" };

  const hash = hashOf(dedupeInput);
  if (!shouldDispatch(hash, DISPATCH_COOLDOWN_MS)) {
    console.log(`[relay] Suppressed duplicate dispatch for ${eventType} (hash=${hash}, within cooldown)`);
    return { dispatched: false, reason: "deduped", hash };
  }

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[relay] GitHub dispatch failed (${response.status}): ${text}`);
    return { dispatched: false, reason: "github_error", status: response.status };
  }

  console.log(`[relay] Dispatched ${eventType} (hash=${hash})`);
  return { dispatched: true, hash };
}

/**
 * Fires a GitHub repository_dispatch event unconditionally - no de-dupe
 * cooldown. Used for explicit one-off user actions (e.g. a command typed
 * into the app's "Ask IDE" screen), where every submission is intentional
 * and should always run, unlike crashes/bug reports which can repeat rapidly
 * for the same underlying issue.
 */
export async function dispatchNow(eventType, clientPayload) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return { dispatched: false, reason: "not_configured" };

  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[relay] GitHub dispatch failed (${response.status}): ${text}`);
    return { dispatched: false, reason: "github_error", status: response.status };
  }

  console.log(`[relay] Dispatched ${eventType}`);
  return { dispatched: true };
}
