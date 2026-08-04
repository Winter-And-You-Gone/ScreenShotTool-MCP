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

const unsupported = (
  selectors: UiElementSelector | UiElementSelector[],
  notes?: string
): ControlEntry => ({
  selectors: Array.isArray(selectors) ? selectors : [selectors],
  confidence: "unsupported",
  ...(notes ? { notes } : {})
});

// Prefix shared by every VaporView control (Qt composes objectName hierarchy).
const T = "QApplication.MainWindow";
const TITLE = `${T}.customTitleBar`;
const CENTRAL = `${T}.appCentralWidget`;
const LAYOUT = `${CENTRAL}.appLayoutSplitter`;
const CONTENT = `${LAYOUT}.mainContentSplitter`;
const SIDEBAR = `${LAYOUT}.appSidebar`;
const LOG_TITLE = `${CONTENT}.logSidePanel.logPanelFrame.sectionTitleBar.logTitleActions`;

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
  requiresAsInvoker: true,
  controls: {
    // ── Main window ──
    mainWindow: runtimeVerified([
      { controlType: "Window", name: "VaporView", frameworkId: "Qt" },
      { automationId: T, frameworkId: "Qt" }
    ], "Verified: Qt window, title 'VaporView'. The process exposes 2 extra '_q_titlebar' helper windows; window resolution scores the real main window."),

    // ── Custom title bar ──
    customTitleBar: runtimeVerified({ automationId: TITLE }),
    titleBarMenuButton: runtimeVerified({ automationId: `${TITLE}.titleBarMenuButton` }, "Opens the application menu (a custom Qt floating panel of real QToolButtons, NOT a Win32 HMENU). Opens via InvokePattern. The menu rows are real Buttons with InvokePattern (verified): use openMenu to open + enumerate, openSubmenu to drill into a section, and invoke on a command row. Menu panels are Qt::Tool top-level windows owned by the same process."),
    customTitleLogo: runtimeVerified({ automationId: `${TITLE}.customTitleLogo` }, "AccessibleName '展开左侧栏'; toggles the sidebar. Invoke to collapse/expand sidebar."),
    titleLanguageButton: runtimeVerified({ automationId: `${TITLE}.titleBarButton`, name: "titleLanguageButton" }, "Shares objectName 'titleBarButton'; disambiguated by accessibleName."),
    logSidePanelToggleButton: runtimeVerified({ automationId: `${TITLE}.titleBarButton`, name: "logSidePanelToggleButton" }, "Toggles the log side panel. Exposes InvokePattern but NOT TogglePattern (action-limited: invoke works, state must be verified via logSidePanel visibility, not toggleState). Safe button used by the smoke test."),
    windowMinimizeButton: runtimeVerified({ automationId: `${TITLE}.windowMinimizeButton` }),
    windowMaximizeButton: runtimeVerified({ automationId: `${TITLE}.windowMaximizeButton` }),
    windowCloseButton: runtimeVerified({ automationId: `${TITLE}.windowCloseButton` }, "Closes the app - the smoke test does NOT invoke this."),

    // ── Title application menu (real QToolButtons, runtime-verified) ──
    // The menu is a custom Qt panel (titleApplicationPanel, a Qt::Tool top-level
    // window) whose rows are QToolButtons with stable objectNames == commandIds.
    // Qt composes a dotted-path AutomationId ending in the commandId, so a regex
    // suffix match resolves uniquely (after cross-root dedup). Section rows open
    // a submenu on keyboard-Right (NOT via InvokePattern); command rows trigger
    // via Enter/InvokePattern. Command rows that open a modal QDialog (About,
    // CheckUpdates) block InvokePattern.Invoke() until the dialog closes, so
    // profile_action invoke on them uses a non-blocking focus+Enter trigger.
    titleMenuFileSection: runtimeVerified(suffix("titleMenuFileSectionAction"), "File section row (opens submenu). Use action openSubmenu."),
    titleMenuViewSection: runtimeVerified(suffix("titleMenuViewSectionAction"), "View section row. Use openSubmenu."),
    titleMenuDeveloperSection: runtimeVerified(suffix("titleMenuDeveloperSectionAction"), "Developer section row. Use openSubmenu."),
    titleMenuHelpSection: runtimeVerified(suffix("titleMenuHelpSectionAction"), "Help section row. Use openSubmenu."),

    titleMenuRecordingFolder: runtimeVerified(suffix("titleMenuRecordingFolderAction"), "File submenu command: Recording Folder. Opens a folder dialog."),
    titleMenuDataViewer: runtimeVerified(suffix("titleMenuDataViewerAction"), "File submenu command: Data Viewer."),
    titleMenuExit: runtimeVerified(suffix("titleMenuExitAction"), "File submenu command: Exit (closes the app - smoke test does NOT invoke)."),

    titleMenuViewLogPanel: runtimeVerified(suffix("titleMenuViewLogPanelAction"), "View submenu command: Log Panel (checkable toggle). Verify via toggleState."),
    titleMenuLanguage: runtimeVerified(suffix("titleMenuLanguageAction"), "View submenu row: Language (opens nested submenu). Use openSubmenu."),
    titleMenuLanguageChinese: runtimeVerified(suffix("titleMenuLanguageChineseAction"), "Nested Language submenu command: Chinese (checkable)."),
    titleMenuLanguageEnglish: runtimeVerified(suffix("titleMenuLanguageEnglishAction"), "Nested Language submenu command: English (checkable)."),

    titleMenuUiTestMode: runtimeVerified(suffix("titleMenuUiTestModeAction"), "Developer submenu command: UI Test Mode (checkable toggle)."),
    titleMenuUiTestScenario: runtimeVerified(suffix("titleMenuUiTestScenarioAction"), "Developer submenu row: UI Test Scenario (opens nested submenu; disabled unless UI Test Mode is on). Use openSubmenu."),

    titleMenuCheckUpdates: runtimeVerified(suffix("titleMenuCheckUpdatesAction"), "Help submenu command: Check for Updates (opens a dialog)."),
    titleMenuAbout: runtimeVerified(suffix("titleMenuAboutAction"), "Help submenu command: About (opens a modal QDialog). invoke uses non-blocking focus+Enter; verify aboutDialog appeared."),

    // ── About dialog (runtime-verified) ──
    // aboutDialog is a modal QDialog (Qt::WindowModal), a top-level Window of
    // the same PID. aboutDialogOkButton is a QPushButton with InvokePattern.
    aboutDialog: runtimeVerified(suffix("aboutDialog"), "Modal About dialog (QDialog). Appears as a top-level Window after invoking titleMenuAbout. Verify appeared/disappeared via ui_get/ui_wait."),
    aboutDialogOkButton: runtimeVerified(suffix("aboutDialogOkButton"), "About dialog OK button (QPushButton, InvokePattern). Invoking it calls QDialog::accept() and the dialog closes."),
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
    logListView: runtimeVerified(suffix("logListView"), "The log view is a QListView (List). Read-only; exposes ValuePattern + SelectionPattern."),
    recordingStatusCard: runtimeVerified({ automationId: `${CONTENT}.logSidePanel.recordingStatusCard` }),
    recordingStatusLabel: runtimeVerified(suffix("recordingStatusLabel"), "Multi-line recording-status text (QLabel/Text). Read-only."),

    // ── Log title-bar actions (search / filter / clear) ──
    // logTitleActions holds three QToolButtons that all share objectName
    // 'titleBarButton' (identical full-path AutomationId). They are
    // disambiguated by accessibleName where one is set, otherwise by layout
    // order index (search=0, filter=1, clear=2 - deterministic from source).
    logSearchButton: runtimeVerified(
      { automationId: `${LOG_TITLE}.titleBarButton`, name: "logSearchButton" },
      "Search button (accessibleName logSearchButton, shares objectName titleBarButton; disambiguated by name). Invoke opens the logSearchMenu popup (QMenu). The popup exposes ONLY the QWidgetAction MenuItem in UIA - the nested logSearchEdit QLineEdit is NOT exposed in this build (no child Edit node), so ValuePattern input on it is unreachable."
    ),
    logFilterButton: runtimeVerified(
      { automationId: `${LOG_TITLE}.titleBarButton`, index: 1 },
      "Log-view filter button (2nd of 3 titleBarButton in logTitleActions; no accessibleName, disambiguated by layout index - order is stable in source). Invoke opens the logFilterMenu popup (VaporView::SingleLevelPopupMenu) with 4 real MenuItem rows."
    ),
    logSearchEdit: unsupported(
      suffix("logSearchEdit"),
      "Log search QLineEdit - defined in source inside the logSearchMenu QWidgetAction popup, but NOT exposed via UIA in the current build (the popup exposes only the QWidgetAction MenuItem; no child Edit node). setValue/appendText/clear are unsupported here. Do not drive it as an input."
    ),

    // ── Log-view filter popup + rows (runtime-verified while open) ──
    // logFilterMenu is a persistent hidden Qt::Tool window; its 4 MenuItem rows
    // appear in the UIA tree only while the menu is open. Rows are QWidgetAction
    // MenuItems with InvokePattern; the checked state is drawn-only (no
    // TogglePattern / toggleState / value exposure), so a toggle cannot be
    // verified via UIA in this build.
    logFilterMenu: runtimeVerified(suffix("logFilterMenu"), "Log-view filter popup window (VaporView::SingleLevelPopupMenu). Present as a hidden window; its rows appear only while open."),
    logFilterAttentionMenuAction: runtimeVerified(suffix("logFilterAttentionMenuAction"), "Filter row '关注' (Attention view)."),
    logFilterAllMenuAction: runtimeVerified(suffix("logFilterAllMenuAction"), "Filter row '全部' (All view)."),
    logFilterDebugMenuAction: runtimeVerified(suffix("logFilterDebugMenuAction"), "Filter row '调试' (Debug view)."),
    logFilterAutoFollowMenuAction: runtimeVerified(suffix("logFilterAutoFollowMenuAction"), "Filter row '自动跟随' (Auto follow). InvokePattern; checked state is drawn-only in this build (no TogglePattern/toggleState exposure), so the toggle cannot be verified via UIA - do NOT claim a state round-trip."),

    // ── Device-config ComboBoxes (runtime-verified) ──
    // On the device-config page these combos expose STABLE AutomationIds
    // (device<Device><Field>Combo), verified unique against the live tree after
    // cross-root dedup. Qt combos do NOT expose their popup items as UIA
    // ListItem (the popup is a QAbstractItemView with no ListItem children), so
    // selectByName/selectByIndex use the keyboard fallback (focus, Alt+Down,
    // Home, Down x index, Enter) and verify the ValuePattern value changed.
    // Baud/rate/source combos are safe for the smoke test (config-only, no
    // hardware action until Connect); port combos change the configured port.
    epsilonPortCombo: runtimeVerified(suffix("deviceEpsilonPortCombo"), "Epsilon GNSS port combo (val '未选择' when unset)."),
    pressurePortCombo: runtimeVerified(suffix("devicePressurePortCombo"), "Pressure sensor port combo."),
    humidityPortCombo: runtimeVerified(suffix("deviceHumidityPortCombo"), "Humidity sensor port combo."),
    lidarPortCombo: runtimeVerified(suffix("deviceLidarPortCombo"), "LiDAR port combo."),
    temperaturePortCombo: runtimeVerified(suffix("deviceTemperaturePortCombo"), "Temperature port combo."),
    ai8TemperaturePortCombo: runtimeVerified(suffix("deviceAi8TemperaturePortCombo"), "AI8 temperature port combo."),
    ai8TemperatureBaudCombo: runtimeVerified(suffix("deviceAi8TemperatureBaudCombo"), "AI8 temperature baud-rate combo. Safe for the smoke test (config-only)."),
    ai8TemperatureRateCombo: runtimeVerified(suffix("deviceAi8TemperatureRateCombo"), "AI8 temperature sampling-rate combo. Safe for the smoke test (config-only, small option count)."),
    pressureSourceCombo: runtimeVerified(suffix("devicePressureSourceCombo"), "Pressure device model/source combo."),
    humiditySourceCombo: runtimeVerified(suffix("deviceHumiditySourceCombo"), "Humidity device model/source combo."),

    // ── Dialog buttons (source-derived) ──
    updateCheckUpdateButton: sourceDerived(suffix("updateCheckUpdateButton"), "Update-check dialog button (source-derived; not yet reached by the live probe)."),
    updateCheckCloseButton: sourceDerived(suffix("updateCheckCloseButton"), "Update-check dialog close button (source-derived).")
  }
};
