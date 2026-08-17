import type { McpToolDefinition } from '@mcphub/core/src/mcp/plugin.interface.js';

// Phase 1 only: the cloud relay + the 8 core device tools. The Anthropic +
// GitHub Actions auto-fix pipeline (Phase 2) is intentionally not exposed
// here - see the pulse-mcp-bridge repo's docs/pulsemcp.md for that phase.
export const tools: McpToolDefinition[] = [
  // --- Required settings tools (every plugin must have all 5) ---
  {
    name: 'pulse_mcp_configure',
    description:
      'Configure the relay connection: relayUrl (your deployed relay base URL), relayApiKey (shared secret matching the relay), and deviceId (the device to talk to).',
    category: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        relayUrl: { type: 'string', description: 'Base URL of the deployed pulse-mcp relay, e.g. https://your-relay.onrender.com' },
        relayApiKey: { type: 'string', description: 'Shared secret sent as x-pulse-api-key to the relay' },
        deviceId: { type: 'string', description: 'Which device to read from/write to on the relay' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'pulse_mcp_status',
    description: 'Check whether the plugin is configured and can reach the relay.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_remove',
    description: 'Clear the stored relay configuration and any in-memory activity log.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_health_check',
    description: 'Deep health check - pings the configured relay and reports whether it responded.',
    category: 'settings',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_logs',
    description: "Return this plugin's own recent activity log (relay calls made, successes/failures) - not the mobile app's own logs (use pulse_mcp_get_device_logs for that).",
    category: 'settings',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of log entries to return', default: 50 },
      },
      required: [],
      additionalProperties: false,
    },
  },

  // --- Core tools (Phase 1: relay-backed device bridge) ---
  {
    name: 'pulse_mcp_check_connection',
    description: 'Checks whether the configured device is reachable via the relay and returns a friendly connection summary plus raw status.',
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_device_status',
    description: "Battery level, active screen/route, OS/platform, and app version from the device's running app.",
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_device_logs',
    description: "Recent structured console/network logs captured in the mobile app's own state, optionally filtered by level.",
    category: 'core',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'success', 'error'], description: 'Only return logs at this level. Omit to return all logs.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'pulse_mcp_diagnose_error',
    description: 'Diagnoses the most recent captured crash or error-level log (whichever is newer) and returns a likely cause and suggestion.',
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_screenshot',
    description: "Live screenshot of whatever screen is currently showing on the device's app, returned as an inline image. Requires the device to be online and polling the relay for commands.",
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_bug_report',
    description: 'The current/live bug-report step recording on the device, plus device context.',
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_saved_bug_reports',
    description: 'All bug reports previously auto-saved on the device.',
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'pulse_mcp_get_crash_logs',
    description: 'All crashes automatically captured on the device, each with a stack trace, breadcrumb trail, and a best-guess likely cause.',
    category: 'core',
    inputSchema: { type: 'object', properties: {} },
  },
];
