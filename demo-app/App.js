import { useEffect, useMemo, useState } from "react";
import {
  SafeAreaView,
  ScrollView,
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
  setCurrentRoute,
  recordLog,
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

const SCREENS = [
  { id: "HomeScreen", label: "Home" },
  { id: "DashboardScreen", label: "Dashboard" },
  { id: "SettingsScreen", label: "Settings" },
];

const TABS = [
  { id: "home", label: "Home", icon: "⌂" },
  { id: "log", label: "Log", icon: "▤" },
  { id: "ask", label: "Ask IDE", icon: "▷" },
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

function ScreenHeader({ theme, title, subtitle }) {
  return (
    <View style={styles.header}>
      <View>
        <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
        <Text style={[styles.tagline, { color: theme.textMuted }]}>{subtitle}</Text>
      </View>
      <StatusPill theme={theme} color={theme.success} label="Bridge online" />
    </View>
  );
}

function HomeTab({ theme, route, recording, stepCount, goToScreen, logSuccess, logNetworkError, toggleRecording }) {
  return (
    <>
      <ScreenHeader theme={theme} title="PulseMCP" subtitle="Live device bridge · port 8080" />

      <Card theme={theme} style={{ marginTop: 20 }}>
        <View style={styles.statusRow}>
          <View style={styles.statusItem}>
            <Text style={[styles.statusLabel, { color: theme.textFaint }]}>ACTIVE SCREEN</Text>
            <Text style={[styles.statusValue, { color: theme.text }]}>
              {SCREENS.find((s) => s.id === route)?.label}
            </Text>
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

      <SectionLabel theme={theme}>NAVIGATE</SectionLabel>
      <View style={[styles.segmented, { backgroundColor: theme.track }]}>
        {SCREENS.map((s) => {
          const active = route === s.id;
          return (
            <TouchableOpacity
              key={s.id}
              activeOpacity={0.8}
              style={[styles.segment, active && { backgroundColor: theme.card, shadowColor: theme.shadow, shadowOpacity: 0.08, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 1 }]}
              onPress={() => goToScreen(s.id, s.label)}
            >
              <Text style={[styles.segmentText, { color: active ? theme.text : theme.textMuted }]}>{s.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

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

function LogTab({ theme, recording, steps, events, savedReportCount, eventDot }) {
  return (
    <>
      <ScreenHeader theme={theme} title="Log" subtitle="What the app has done, in order" />

      <SectionLabel theme={theme} style={{ marginTop: 20 }}>
        RECORDED STEPS {recording ? "· recording" : ""}
      </SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {steps.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>
            {recording
              ? "Recording — perform actions on the Home tab and they'll show up here."
              : "Not recording. Start a recording on the Home tab to capture numbered repro steps."}
          </Text>
        ) : (
          steps.map((s, i) => (
            <View
              key={s.step}
              style={[
                styles.stepRow,
                i !== steps.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
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
      {savedReportCount > 0 ? (
        <Text style={[styles.footer, { color: theme.textFaint, marginTop: 10, textAlign: "left" }]}>
          {savedReportCount} bug report{savedReportCount === 1 ? "" : "s"} saved on this device.
        </Text>
      ) : null}

      <SectionLabel theme={theme}>ACTIVITY</SectionLabel>
      <Card theme={theme} style={{ padding: 0, overflow: "hidden" }}>
        {events.length === 0 ? (
          <Text style={[styles.emptyState, { color: theme.textFaint }]}>
            Nothing yet — actions from the Home tab will appear here.
          </Text>
        ) : (
          events.map((e, i) => (
            <View
              key={e.id}
              style={[
                styles.eventRow,
                i !== events.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
              ]}
            >
              <View style={[styles.eventDot, { backgroundColor: eventDot[e.kind] }]} />
              <Text style={[styles.eventMessage, { color: theme.text }]} numberOfLines={1}>
                {e.message}
              </Text>
              <Text style={[styles.eventTime, { color: theme.textFaint }]}>
                {e.time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </Text>
            </View>
          ))
        )}
      </Card>
    </>
  );
}

function AskIdeTab({ theme }) {
  return (
    <>
      <ScreenHeader theme={theme} title="Ask IDE" subtitle="Tap to copy a prompt for your MCP client" />
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

export default function App() {
  const theme = useTheme();
  const [activeTab, setActiveTab] = useState("home");
  const [route, setRoute] = useState(SCREENS[0].id);
  const [recording, setRecording] = useState(false);
  const [steps, setSteps] = useState([]);
  const [savedReportCount, setSavedReportCount] = useState(0);
  const [events, setEvents] = useState([]);

  useEffect(() => {
    if (__DEV__) startPulseServer();
  }, []);

  const pushEvent = (kind, message) =>
    setEvents((prev) => [{ id: Date.now() + Math.random(), kind, message, time: new Date() }, ...prev].slice(0, 20));

  function pushStep(description) {
    if (!recording) return;
    recordStep(description);
    setSteps((prev) => [...prev, { step: prev.length + 1, description }]);
  }

  function goToScreen(id, label) {
    setRoute(id);
    setCurrentRoute(id);
    pushStep(`Navigated to ${label}`);
    pushEvent("nav", `Navigated to ${label}`);
  }

  function logSuccess() {
    recordLog("Synced dashboard data", "success", "SyncService");
    pushStep("Tapped 'Sync Now'");
    pushEvent("success", "Synced dashboard data");
  }

  function logNetworkError() {
    recordLog("Network request failed: timeout after 3000ms", "error", "NetworkClient");
    pushStep("Sync failed: request timed out after 3000ms");
    pushEvent("error", "Network request failed: timeout after 3000ms");
  }

  function toggleRecording() {
    if (!recording) {
      startSessionRecording();
      setRecording(true);
      setSteps([]);
      pushEvent("record", "Recording started");
    } else {
      stopSessionRecording().then((report) => {
        setRecording(false);
        setSavedReportCount((c) => c + 1);
        pushEvent("record", `Report #${report.id} saved · ${report.steps.length} steps`);
      });
    }
  }

  const eventDot = useMemo(
    () => ({
      success: theme.success,
      error: theme.danger,
      nav: theme.accent,
      record: theme.danger,
    }),
    [theme]
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.bg }]}>
      <ExpoStatusBar style="auto" />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {activeTab === "home" && (
          <HomeTab
            theme={theme}
            route={route}
            recording={recording}
            stepCount={steps.length}
            goToScreen={goToScreen}
            logSuccess={logSuccess}
            logNetworkError={logNetworkError}
            toggleRecording={toggleRecording}
          />
        )}
        {activeTab === "log" && (
          <LogTab
            theme={theme}
            recording={recording}
            steps={steps}
            events={events}
            savedReportCount={savedReportCount}
            eventDot={eventDot}
          />
        )}
        {activeTab === "ask" && <AskIdeTab theme={theme} />}
      </ScrollView>

      <View style={[styles.tabBar, { backgroundColor: theme.tabBar, borderTopColor: theme.border }]}>
        {TABS.map((t) => {
          const active = activeTab === t.id;
          return (
            <TouchableOpacity
              key={t.id}
              activeOpacity={0.7}
              style={styles.tabItem}
              onPress={() => setActiveTab(t.id)}
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
  segmented: { flexDirection: "row", borderRadius: 12, padding: 4, gap: 4 },
  segment: { flex: 1, paddingVertical: 10, borderRadius: 9, alignItems: "center" },
  segmentText: { fontSize: 13, fontWeight: "600" },
  actionRow: { flexDirection: "row", gap: 10 },
  actionCard: { flex: 1, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  actionIcon: { fontSize: 18, fontWeight: "800", marginBottom: 8 },
  actionTitle: { fontSize: 14, fontWeight: "700" },
  actionSubtitle: { fontSize: 12, marginTop: 2 },
  recordGlyph: { width: 14, height: 14, borderRadius: 7 },
  recordTitle: { fontSize: 15, fontWeight: "700" },
  chevron: { fontSize: 20, fontWeight: "300" },
  emptyState: { fontSize: 13, textAlign: "center", paddingVertical: 28, paddingHorizontal: 16 },
  eventRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 10 },
  eventDot: { width: 7, height: 7, borderRadius: 3.5 },
  eventMessage: { fontSize: 13, fontWeight: "500", flex: 1 },
  eventTime: { fontSize: 11, fontVariant: ["tabular-nums"] },
  stepRow: { flexDirection: "row", alignItems: "center", paddingVertical: 12, paddingHorizontal: 14, gap: 12 },
  stepBadge: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  stepBadgeText: { fontSize: 12, fontWeight: "700" },
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
