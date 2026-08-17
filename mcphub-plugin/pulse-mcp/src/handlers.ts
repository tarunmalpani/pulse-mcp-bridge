import type { McpContext } from '@mcphub/core/src/mcp/plugin.interface.js';
import type { PulseManager } from './pulse.manager.js';

export async function handleToolCall(
  toolName: string,
  args: unknown,
  _context: McpContext,
  manager: PulseManager,
) {
  const a = (args ?? {}) as Record<string, unknown>;

  switch (toolName) {
    case 'pulse_mcp_configure':
      return manager.configure(a);
    case 'pulse_mcp_status':
      return manager.status();
    case 'pulse_mcp_remove':
      return manager.remove();
    case 'pulse_mcp_health_check':
      return manager.healthCheck();
    case 'pulse_mcp_get_logs':
      return manager.getLogs(a);

    case 'pulse_mcp_check_connection':
      return manager.checkConnection();
    case 'pulse_mcp_get_device_status':
      return manager.getDeviceStatus();
    case 'pulse_mcp_get_device_logs':
      return manager.getDeviceLogs(a);
    case 'pulse_mcp_diagnose_error':
      return manager.diagnoseError();
    case 'pulse_mcp_get_screenshot':
      return manager.getScreenshot();
    case 'pulse_mcp_get_bug_report':
      return manager.getBugReport();
    case 'pulse_mcp_get_saved_bug_reports':
      return manager.getSavedBugReports();
    case 'pulse_mcp_get_crash_logs':
      return manager.getCrashLogs();

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
  }
}
