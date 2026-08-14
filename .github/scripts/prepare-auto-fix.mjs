#!/usr/bin/env node
// Reads the repository_dispatch payload (pulse-crash or pulse-bug-report),
// fired by relay-server/lib/githubDispatch.js, and turns it into:
//   - a branch name / PR title (written to $GITHUB_OUTPUT)
//   - a prompt file for the headless Claude Code step to consume
//
// See the "Automated crash-fix pipeline" section of the architecture plan for context.

import fs from "fs";

const eventPath = process.env.GITHUB_EVENT_PATH;
const outputPath = process.env.GITHUB_OUTPUT;

const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
const kind = event.action; // "pulse-crash" or "pulse-bug-report"
const payload = event.client_payload || {};

const shortHash = Math.random().toString(16).slice(2, 8); // uniqueness only; not a content hash - dedupe already happened on the relay
const timestamp = Date.now();

let branch;
let title;
let prompt;

if (kind === "pulse-crash") {
  branch = `preview/crash-${shortHash}-${timestamp}`;
  title = `🤖 Automated fix: ${truncate(payload.message, 72)}`;
  prompt = [
    "A crash was automatically captured from a running mobile app (via pulse-mcp-bridge's crash capture + relay).",
    "Investigate the root cause in this repository and apply a fix if you can find one. Do not make unrelated changes.",
    "",
    `Device: ${JSON.stringify(payload.device)}`,
    `Occurred at: ${payload.timestamp}`,
    "",
    `Error message: ${payload.message}`,
    "",
    "Stack trace:",
    payload.stack || "(none)",
    "",
    payload.componentStack ? `Component stack:\n${payload.componentStack}\n` : "",
    "Breadcrumbs leading up to the crash (oldest first):",
    JSON.stringify(payload.breadcrumbs || [], null, 2),
    "",
    "If you can identify and fix the root cause, make the minimal necessary change. If you cannot find an actionable root cause in this repo, make no changes at all.",
  ].join("\n");
} else if (kind === "pulse-user-command") {
  branch = `preview/user-command-${shortHash}-${timestamp}`;
  title = `🤖 Automated fix: ${truncate(payload.text, 72)}`;
  prompt = [
    "A user typed a command/issue description directly into the mobile app's \"Ask IDE\" screen (via pulse-mcp-bridge's relay), asking for something to be fixed or changed in this repository.",
    "Read their request below and act on it if it describes something actionable in this repo. Do not make unrelated changes.",
    "",
    `Device that submitted this: ${payload.deviceId}`,
    `Submitted at: ${payload.submittedAt}`,
    "",
    "User's request (verbatim):",
    payload.text,
    "",
    "If you can act on this request, make the minimal necessary change. If the request is unclear, not actionable in this repo, or you can't find anything relevant, make no changes at all.",
  ].join("\n");
} else if (kind === "pulse-bug-report") {
  branch = `preview/bug-report-${shortHash}-${timestamp}`;
  title = `🤖 Automated fix: bug report from device`;
  prompt = [
    "A client/tester recorded a bug report from a running mobile app (via pulse-mcp-bridge's Start/Stop Recording feature + relay).",
    "Read their repro steps and the logs captured during that session, figure out what broke, and apply a fix if you can find one. Do not make unrelated changes.",
    "",
    `Device info: ${JSON.stringify(payload.deviceInfo)}`,
    "",
    "Numbered repro steps (in order, as described by the tester):",
    JSON.stringify(payload.steps || [], null, 2),
    "",
    "Logs captured during the session:",
    JSON.stringify(payload.logs || [], null, 2),
    "",
    "If you can identify and fix the root cause, make the minimal necessary change. If you cannot find an actionable root cause in this repo, make no changes at all.",
  ].join("\n");
} else {
  console.error(`Unknown dispatch kind: ${kind}`);
  process.exit(1);
}

fs.writeFileSync(".github/auto-fix-prompt.txt", prompt);

const output = [`kind=${kind}`, `branch=${branch}`, `title=${title}`].join("\n");
fs.appendFileSync(outputPath, output + "\n");

function truncate(str, len) {
  if (!str) return "(no message)";
  return str.length > len ? `${str.slice(0, len)}…` : str;
}
