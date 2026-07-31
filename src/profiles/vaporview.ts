// VaporView application profile.
//
// Selectors here are derived from the VaporView SOURCE repo's setObjectName()
// calls (Qt exposes objectName as the UIA AutomationId). The main window title
// is the static string "VaporView", set once and never mutated.
//
// IMPORTANT: VaporView.exe has a requireAdministrator manifest. A non-elevated
// MCP server CANNOT read its UIA tree (integrity-level boundary). To use this
// profile, run the MCP server elevated (matching VaporView's integrity level).
// Because the live tree could not be probed from this non-elevated session,
// selectors marked "source-derived" are confirmed by source review but not
// verified at runtime here. Use ui_inspect_tree to confirm against the live
// app before relying on them.
//
// No HWNDs, PIDs, RuntimeIds, absolute screen coordinates, or local paths are
// stored here. Title-bar toolbar buttons share the objectName "titleBarButton"
// (not unique), so they are disambiguated by accessibleName where the source
// sets one, and otherwise by index within the titleBar container.

import type { AppProfile } from "./types.js";

export const vaporViewProfile: AppProfile = {
  id: "vaporview",
  displayName: "VaporView",
  processNames: ["VaporView"],
  titleContains: ["VaporView"],
  controls: {
    // Main window: static title "VaporView", Qt framework.
    mainWindow: [
      { controlType: "Window", name: "VaporView", frameworkId: "Qt" },
      { controlType: "Window", frameworkId: "Qt" }
    ],

    // Central widget and primary containers (source: GroundMainWindowSetup.cpp).
    centralWidget: { automationId: "appCentralWidget" },
    mainPageStack: { automationId: "mainPageStack" },
    appSidebar: { automationId: "appSidebar" },
    mainCardsPane: { automationId: "mainCardsPane" },
    mainCardsScrollArea: { automationId: "mainCardsScrollArea" },

    // Sidebar navigation buttons share objectName "appSidebarButton" - use
    // index to pick a specific page once the live tree confirms ordering.
    // Exposed as a documented limitation rather than a fragile guess.
    sidebarButtons: { automationId: "appSidebarButton" },

    // Custom title bar (replaces the native QMenuBar, which is hidden).
    customTitleBar: { automationId: "customTitleBar" },
    titleBarMenuButton: { automationId: "titleBarMenuButton" },
    titleApplicationPanel: { automationId: "titleApplicationPanel" },

    // Window chrome buttons - unique objectNames, stable.
    windowMinimizeButton: { automationId: "windowMinimizeButton" },
    windowMaximizeButton: { automationId: "windowMaximizeButton" },
    windowCloseButton: { automationId: "windowCloseButton" },

    // Log panel and recording status.
    logSidePanel: { automationId: "logSidePanel" },
    logTextEdit: { automationId: "logTextEdit" },
    // setAccessibleName("logSidePanelToggleButton") -> exposed as UIA Name.
    logSidePanelToggle: { name: "logSidePanelToggleButton", frameworkId: "Qt" },
    recordingStatusCard: { automationId: "recordingStatusCard" },
    recordingStatusLabel: { automationId: "recordingStatusLabel" },

    // Device-config combos on the main window (source: GroundMainWindowSetup.cpp).
    // These are QComboBox with setAccessibleName(toolTip) and stable objectName.
    skyTelemetryPortCombo: { automationId: "skyTelemetryPortCombo" },
    epsilonPortCombo: { automationId: "epsilonPortCombo" },
    pressurePortCombo: { automationId: "pressurePortCombo" },
    humidityPortCombo: { automationId: "humidityPortCombo" },
    lidarPortCombo: { automationId: "lidarPortCombo" },
    temperaturePortCombo: { automationId: "temperaturePortCombo" },

    // Language button (has accessibleName, not objectName).
    languageButton: [
      // accessibleName is exposed as UIA Name when set; fall back to objectName.
      { name: "titleLanguageButton", frameworkId: "Qt" },
      { automationId: "titleLanguageButton" }
    ]
  }
};
