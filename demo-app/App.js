import { useEffect, useState } from "react";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as Clipboard from "expo-clipboard";
import {
  startPulseServer,
  stopPulseServer,
  setCurrentRoute,
  recordLog,
  PulseCrashBoundary,
  debugListPersistedCrashKeys,
  getCrashes,
  getBreadcrumbs,
  startSessionRecording,
  stopSessionRecording,
  recordStep,
} from "./src/pulseServer";

const PROMPT_GROUPS = [
  {
    label: "DEVICE STATUS",
    prompts: [
      { text: "Is my phone connected?", tool: "check_mobile_connection" },
      { text: "What's my app's battery and OS version?", tool: "get_mobile_device_status" },
    ],
  },
  {
    label: "LOGS & DIAGNOSIS",
    prompts: [
      { text: "Show me the latest app logs", tool: "get_mobile_app_logs" },
      { text: "Show me only the error logs", tool: "get_mobile_app_logs" },
      { text: "Diagnose the last error in my app", tool: "diagnose_mobile_error" },
    ],
  },
  {
    label: "CRASHES",
    prompts: [
      { text: "Show me my crash logs", tool: "get_mobile_crash_logs" },
      { text: "Did my app crash?", tool: "get_mobile_crash_logs" },
      { text: "Why did my app crash?", tool: "diagnose_mobile_error" },
    ],
  },
  {
    label: "VISUAL",
    prompts: [{ text: "Take a screenshot of my app right now", tool: "get_mobile_screenshot" }],
  },
  {
    label: "BUG REPORTS",
    prompts: [
      { text: "What are the repro steps for the bug I just recorded?", tool: "get_bug_report" },
      { text: "Show me all the saved bug reports", tool: "get_saved_bug_reports" },
    ],
  },
  {
    label: "STANDUP",
    prompts: [{ text: "Give me my standup update", tool: "get_standup_snapshot" }],
  },
];

const TABS = [
  { id: "home", label: "Home", icon: "⌂", routeId: "HomeScreen" },
  { id: "log", label: "Log", icon: "▤", routeId: "LogScreen" },
  { id: "ask", label: "Ask IDE", icon: "▷", routeId: "AskIdeScreen" },
];

const PALETTE = {
  light: {
    bg: "#F5F6F8",
    card: "#FFFFFF",
    border: "#E7E9EE",
    text: "#12141A",
    textMuted: "#6B7280",
    textFaint: "#9CA3AF",
    accent: "#4F46E5",
    accentSoft: "#EEF0FF",
    success: "#059669",
    successSoft: "#E7F7F1",
    danger: "#DC2626",
    dangerSoft: "#FDEDED",
    track: "#EEF0F3",
    shadow: "#0F172A",
    tabBar: "#FFFFFF",
  },
  dark: {
    bg: "#0B0D12",
    card: "#161922",
    border: "#262B36",
    text: "#F3F4F6",
    textMuted: "#9CA3AF",
    textFaint: "#6B7280",
    accent: "#818CF8",
    accentSoft: "#1E2036",
    success: "#34D399",
    successSoft: "#123329",
    danger: "#F87171",
    dangerSoft: "#3A1B1B",
    track: "#1E222C",
    shadow: "#000000",
    tabBar: "#12141C",
  },
};

function useTheme() {
  const scheme = useColorScheme();
  return PALETTE[scheme === "dark" ? "dark" : "light"];
}

function Card({ theme, style, children }) {
  return (
    <View
      style={[
        {
          backgroundColor: theme.card,
          borderRadius: 16,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: theme.border,
          padding: 16,
          shadowColor: theme.shadow,
          shadowOffset: { width: 0, height: 6 },
          shadowOpacity: 0.06,
          shadowRadius: 12,
          elevation: 2,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

function SectionLabel({ theme, children }) {
  return <Text style={[styles.sectionLabel, { color: theme.textMuted }]}>{children}</Text>;
}

function PromptRow({ theme, text, tool }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    await Clipboard.setStringAsync(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <View style={[styles.promptRow, { backgroundColor: theme.track }]}>
      <View style={styles.promptTextWrap}>
        <Text style={[styles.promptText, { color: theme.text }]}>"{text}"</Text>
        {tool ? (
          <Text style={[styles.promptTool, { color: theme.textFaint }]}>{tool}</Text>
        ) : null}
      </View>
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={copy}
        style={[styles.copyButton, { backgroundColor: copied ? theme.successSoft : theme.card, borderColor: theme.border }]}
      >
        <Text style={[styles.copyButtonText, { color: copied ? theme.success : theme.accent }]}>
          {copied ? "Copied" : "Copy"}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function StatusPill({ theme, color, label }) {
  return (
    <View style={[styles.pill, { backgroundColor: color + "1A" }]}>
      <View style={[styles.pillDot, { backgroundColor: color }]} />
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

function ScreenHeader({ theme, title, subtitle, bridgeOnline }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.tagline, { color: theme.textMuted }]}>{subtitle}</Text>
      </View>
      <StatusPill
        theme={theme}
        color={bridgeOnline ? theme.success : theme.danger}
        label={bridgeOnline ? "Bridge online" : "Bridge offline"}
      />
    </View>
  );
}

function HomeTab({
  theme,
  activeTabLabel,
  recording,
  stepCount,
  bridgeOnline,
  logSuccess,
  logNetworkError,
  toggleRecording,
  toggleBridge,
  triggerTestCrash,
  triggerRenderCrash,
  triggerUnhandledRejection,
  checkPersistedCrashes,
  triggerRealNetworkCalls,
}) {
  return (
    <>
      <ScreenHeader theme={theme} title="PulseMCP" subtitle="Live device bridge · port 8080" bridgeOnline={bridgeOnline} />

      <Card theme={theme} style={{ marginTop: 20 }}>
        <View style={styles.statusRow}>
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>ACTIVE SCREEN</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>{activeTabLabel}</Text>
          </View>
          <View style={[styles.statusDivider, { backgroundColor: theme.border }]} />
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>RECORDING</Text>
            {recording ? (
              <View style={styles.recordingIndicator}>
                <View style={[styles.liveDot, { backgroundColor: theme.danger }]} />
                <Text style={[styles.statusValue, { color: theme.danger }]}>{stepCount} steps</Text>
              </View>
            ) : (
              <Text style={[styles.statusValue, { color: theme.textFaint }]}>Off</Text>
            )}
          </View>
        </View>
      </Card>

      <SectionLabel theme={theme}>BRIDGE CONTROL</SectionLabel>
      <TouchableOpacity activeOpacity={0.9} onPress={toggleBridge}>
        <Card
          theme={theme}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderColor: bridgeOnline ? theme.border : theme.danger,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={[styles.liveDot, { width: 10, height: 10, borderRadius: 5, backgroundColor: bridgeOnline ? theme.success : theme.danger }]} />
            <View>
              <Text style={[styles.recordTitle, { color: theme.text }]}>
                {bridgeOnline ? "Bridge is online" : "Bridge is offline"}
              </Text>
              <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>
                {bridgeOnline ? "Tap to take it offline for testing" : "Tap to bring it back online"}
              </Text>
            </View>
          </View>
          <View
            style={[
              styles.toggleTrack,
              { backgroundColor: bridgeOnline ? theme.success : theme.track },
            ]}
          >
            <View
              style={[
                styles.toggleThumb,
                { backgroundColor: theme.card, alignSelf: bridgeOnline ? "flex-end" : "flex-start" },
              ]}
            />
          </View>
        </Card>
      </TouchableOpacity>

      <SectionLabel theme={theme}>SIMULATE ACTIVITY</SectionLabel>
      <View style={styles.actionRow}>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.actionCard, { backgroundColor: theme.successSoft, borderColor: theme.border }]}
          onPress={logSuccess}
        >
          <Text style={styles.actionIcon}>✓</Text>
          <Text style={[styles.actionTitle, { color: theme.success }]}>Log success</Text>
          <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>Sync completed</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.actionCard, { backgroundColor: theme.dangerSoft, borderColor: theme.border }]}
          onPress={logNetworkError}
        >
          <Text style={styles.actionIcon}>!</Text>
          <Text style={[styles.actionTitle, { color: theme.danger }]}>Log error</Text>
          <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>Network timeout</Text>
        </TouchableOpacity>
      </View>

      <SectionLabel theme={theme}>CRASH TEST LAB (DEV ONLY)</SectionLabel>
      <Card theme={theme} style={{ borderColor: theme.danger, borderStyle: "dashed" }}>
        <Text style={[styles.actionSubtitle, { color: theme.textMuted, marginBottom: 12 }]}>
          Each button below exercises a different real crash path — none of these are fabricated
          log messages. Ask your IDE "Show me my crash logs" afterward to see
          get_mobile_crash_logs pick them up for real.
        </Text>
        <TouchableOpacity activeOpacity={0.75} onPress={triggerTestCrash} style={[styles.crashLabButton, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.crashLabButtonTitle, { color: theme.danger }]}>💥 Throw in an event handler</Text>
          <Text style={[styles.logMeta, { color: theme.textMuted }]}>caught by ErrorUtils</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={triggerRenderCrash} style={[styles.crashLabButton, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.crashLabButtonTitle, { color: theme.danger }]}>💥 Crash during render</Text>
          <Text style={[styles.logMeta, { color: theme.textMuted }]}>caught by ErrorBoundary</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={triggerUnhandledRejection} style={[styles.crashLabButton, { backgroundColor: theme.dangerSoft }]}>
          <Text style={[styles.crashLabButtonTitle, { color: theme.danger }]}>💥 Reject a promise, uncaught</Text>
          <Text style={[styles.logMeta, { color: theme.textMuted }]}>caught by rejection tracker</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={checkPersistedCrashes} style={[styles.crashLabButton, { backgroundColor: theme.accentSoft }]}>
          <Text style={[styles.crashLabButtonTitle, { color: theme.accent }]}>🔍 Check disk vs. in-memory status</Text>
          <Text style={[styles.logMeta, { color: theme.textMuted }]}>verifies persistence</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.75} onPress={triggerRealNetworkCalls} style={[styles.crashLabButton, { backgroundColor: theme.accentSoft, marginBottom: 0 }]}>
          <Text style={[styles.crashLabButtonTitle, { color: theme.accent }]}>🌐 Make 2 real network calls (1 ok, 1 fails)</Text>
          <Text style={[styles.logMeta, { color: theme.textMuted }]}>verifies network breadcrumbs</Text>
        </TouchableOpacity>
      </Card>

      <SectionLabel theme={theme}>BUG REPORT RECORDING</SectionLabel>
      <TouchableOpacity activeOpacity={0.9} onPress={toggleRecording}>
        <Card
          theme={theme}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            borderColor: recording ? theme.danger : theme.border,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View
              style={[
                styles.recordGlyph,
                { backgroundColor: recording ? theme.danger : theme.accent },
                recording && { borderRadius: 6 },
              ]}
            />
            <View>
              <Text style={[styles.recordTitle, { color: theme.text }]}>
                {recording ? "Stop recording" : "Start recording"}
              </Text>
              <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>
                {recording ? "Tap to save the bug report" : "Capture steps for get_bug_report"}
              </Text>
            </View>
          </View>
          <Text style={[styles.chevron, { color: theme.textFaint }]}>›</Text>
        </Card>
      </TouchableOpacity>
    </>
  );
}

function reportToText(report) {
  const lines = [
    `Bug Report #${report.id}`,
    new Date(report.stoppedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
    "",
    `Device: ${report.deviceInfo?.platform ?? "?"} ${report.deviceInfo?.osVersion ?? ""} · app v${report.deviceInfo?.appVersion ?? "?"} (${report.deviceInfo?.buildNumber ?? "?"})`,
    `Screen: ${report.deviceInfo?.activeRoute ?? "Unknown"} · Battery: ${report.deviceInfo?.batteryLevel ?? "—"}`,
    "",
    `Steps to reproduce (${report.steps.length}):`,
    ...report.steps.map((s) => `${s.step}. ${s.description}`),
    "",
    `Logs (${report.logs.length}):`,
    ...report.logs.map((l) => `[${l.level}] ${l.source}: ${l.message}`),
  ];
  return lines.join("\n");
}

function crashToText(crash) {
  const lines = [
    `Crash #${crash.id}${crash.isFatal ? " (fatal)" : ""}`,
    new Date(crash.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
    `Source: ${crash.source}`,
    "",
    crash.message,
    "",
    "Stack trace:",
    crash.stack ?? "(none)",
    "",
    `Breadcrumbs leading up to it (${crash.breadcrumbs?.length ?? 0}):`,
    ...(crash.breadcrumbs ?? []).map((b) => `[${b.type}] ${b.message}`),
  ];
  return lines.join("\n");
}

function CrashDetail({ theme, crash, onBack }) {
  function share() {
    Share.share({
      title: `Crash #${crash.id}`,
      message: crashToText(crash),
    });
  }

  return (
    <>
      <View style={styles.detailHeaderRow}>
        <TouchableOpacity activeOpacity={0.7} onPress={onBack} style={styles.backRow}>
          <Text style={[styles.backChevron, { color: theme.accent }]}>‹</Text>
          <Text style={[styles.backLabel, { color: theme.accent }]}>All crashes</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} onPress={share} style={[styles.shareButton, { backgroundColor: theme.track }]}>
          <Text style={[styles.shareIcon, { color: theme.accent }]}>⬆</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.title, { color: theme.text, fontSize: 22, marginTop: 12 }]}>
        Crash #{crash.id}
      </Text>
      <Text style={[styles.tagline, { color: theme.textMuted }]}>
        {new Date(crash.timestamp).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })} ·{" "}
        {crash.source}
        {crash.recoveredFromDisk ? " · recovered after restart" : ""}
      </Text>

      <SectionLabel theme={theme}>MESSAGE</SectionLabel>
      <Card theme={theme}>
        <Text style={[styles.eventMessage, { color: theme.danger, fontWeight: "700" }]}>{crash.message}</Text>
      </Card>

      <SectionLabel theme={theme}>DEVICE AT TIME OF CRASH</SectionLabel>
      <Card theme={theme}>
        <View style={styles.statusRow}>
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>SCREEN</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>{crash.device?.activeRoute ?? "Unknown"}</Text>
          </View>
          <View style={[styles.statusDivider, { backgroundColor: theme.border }]} />
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>BATTERY</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>{crash.device?.batteryLevel ?? "—"}</Text>
          </View>
        </View>
      </Card>

      <SectionLabel theme={theme}>BREADCRUMBS ({crash.breadcrumbs?.length ?? 0})</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {!crash.breadcrumbs || crash.breadcrumbs.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>No breadcrumbs captured before this crash.</Text>
        ) : (
          crash.breadcrumbs.map((b, i) => (
            <View
              key={i}
              style={[
                styles.eventRow,
                i !== crash.breadcrumbs.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View style={[styles.eventDot, { backgroundColor: b.type === "network" ? theme.accent : theme.textFaint }]} />
              <Text style={[styles.eventMessage, { color: theme.text }]} numberOfLines={2}>
                {b.message}
              </Text>
            </View>
          ))
        )}
      </Card>

      <SectionLabel theme={theme}>STACK TRACE</SectionLabel>
      <Card theme={theme}>
        <Text style={[styles.stackText, { color: theme.textMuted }]} numberOfLines={12}>
          {crash.stack ?? "(no stack trace available)"}
        </Text>
      </Card>
    </>
  );
}

function ReportDetail({ theme, report, onBack }) {
  function share() {
    Share.share({
      title: `Bug Report #${report.id}`,
      message: reportToText(report),
    });
  }

  return (
    <>
      <View style={styles.detailHeaderRow}>
        <TouchableOpacity activeOpacity={0.7} onPress={onBack} style={styles.backRow}>
          <Text style={[styles.backChevron, { color: theme.accent }]}>‹</Text>
          <Text style={[styles.backLabel, { color: theme.accent }]}>All reports</Text>
        </TouchableOpacity>
        <TouchableOpacity activeOpacity={0.7} onPress={share} style={[styles.shareButton, { backgroundColor: theme.track }]}>
          <Text style={[styles.shareIcon, { color: theme.accent }]}>⬆</Text>
        </TouchableOpacity>
      </View>

      <Text style={[styles.title, { color: theme.text, fontSize: 22, marginTop: 12 }]}>Report #{report.id}</Text>
      <Text style={[styles.tagline, { color: theme.textMuted }]}>
        {new Date(report.stoppedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
      </Text>

      <SectionLabel theme={theme}>DEVICE AT TIME OF REPORT</SectionLabel>
      <Card theme={theme}>
        <View style={styles.statusRow}>
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>SCREEN</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>{report.deviceInfo?.activeRoute ?? "Unknown"}</Text>
          </View>
          <View style={[styles.statusDivider, { backgroundColor: theme.border }]} />
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>BATTERY</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>{report.deviceInfo?.batteryLevel ?? "—"}</Text>
          </View>
        </View>
      </Card>

      <SectionLabel theme={theme}>REPRO STEPS ({report.steps.length})</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {report.steps.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>No steps were captured in this recording.</Text>
        ) : (
          report.steps.map((s, i) => (
            <View
              key={s.step}
              style={[
                styles.stepRow,
                i !== report.steps.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View style={[styles.stepBadge, { backgroundColor: theme.accentSoft }]}>
                <Text style={[styles.stepBadgeText, { color: theme.accent }]}>{s.step}</Text>
              </View>
              <Text style={[styles.eventMessage, { color: theme.text }]}>{s.description}</Text>
            </View>
          ))
        )}
      </Card>
    </>
  );
}

function LogTab({ theme, logs, savedReports, crashes, bridgeOnline }) {
  const [selectedReport, setSelectedReport] = useState(null);
  const [selectedCrash, setSelectedCrash] = useState(null);

  if (selectedReport) {
    return <ReportDetail theme={theme} report={selectedReport} onBack={() => setSelectedReport(null)} />;
  }
  if (selectedCrash) {
    return <CrashDetail theme={theme} crash={selectedCrash} onBack={() => setSelectedCrash(null)} />;
  }

  return (
    <>
      <ScreenHeader theme={theme} title="Log" subtitle="What the app has done, in order" bridgeOnline={bridgeOnline} />

      <SectionLabel theme={theme} style={{ marginTop: 20 }}>LOGS ({logs.length})</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {logs.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>
            Tap "Log success" or "Log error" on the Home tab to see entries here.
          </Text>
        ) : (
          logs.map((l, i) => (
            <View
              key={l.id}
              style={[
                styles.logRow,
                i !== logs.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View
                style={[
                  styles.logDot,
                  { backgroundColor: l.level === "error" ? theme.danger : theme.success },
                ]}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.eventMessage, { color: theme.text }]}>{l.message}</Text>
                <Text style={[styles.logMeta, { color: theme.textFaint }]}>
                  {l.source} · {l.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </Text>
              </View>
            </View>
          ))
        )}
      </Card>

      <SectionLabel theme={theme}>CRASHES ({crashes.length})</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {crashes.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>
            None captured. Uncaught exceptions, render errors, and unhandled promise rejections
            show up here automatically - no recording needed.
          </Text>
        ) : (
          crashes.map((c, i) => (
            <TouchableOpacity
              key={c.id}
              activeOpacity={0.7}
              onPress={() => setSelectedCrash(c)}
              style={[
                styles.reportRow,
                i !== crashes.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View style={[styles.stepBadge, { backgroundColor: theme.dangerSoft }]}>
                <Text style={[styles.stepBadgeText, { color: theme.danger }]}>💥</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.recordTitle, { color: theme.text, fontSize: 14 }]} numberOfLines={1}>
                  {c.message}
                </Text>
                <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>
                  {c.source}
                  {c.recoveredFromDisk ? " · recovered" : ""} ·{" "}
                  {new Date(c.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
              <Text style={[styles.chevron, { color: theme.textFaint }]}>›</Text>
            </TouchableOpacity>
          ))
        )}
      </Card>

      <SectionLabel theme={theme}>SAVED REPORTS ({savedReports.length})</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {savedReports.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>
            Stop a recording on the Home tab to save your first report here.
          </Text>
        ) : (
          savedReports.map((r, i) => (
            <TouchableOpacity
              key={r.id}
              activeOpacity={0.7}
              onPress={() => setSelectedReport(r)}
              style={[
                styles.reportRow,
                i !== savedReports.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View style={[styles.stepBadge, { backgroundColor: theme.accentSoft }]}>
                <Text style={[styles.stepBadgeText, { color: theme.accent }]}>{r.id}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.recordTitle, { color: theme.text, fontSize: 14 }]}>Report #{r.id}</Text>
                <Text style={[styles.actionSubtitle, { color: theme.textMuted }]}>
                  {r.steps.length} step{r.steps.length === 1 ? "" : "s"} ·{" "}
                  {new Date(r.stoppedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </Text>
              </View>
              <Text style={[styles.chevron, { color: theme.textFaint }]}>›</Text>
            </TouchableOpacity>
          ))
        )}
      </Card>
    </>
  );
}

function AskIdeTab({ theme, bridgeOnline }) {
  return (
    <>
      <ScreenHeader theme={theme} title="Ask IDE" subtitle="Tap to copy a prompt for your MCP client" bridgeOnline={bridgeOnline} />
      <View style={{ marginTop: 20 }}>
        {PROMPT_GROUPS.map((group) => (
          <View key={group.label} style={{ marginBottom: 20 }}>
            <Text style={[styles.promptGroupLabel, { color: theme.textFaint }]}>{group.label}</Text>
            {group.prompts.map((p) => (
              <PromptRow key={p.text} theme={theme} text={p.text} tool={p.tool} />
            ))}
          </View>
        ))}
      </View>
      <Text style={[styles.footer, { color: theme.textFaint }]}>
        Point your IDE's MCP tools at this bridge to query status, logs, screenshots, and bug reports live.
      </Text>
    </>
  );
}

function App() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState("home");
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState([]);
  const [logs, setLogs] = useState([]);
  const [savedReports, setSavedReports] = useState([]);
  const [crashes, setCrashes] = useState([]);
  const [bridgeOnline, setBridgeOnline] = useState(true);
  const [causeRenderCrash, setCauseRenderCrash] = useState(false);

  const activeTabMeta = TABS.find((t) => t.id === activeTab);

  useEffect(() => {
    if (__DEV__) startPulseServer();
    setCurrentRoute(activeTabMeta.routeId);
  }, []);

  // Crashes are captured outside React's state (global error handlers), so
  // they don't trigger a re-render on their own - refresh from the live
  // in-memory store whenever the Log tab is opened.
  useEffect(() => {
    if (activeTab === "log") {
      setCrashes([...getCrashes()]);
    }
  }, [activeTab]);

  // Deliberately throws DURING render (not inside an event handler), so it's
  // only catchable by the ErrorBoundary above, not by ErrorUtils (Task A1).
  if (causeRenderCrash) {
    const undefinedThing = undefined;
    // eslint-disable-next-line no-unused-expressions
    undefinedThing.property;
  }

  function pushStep(description) {
    if (!recording) return;
    recordStep(description);
    setSteps((prev) => [...prev, { step: prev.length + 1, description }]);
  }

  function pushLog(level, message, source) {
    setLogs((prev) => [{ id: Date.now() + Math.random(), level, message, source, time: new Date() }, ...prev].slice(0, 30));
  }

  function selectTab(tab) {
    if (tab.id === activeTab) return;
    setActiveTab(tab.id);
    setCurrentRoute(tab.routeId);
    pushStep(`Navigated to ${tab.label}`);
  }

  function logSuccess() {
    const message = "GET /api/dashboard/sync succeeded in 240ms";
    recordLog(message, "success", "SyncService");
    pushLog("success", message, "SyncService");
    pushStep("Tapped 'Sync Now'");
  }

  function logNetworkError() {
    const message = "GET /api/dashboard/sync timed out after 3000ms (ETIMEDOUT)";
    recordLog(message, "error", "NetworkClient");
    pushLog("error", message, "NetworkClient");
    pushStep("Sync failed: request timed out after 3000ms");
  }

  function triggerTestCrash() {
    throw new Error("Test crash from HomeTab (Task A1 verification) — undefined is not an object");
  }

  function triggerRenderCrash() {
    setCauseRenderCrash(true);
  }

  function triggerUnhandledRejection() {
    // Deliberately not awaited/caught - simulates a real "fire and forget"
    // async call (e.g. an analytics ping) whose failure nobody handles.
    Promise.reject(new Error("Test unhandled promise rejection (Task A3 verification)"));
  }

  async function checkPersistedCrashes() {
    const keys = await debugListPersistedCrashKeys();
    const inMemory = getCrashes();
    const recovered = inMemory.filter((c) => c.recoveredFromDisk);
    Alert.alert(
      "Crash storage status",
      `Pending on disk (not yet flushed): ${keys.length}\n` +
        `In-memory crashes: ${inMemory.length}\n` +
        `  - recovered from a previous session: ${recovered.length}\n` +
        `  - captured live this session: ${inMemory.length - recovered.length}`
    );
  }

  async function triggerRealNetworkCalls() {
    // One real request that succeeds, one to a host that can't resolve -
    // both go through the patched global.fetch, so both should show up as
    // breadcrumbs automatically, with no recordLog() call anywhere here.
    fetch("https://jsonplaceholder.typicode.com/todos/1").catch(() => {});
    fetch("https://this-domain-does-not-exist.pulsemcp-test.invalid/api").catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 1200));

    const recent = getBreadcrumbs().slice(-6);
    Alert.alert(
      "Recent breadcrumbs",
      recent.length === 0
        ? "None yet."
        : recent.map((b) => `[${b.type}] ${b.message}`).join("\n\n")
    );
  }

  function toggleRecording() {
    if (!recording) {
      startSessionRecording();
      setRecording(true);
      setSteps([]);
    } else {
      stopSessionRecording().then((report) => {
        setRecording(false);
        setSavedReports((prev) => [report, ...prev]);
      });
    }
  }

  function toggleBridge() {
    if (bridgeOnline) {
      stopPulseServer();
      setBridgeOnline(false);
    } else {
      startPulseServer();
      setBridgeOnline(true);
    }
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
      <ExpoStatusBar style="auto" />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {activeTab === "home" && (
          <HomeTab
            theme={theme}
            activeTabLabel={activeTabMeta.label}
            recording={recording}
            stepCount={steps.length}
            bridgeOnline={bridgeOnline}
            logSuccess={logSuccess}
            logNetworkError={logNetworkError}
            toggleRecording={toggleRecording}
            toggleBridge={toggleBridge}
            triggerTestCrash={triggerTestCrash}
            triggerRenderCrash={triggerRenderCrash}
            triggerUnhandledRejection={triggerUnhandledRejection}
            checkPersistedCrashes={checkPersistedCrashes}
            triggerRealNetworkCalls={triggerRealNetworkCalls}
          />
        )}
        {activeTab === "log" && (
          <LogTab theme={theme} logs={logs} savedReports={savedReports} crashes={crashes} bridgeOnline={bridgeOnline} />
        )}
        {activeTab === "ask" && <AskIdeTab theme={theme} bridgeOnline={bridgeOnline} />}
      </ScrollView>

      <View style={[styles.tabBar, { backgroundColor: theme.tabBar, borderTopColor: theme.border }]}>
        {TABS.map((t) => {
          const active = activeTab === t.id;
          return (
            <TouchableOpacity
              key={t.id}
              activeOpacity={0.7}
              style={styles.tabItem}
              onPress={() => selectTab(t)}
            >
              <Text style={[styles.tabIcon, { color: active ? theme.accent : theme.textFaint }]}>{t.icon}</Text>
              <Text style={[styles.tabLabel, { color: active ? theme.accent : theme.textFaint }]}>{t.label}</Text>
              {t.id === "log" && recording ? (
                <View style={[styles.tabBadge, { backgroundColor: theme.danger }]} />
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

export default function AppRoot() {
  return (
    <PulseCrashBoundary>
      <App />
    </PulseCrashBoundary>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  title: { fontSize: 28, fontWeight: "800", letterSpacing: -0.5 },
  tagline: { fontSize: 13, marginTop: 2 },
  pill: { flexDirection: "row", alignItems: "center", paddingVertical: 6, paddingHorizontal: 10, borderRadius: 20, gap: 6 },
  pillDot: { width: 6, height: 6, borderRadius: 3 },
  pillText: { fontSize: 12, fontWeight: "700" },
  statusRow: { flexDirection: "row", alignItems: "center" },
  statusItem: { flex: 1 },
  statusDivider: { width: StyleSheet.hairlineWidth, height: 32, marginHorizontal: 16 },
  statusLabel: { fontSize: 10, fontWeight: "700", letterSpacing: 0.6 },
  statusValue: { fontSize: 17, fontWeight: "700", marginTop: 4 },
  recordingIndicator: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  sectionLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.8, marginTop: 28, marginBottom: 10 },
  actionRow: { flexDirection: "row", gap: 10 },
  crashLabButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 8,
  },
  crashLabButtonTitle: { fontSize: 14, fontWeight: "700", flexShrink: 1, marginRight: 8 },
  actionCard: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  actionIcon: { fontSize: 18, fontWeight: "800", marginBottom: 8 },
  actionTitle: { fontSize: 14, fontWeight: "700" },
  actionSubtitle: { fontSize: 12, marginTop: 2 },
  recordGlyph: { width: 14, height: 14, borderRadius: 7 },
  toggleTrack: { width: 44, height: 26, borderRadius: 13, padding: 3, justifyContent: "center" },
  toggleThumb: { width: 20, height: 20, borderRadius: 10 },
  recordTitle: { fontSize: 15, fontWeight: "700" },
  chevron: { fontSize: 20, fontWeight: "300" },
  emptyState: { fontSize: 13, textAlign: "center", paddingVertical: 28, paddingHorizontal: 16 },
  eventMessage: { fontSize: 13, fontWeight: "500", flex: 1 },
  eventRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  eventDot: { width: 7, height: 7, borderRadius: 3.5 },
  stackText: { fontSize: 11, fontFamily: "Courier", lineHeight: 16 },
  stepRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  stepBadge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  stepBadgeText: { fontSize: 12, fontWeight: "700" },
  reportRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  logRow: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  logDot: { width: 8, height: 8, borderRadius: 4, marginTop: 4 },
  logMeta: { fontSize: 11, marginTop: 2 },
  detailHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 },
  backRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  backChevron: { fontSize: 20, fontWeight: "600" },
  backLabel: { fontSize: 15, fontWeight: "600" },
  shareButton: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  shareIcon: { fontSize: 16, fontWeight: "700" },
  footer: { fontSize: 12, textAlign: "center", marginTop: 24, lineHeight: 18 },
  promptGroupLabel: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginBottom: 8 },
  promptRow: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 12,
    paddingVertical: 12,
    paddingLeft: 14,
    paddingRight: 8,
    marginBottom: 8,
    gap: 10,
  },
  promptTextWrap: { flex: 1 },
  promptText: { fontSize: 14, fontStyle: "italic", fontWeight: "500" },
  promptTool: { fontSize: 10, marginTop: 4, fontVariant: ["tabular-nums"] },
  copyButton: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12 },
  copyButtonText: { fontSize: 12, fontWeight: "700" },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    paddingBottom: 8,
  },
  tabItem: { flex: 1, alignItems: "center", gap: 3 },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 11, fontWeight: "600" },
  tabBadge: { position: "absolute", top: 0, right: "32%", width: 7, height: 7, borderRadius: 3.5 },
});
