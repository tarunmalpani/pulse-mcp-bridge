import type { PulseMcpConfig } from './config.schema.js';

interface ToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

interface ActivityLogEntry {
  timestamp: string;
  action: string;
  ok: boolean;
  detail: string;
}

const MAX_LOG_ENTRIES = 100;
const MAX_SCREENSHOT_BYTES = 900_000; // stay safely under the 1MB per-tool-call response limit

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

export class PulseManager {
  private config: PulseMcpConfig;
  private activityLog: ActivityLogEntry[] = [];

  constructor(config: PulseMcpConfig) {
    this.config = config;
  }

  updateConfig(config: PulseMcpConfig) {
    this.config = config;
  }

  private isConfigured(): boolean {
    return Boolean(this.config.relayUrl && this.config.relayApiKey && this.config.deviceId);
  }

  private recordActivity(action: string, ok: boolean, detail: string) {
    this.activityLog.push({ timestamp: new Date().toISOString(), action, ok, detail });
    if (this.activityLog.length > MAX_LOG_ENTRIES) {
      this.activityLog.shift();
    }
  }

  /** Fetches a relay route for the configured device, e.g. "/status". */
  private async fetchRelay(path: string): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new Error('Plugin is not configured - call pulse_mcp_configure with relayUrl, relayApiKey, and deviceId first.');
    }
    const url = `${this.config.relayUrl.replace(/\/$/, '')}/devices/${encodeURIComponent(this.config.deviceId)}${path}`;
    const response = await fetch(url, {
      headers: { 'x-pulse-api-key': this.config.relayApiKey },
      // A generous but bounded timeout so a single stuck relay call can't hang a tool call indefinitely.
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Relay returned HTTP ${response.status} for ${path}`);
    }
    return response.json();
  }

  private async safeFetch(action: string, path: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    try {
      const data = await this.fetchRelay(path);
      this.recordActivity(action, true, `GET ${path} -> ok`);
      return { ok: true, data };
    } catch (err) {
      // Never surface raw internal error objects/stack traces - just a short message.
      const message = err instanceof Error ? err.message : 'Unknown error reaching the relay';
      this.recordActivity(action, false, message);
      return { ok: false, error: message };
    }
  }

  // --- Settings tools ---

  async configure(args: Record<string, unknown>): Promise<ToolResult> {
    const next: PulseMcpConfig = {
      relayUrl: typeof args.relayUrl === 'string' && args.relayUrl.length > 0 ? args.relayUrl : this.config.relayUrl,
      relayApiKey: typeof args.relayApiKey === 'string' && args.relayApiKey.length > 0 ? args.relayApiKey : this.config.relayApiKey,
      deviceId: typeof args.deviceId === 'string' && args.deviceId.length > 0 ? args.deviceId : this.config.deviceId,
    };
    this.updateConfig(next);
    this.recordActivity('configure', true, 'Configuration updated');
    return textResult(
      JSON.stringify(
        {
          configured: this.isConfigured(),
          relayUrl: next.relayUrl || null,
          deviceId: next.deviceId || null,
        },
        null,
        2,
      ),
    );
  }

  async status(): Promise<ToolResult> {
    return textResult(
      JSON.stringify(
        {
          configured: this.isConfigured(),
          relayUrl: this.config.relayUrl || null,
          deviceId: this.config.deviceId || null,
          recentActivityCount: this.activityLog.length,
        },
        null,
        2,
      ),
    );
  }

  async remove(): Promise<ToolResult> {
    this.updateConfig({ relayUrl: '', relayApiKey: '', deviceId: '' });
    this.activityLog = [];
    return textResult(JSON.stringify({ removed: true }));
  }

  async healthCheck(): Promise<ToolResult> {
    if (!this.isConfigured()) {
      return textResult(JSON.stringify({ healthy: false, reason: 'not configured' }), true);
    }
    const result = await this.safeFetch('health_check', '/status');
    return textResult(JSON.stringify({ healthy: result.ok, error: result.error ?? null }), !result.ok);
  }

  async getLogs(args: Record<string, unknown>): Promise<ToolResult> {
    const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50;
    const entries = this.activityLog.slice(-limit);
    return textResult(JSON.stringify({ logs: entries }, null, 2));
  }

  // --- Core tools (Phase 1) ---

  async checkConnection(): Promise<ToolResult> {
    const result = await this.safeFetch('check_connection', '/status');
    if (!result.ok) {
      return textResult(`Mobile device is unreachable via the relay: ${result.error}`, true);
    }
    const status = result.data as Record<string, unknown>;
    const platformLabel = status.platform === 'ios' ? 'iOS' : status.platform === 'android' ? 'Android' : String(status.platform);
    const summary = `Connected to ${platformLabel} device (${status.osVersion}) - app v${status.appVersion} (build ${status.buildNumber}), battery ${status.batteryLevel}, screen: ${status.activeRoute}`;
    return { content: [{ type: 'text', text: summary }, { type: 'text', text: JSON.stringify(status, null, 2) }] };
  }

  async getDeviceStatus(): Promise<ToolResult> {
    const result = await this.safeFetch('get_device_status', '/status');
    if (!result.ok) return textResult(result.error!, true);
    return textResult(JSON.stringify(result.data, null, 2));
  }

  async getDeviceLogs(args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.safeFetch('get_device_logs', '/logs');
    if (!result.ok) return textResult(result.error!, true);
    const body = result.data as { logs?: Array<Record<string, unknown>> };
    const level = typeof args.level === 'string' ? args.level : null;
    const logs = level ? (body.logs ?? []).filter((entry) => entry.level === level) : body.logs ?? [];
    return textResult(JSON.stringify({ logs }, null, 2));
  }

  async diagnoseError(): Promise<ToolResult> {
    const [crashesResult, logsResult] = await Promise.all([
      this.safeFetch('diagnose_error:crashes', '/crashes'),
      this.safeFetch('diagnose_error:logs', '/logs'),
    ]);
    const crashes = ((crashesResult.data as { crashes?: Array<Record<string, unknown>> })?.crashes ?? []) as Array<Record<string, unknown>>;
    const logs = ((logsResult.data as { logs?: Array<Record<string, unknown>> })?.logs ?? []) as Array<Record<string, unknown>>;

    const latestCrash = crashes.length > 0 ? crashes[0] : null;
    const latestErrorLog = [...logs].reverse().find((entry) => entry.level === 'error') ?? null;
    const crashTime = latestCrash ? Date.parse(String(latestCrash.timestamp)) : -Infinity;
    const logTime = latestErrorLog ? Date.parse(String(latestErrorLog.timestamp)) : -Infinity;

    if (!latestCrash && !latestErrorLog) {
      return textResult('Nothing to diagnose yet - no crash captured and no error-level log found on the device.');
    }

    if (latestCrash && crashTime >= logTime) {
      const diagnosis = {
        found: true,
        diagnosedFrom: 'crash',
        errorMessage: latestCrash.message,
        source: latestCrash.source,
        isFatal: latestCrash.isFatal,
        occurredAt: latestCrash.timestamp,
        device: latestCrash.device,
        breadcrumbsBeforeCrash: latestCrash.breadcrumbs ?? [],
        ...categorizeErrorMessage(String(latestCrash.message ?? '')),
      };
      return textResult(JSON.stringify(diagnosis, null, 2));
    }

    const diagnosis = {
      found: true,
      diagnosedFrom: 'log',
      errorMessage: latestErrorLog!.message,
      source: latestErrorLog!.source,
      occurredAt: latestErrorLog!.timestamp,
      device: latestErrorLog!.device,
      ...categorizeErrorMessage(String(latestErrorLog!.message ?? '')),
    };
    return textResult(JSON.stringify(diagnosis, null, 2));
  }

  async getScreenshot(): Promise<ToolResult> {
    const result = await this.safeFetch('get_screenshot', '/screenshot');
    if (!result.ok) return textResult(result.error!, true);
    const { image, mimeType } = result.data as { image: string; mimeType: string };
    const approxBytes = Math.floor((image?.length ?? 0) * 0.75);
    if (approxBytes > MAX_SCREENSHOT_BYTES) {
      return textResult(`Screenshot captured but too large to return (${approxBytes} bytes) - stays under the plugin response size limit by not sending it.`, true);
    }
    return { content: [{ type: 'image', data: image, mimeType }] };
  }

  async getBugReport(): Promise<ToolResult> {
    const sessionResult = await this.safeFetch('get_bug_report:session', '/session');
    if (!sessionResult.ok) return textResult(sessionResult.error!, true);
    const session = sessionResult.data as { recording?: boolean; steps?: Array<Record<string, unknown>> };
    if (!session.steps || session.steps.length === 0) {
      return textResult(
        session.recording
          ? 'Recording is active but no steps have been captured yet.'
          : "No bug report recorded. Tap 'Start Recording' in the app, reproduce the issue, then tap 'Stop Recording'.",
      );
    }
    const lastStep = session.steps[session.steps.length - 1];
    const looksLikeFailure = /error|fail|fatal|exception/i.test(String(lastStep.description ?? ''));
    const statusResult = await this.safeFetch('get_bug_report:status', '/status');
    const status = statusResult.ok ? (statusResult.data as Record<string, unknown>) : null;
    const report = {
      recording: session.recording,
      totalSteps: session.steps.length,
      steps: session.steps,
      likelyFailurePoint: looksLikeFailure ? lastStep : null,
      deviceContext: status
        ? { platform: status.platform, osVersion: status.osVersion, appVersion: status.appVersion, buildNumber: status.buildNumber }
        : null,
    };
    return textResult(JSON.stringify(report, null, 2));
  }

  async getSavedBugReports(): Promise<ToolResult> {
    const result = await this.safeFetch('get_saved_bug_reports', '/reports');
    if (!result.ok) return textResult(result.error!, true);
    const reports = (result.data as { reports?: unknown[] }).reports ?? [];
    if (reports.length === 0) {
      return textResult("No saved bug reports yet. Reports are auto-saved every time 'Stop Recording' is tapped in the app.");
    }
    return textResult(JSON.stringify({ reports }, null, 2));
  }

  async getCrashLogs(): Promise<ToolResult> {
    const result = await this.safeFetch('get_crash_logs', '/crashes');
    if (!result.ok) return textResult(result.error!, true);
    const crashes = ((result.data as { crashes?: Array<Record<string, unknown>> }).crashes ?? []) as Array<Record<string, unknown>>;
    if (crashes.length === 0) {
      return textResult('No crashes captured. The app has not hit an uncaught exception, render error, or unhandled promise rejection.');
    }
    const categorized = crashes.map((c) => ({ ...c, ...categorizeErrorMessage(String(c.message ?? '')) }));
    return textResult(JSON.stringify({ crashes: categorized }, null, 2));
  }
}

/** Categorizes an error/crash message into a likely cause + suggestion. */
function categorizeErrorMessage(message: string): { likelyCause: string; suggestion: string } {
  if (/cannot read propert(y|ies) .*(undefined|null)|undefined is not an object|null is not an object/i.test(message)) {
    return { likelyCause: 'null/undefined property access', suggestion: "code is reading a property off a value that's undefined/null - check the top stack frame for the exact line" };
  }
  if (/is not a function/i.test(message)) {
    return { likelyCause: 'calling a non-function value', suggestion: 'something expected to be a function was not - check for a typo, a missing import, or a wrong prop type' };
  }
  if (/timeout/i.test(message)) {
    return { likelyCause: 'network timeout', suggestion: 'a request timed out - check connectivity or API responsiveness' };
  }
  if (/404/.test(message)) {
    return { likelyCause: 'endpoint not found', suggestion: 'endpoint not found - check the URL/route' };
  }
  if (/enotfound|dns/i.test(message)) {
    return { likelyCause: 'DNS/host resolution failure', suggestion: 'the host could not be resolved - check the URL or network connection' };
  }
  if (/network request failed|fetch/i.test(message)) {
    return { likelyCause: 'network request failed', suggestion: 'check the breadcrumbs for the specific API call that failed' };
  }
  if (/permission|denied/i.test(message)) {
    return { likelyCause: 'permission denied', suggestion: 'the app may be missing a required OS-level permission' };
  }
  return { likelyCause: 'unclear from message alone', suggestion: 'inspect the stack trace and breadcrumbs below for clues' };
}
