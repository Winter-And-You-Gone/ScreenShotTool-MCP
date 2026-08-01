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

import type { AppProfile, ControlEntry } from "./types.js";
import type { UiElementSelector } from "../uia/types.js";

const sourceDerived = (
  selectors: UiElementSelector | UiElementSelector[],
  notes?: string
): ControlEntry => ({
  selectors: Array.isArray(selectors) ? selectors : [selectors],
  confidence: "source-derived",
  ...(notes ? { notes } : {})
});

export const vaporViewProfile: AppProfile = {
  id: "vaporview",
  displayName: "VaporView",
  processNames: ["VaporView"],
  titleContains: ["VaporView"],
  controls: {
    mainWindow: sourceDerived([
      { controlType: "Window", name: "VaporView", frameworkId: "Qt" },
      { controlType: "Window", frameworkId: "Qt" }
    ], "Source-derived Qt window selectors; live runtime verification requires matching administrator elevation."),

    centralWidget: sourceDerived({ automationId: "appCentralWidget" }),
    mainPageStack: sourceDerived({ automationId: "mainPageStack" }),
    appSidebar: sourceDerived({ automationId: "appSidebar" }),
    mainCardsPane: sourceDerived({ automationId: "mainCardsPane" }),
    mainCardsScrollArea: sourceDerived({ automationId: "mainCardsScrollArea" }),
    sidebarButtons: sourceDerived(
      { automationId: "appSidebarButton" },
      "Multiple buttons share this objectName; provide an index after confirming live ordering."
    ),

    customTitleBar: sourceDerived({ automationId: "customTitleBar" }),
    titleBarMenuButton: sourceDerived({ automationId: "titleBarMenuButton" }),
    titleApplicationPanel: sourceDerived({ automationId: "titleApplicationPanel" }),

    windowMinimizeButton: sourceDerived({ automationId: "windowMinimizeButton" }),
    windowMaximizeButton: sourceDerived({ automationId: "windowMaximizeButton" }),
    windowCloseButton: sourceDerived({ automationId: "windowCloseButton" }),

    logSidePanel: sourceDerived({ automationId: "logSidePanel" }),
    logTextEdit: sourceDerived({ automationId: "logTextEdit" }),
    logSidePanelToggle: sourceDerived({ name: "logSidePanelToggleButton", frameworkId: "Qt" }),
    recordingStatusCard: sourceDerived({ automationId: "recordingStatusCard" }),
    recordingStatusLabel: sourceDerived({ automationId: "recordingStatusLabel" }),

    skyTelemetryPortCombo: sourceDerived({ automationId: "skyTelemetryPortCombo" }),
    epsilonPortCombo: sourceDerived({ automationId: "epsilonPortCombo" }),
    pressurePortCombo: sourceDerived({ automationId: "pressurePortCombo" }),
    humidityPortCombo: sourceDerived({ automationId: "humidityPortCombo" }),
    lidarPortCombo: sourceDerived({ automationId: "lidarPortCombo" }),
    temperaturePortCombo: sourceDerived({ automationId: "temperaturePortCombo" }),

    languageButton: sourceDerived([
      { name: "titleLanguageButton", frameworkId: "Qt" },
      { automationId: "titleLanguageButton" }
    ])
  }
};
