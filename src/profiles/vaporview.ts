// VaporView application profile.
//
// Selectors here are derived from the VaporView SOURCE repo's setObjectName()
// calls (Qt composes a dotted-path AutomationId from the objectName hierarchy)
// AND verified against the LIVE UIA tree of the latest asInvoker build. The
// main window title is the static string "VaporView".
//
// IMPORTANT: VaporView.exe now builds with a manifest of
//   level='asInvoker' uiAccess='false'
// (see CMakeLists.txt vaporview_set_windows_as_invoker_manifest). A non-
// elevated MCP server CAN read its UIA tree. The old requireAdministrator
// build is detected at launch and reported as VAPORVIEW_OLD_ELEVATED_BUILD -
// rebuild/install the latest VaporView; do NOT run the MCP elevated.
//
// Runtime AutomationIds are full Qt paths, e.g.
//   QApplication.MainWindow.customTitleBar.titleBarMenuButton
// Controls confirmed against the live tree are "runtime-verified"; controls
// confirmed only from source (setObjectName) but not yet reached by the live
// probe are "source-derived" and use a regex suffix match on the confirmed
// short objectName so they resolve regardless of hierarchy depth. No HWNDs,
// PIDs, RuntimeIds, absolute screen coordinates, or local paths are stored.

import type { AppProfile, ControlEntry } from "./types.js";
import type { UiElementSelector } from "../uia/types.js";

const runtimeVerified = (
  selectors: UiElementSelector | UiElementSelector[],
  notes?: string
): ControlEntry => ({
  selectors: Array.isArray(selectors) ? selectors : [selectors],
  confidence: "runtime-verified",
  ...(notes ? { notes } : {})
});

const sourceDerived = (
  selectors: UiElementSelector | UiElementSelector[],
  notes?: string
): ControlEntry => ({
  selectors: Array.isArray(selectors) ? selectors : [selectors],
  confidence: "source-derived",
  ...(notes ? { notes } : {})
});

// Prefix shared by every VaporView control (Qt composes objectName hierarchy).
const T = "QApplication.MainWindow";
const TITLE = `${T}.customTitleBar`;
const CENTRAL = `${T}.appCentralWidget`;
const LAYOUT = `${CENTRAL}.appLayoutSplitter`;
const CONTENT = `${LAYOUT}.mainContentSplitter`;
const SIDEBAR = `${LAYOUT}.appSidebar`;

// Regex suffix match on a confirmed short objectName. Robust to hierarchy
// changes; unique because objectNames are unique within the app.
const suffix = (shortName: string): UiElementSelector => ({
  automationId: `${shortName}$`,
  match: "regex"
});

export const vaporViewProfile: AppProfile = {
  id: "vaporview",
  displayName: "VaporView",
  processNames: ["VaporView"],
  titleContains: ["VaporView"],
  executableNames: ["VaporView.exe"],
  executableEnv: "VAPORVIEW_EXE",
  controls: {
    // ── Main window ──
    mainWindow: runtimeVerified([
      { controlType: "Window", name: "VaporView", frameworkId: "Qt" },
      { automationId: T, frameworkId: "Qt" }
    ], "Verified: Qt window, title 'VaporView'. The process exposes 2 extra '_q_titlebar' helper windows; window resolution scores the real main window."),

    // ── Custom title bar ──
    customTitleBar: runtimeVerified({ automationId: TITLE }),
    titleBarMenuButton: runtimeVerified({ automationId: `${TITLE}.titleBarMenuButton` }, "Opens the application menu (custom Qt menu, not a Win32 HMENU). The menu opens via InvokePattern; its items are custom-painted (titleApplicationMenuItem rows) and are NOT standard UIA MenuItem elements, so openMenu may return 0 standard items. Use ui_inspect_tree with includeProcessPopups to inspect the popup."),
    customTitleLogo: runtimeVerified({ automationId: `${TITLE}.customTitleLogo` }, "AccessibleName '展开左侧栏'; toggles the sidebar. Invoke to collapse/expand sidebar."),
    titleLanguageButton: runtimeVerified({ automationId: `${TITLE}.titleBarButton`, name: "titleLanguageButton" }, "Shares objectName 'titleBarButton'; disambiguated by accessibleName."),
    logSidePanelToggleButton: runtimeVerified({ automationId: `${TITLE}.titleBarButton`, name: "logSidePanelToggleButton" }, "Toggles the log side panel. Exposes InvokePattern but NOT TogglePattern (action-limited: invoke works, state must be verified via logSidePanel visibility, not toggleState). Safe button used by the smoke test."),
    windowMinimizeButton: runtimeVerified({ automationId: `${TITLE}.windowMinimizeButton` }),
    windowMaximizeButton: runtimeVerified({ automationId: `${TITLE}.windowMaximizeButton` }),
    windowCloseButton: runtimeVerified({ automationId: `${TITLE}.windowCloseButton` }, "Closes the app - the smoke test does NOT invoke this."),

    // ── Central content ──
    centralWidget: runtimeVerified({ automationId: CENTRAL }),
    appLayoutSplitter: runtimeVerified({ automationId: LAYOUT }),
    mainContentSplitter: runtimeVerified({ automationId: CONTENT }),
    appSidebar: runtimeVerified({ automationId: SIDEBAR }, "Verified: sidebar nav buttons are Qt CheckBox (checkable) with TogglePattern."),
    mainPageStack: runtimeVerified({ automationId: `${CONTENT}.mainPageStack` }, "QStackedWidget holding the sidebar pages (home, deviceConfigPage, etc.)."),
    mainCardsPane: sourceDerived(suffix("mainCardsPane")),
    mainCardsScrollArea: sourceDerived(suffix("mainCardsScrollArea")),

    // ── Sidebar navigation buttons ──
    // Verified: shared objectName 'appSidebarButton', exposed as CheckBox
    // (checkable, exclusive group) with TogglePattern + InvokePattern.
    // Disambiguated by accessibleName (the localized label). Names are the
    // current Chinese UI labels; a language switch would change them.
    sidebarHome: runtimeVerified({ automationId: `${SIDEBAR}.appSidebarButton`, name: "首页" }, "Nav '首页' (Home). Verify selection via toggleState=On."),
    sidebarDeviceConfig: runtimeVerified({ automationId: `${SIDEBAR}.appSidebarButton`, name: "设备配置" }, "Nav '设备配置' (Device Config)."),
    sidebarTemperature: runtimeVerified({ automationId: `${SIDEBAR}.appSidebarButton`, name: "温控" }, "Nav '温控' (Temperature)."),
    sidebarRtkConfig: runtimeVerified({ automationId: `${SIDEBAR}.appSidebarButton`, name: "RTK配置" }, "Nav 'RTK配置' (RTK Config)."),

    // ── Log side panel ──
    logSidePanel: runtimeVerified({ automationId: `${CONTENT}.logSidePanel` }),
    logListView: sourceDerived(suffix("logListView"), "The log view is a QListView (not a text edit). Read-only; supports ValuePattern."),
    logSearchEdit: sourceDerived(suffix("logSearchEdit"), "Log search QLineEdit - a safe editable input (ValuePattern + TextPattern) used by the smoke test to verify setValue/appendText/clear with restore."),
    logAutoFollowButton: sourceDerived({ automationId: "logAutoFollowButton$", match: "regex", name: "跟随" }, "Log filter checkbox '跟随' (Auto-follow) with TogglePattern. Safe checkbox for the smoke test."),
    recordingStatusCard: runtimeVerified({ automationId: `${CONTENT}.logSidePanel.recordingStatusCard` }),
    recordingStatusLabel: sourceDerived(suffix("recordingStatusLabel")),

    // ── Port ComboBoxes ──
    // Source-confirmed objectNames. NOTE: at runtime the device-config page
    // ComboBoxes expose Qt's DEFAULT objectName 'QComboBox' (ambiguous), not
    // these source-set names, so these selectors did NOT resolve against the
    // live tree. To operate a device-page combo, query by controlType
    // 'ComboBox' + ancestor instead. Kept source-derived for traceability.
    skyTelemetryPortCombo: sourceDerived(suffix("skyTelemetryPortCombo"), "Unverified at runtime: device-page combos expose default 'QComboBox' aid. Use ui_query controlType=ComboBox + ancestor."),
    epsilonPortCombo: sourceDerived(suffix("epsilonPortCombo"), "Unverified at runtime; see skyTelemetryPortCombo note."),
    pressurePortCombo: sourceDerived(suffix("pressurePortCombo"), "Unverified at runtime; see skyTelemetryPortCombo note."),
    humidityPortCombo: sourceDerived(suffix("humidityPortCombo"), "Unverified at runtime; see skyTelemetryPortCombo note."),
    lidarPortCombo: sourceDerived(suffix("lidarPortCombo"), "Unverified at runtime; see skyTelemetryPortCombo note."),
    temperaturePortCombo: sourceDerived(suffix("temperaturePortCombo"), "Unverified at runtime; see skyTelemetryPortCombo note."),

    // ── Dialog buttons (source-derived) ──
    aboutDialogOkButton: sourceDerived(suffix("aboutDialogOkButton")),
    updateCheckUpdateButton: sourceDerived(suffix("updateCheckUpdateButton")),
    updateCheckCloseButton: sourceDerived(suffix("updateCheckCloseButton"))
  }
};
