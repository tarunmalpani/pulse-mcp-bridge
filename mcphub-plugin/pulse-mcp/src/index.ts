import { BasePlugin } from '@mcphub/core/src/mcp/base-plugin.js';
import type {
  McpToolDefinition,
  McpContext,
  HealthStatus,
  McpActionPlanDefinition,
  PluginPricing,
  ConfigMeta,
} from '@mcphub/core/src/mcp/plugin.interface.js';
import { tools } from './tools.js';
import { handleToolCall } from './handlers.js';
import { configSchema } from './config.schema.js';
import { PulseManager } from './pulse.manager.js';

export default class PulseMcpPlugin extends BasePlugin {
  readonly name = 'pulse-mcp';
  readonly displayName = 'Pulse MCP — Mobile Device Bridge';
  readonly description =
    "Query a running React Native app's live device status, logs, crashes, and screenshots through a cloud relay, from anywhere - not just the same Wi-Fi.";
  readonly version = '1.0.0';
  readonly providerVersion = '1.0.0';
  readonly icon = 'smartphone';
  readonly category = 'DevTools';
  readonly technologies = ['React Native', 'Express', 'SQLite'];

  private manager!: PulseManager;

  // Internal tool - everything is free/unlimited, no paywalling.
  readonly pricing: PluginPricing = {
    tools: {
      free: [
        'pulse_mcp_configure',
        'pulse_mcp_status',
        'pulse_mcp_remove',
        'pulse_mcp_health_check',
        'pulse_mcp_get_logs',
        'pulse_mcp_check_connection',
        'pulse_mcp_get_device_status',
        'pulse_mcp_get_device_logs',
        'pulse_mcp_diagnose_error',
        'pulse_mcp_get_screenshot',
        'pulse_mcp_get_bug_report',
        'pulse_mcp_get_saved_bug_reports',
        'pulse_mcp_get_crash_logs',
      ],
      pro: [],
      enterprise: '*',
    },
    limits: {
      free: { callsPerMonth: -1 },
      pro: { callsPerMonth: -1 },
      enterprise: { callsPerMonth: -1 },
    },
  };

  getTools(): McpToolDefinition[] {
    return tools;
  }

  getConfigSchema() {
    return configSchema;
  }

  getSensitiveConfigFields(): string[] {
    return ['relayApiKey'];
  }

  async initialize(config: Record<string, unknown>): Promise<void> {
    await super.initialize(config);
    this.manager = new PulseManager(this.config as any);
  }

  async handleToolCall(toolName: string, args: unknown, context: McpContext): Promise<unknown> {
    return handleToolCall(toolName, args, context, this.manager);
  }

  async shutdown(): Promise<void> {
    await super.shutdown();
  }

  async healthCheck(): Promise<HealthStatus> {
    const base = await super.healthCheck();
    return { ...base, details: { status: 'running' } };
  }

  getConfigMeta(): ConfigMeta {
    return {
      groups: [{ key: 'connection', label: 'Relay Connection', order: 0 }],
      fields: {
        relayUrl: {
          group: 'connection',
          label: 'Relay URL',
          fieldType: 'text',
          description: 'Base URL of your deployed pulse-mcp relay',
          placeholder: 'https://your-relay.onrender.com',
        },
        relayApiKey: {
          group: 'connection',
          label: 'Relay API Key',
          fieldType: 'password',
          description: 'Shared secret matching the relay\'s PULSE_API_KEY',
        },
        deviceId: {
          group: 'connection',
          label: 'Device ID',
          fieldType: 'text',
          description: 'The deviceId configured in the mobile app\'s configurePulseRelay() call',
          placeholder: 'my-device-1',
        },
      },
    };
  }

  getActionPlans(): McpActionPlanDefinition[] {
    return [
      {
        name: 'pulse-mcp-setup',
        display_name: 'Pulse MCP Setup',
        description: 'Connect this plugin to your app via the pulse-mcp relay.',
        trigger_phrases: ['setup pulse mcp', 'connect my mobile app', 'connect to relay'],
        plugin_name: this.name,
        expected_outcome: 'The plugin can read live device status, logs, and crashes from your app.',
        steps: [
          {
            id: 'configure',
            order: 1,
            title: 'Configure the relay connection',
            description: 'Set relayUrl, relayApiKey, and deviceId to match your deployed relay and app config.',
            tool_to_call: 'pulse_mcp_configure',
            expected_output: '{ configured: true }',
          },
          {
            id: 'verify',
            order: 2,
            title: 'Verify the device is reachable',
            description: 'Check that the relay and device respond.',
            tool_to_call: 'pulse_mcp_check_connection',
            depends_on: ['configure'],
            expected_output: 'A connection summary with battery/OS/screen info',
          },
          {
            id: 'status',
            order: 3,
            title: 'Confirm live data is flowing',
            description: 'Pull the current device status to confirm the round trip works end to end.',
            tool_to_call: 'pulse_mcp_get_device_status',
            depends_on: ['verify'],
            expected_output: '{ status: "online", batteryLevel: ..., activeRoute: ... }',
          },
        ],
      },
    ];
  }
}
