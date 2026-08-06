// Postcondition (expect) evaluation for pipeline steps.
//
// A step's success semantics: the tool executed AND the postcondition
// matched. InvokePattern not throwing is NOT completion - popups/dialogs
// appear asynchronously. This module polls the UIA layer until the condition
// holds or the timeout elapses. Timeout is a normal result (timedOut:true),
// not an exception; the pipeline converts it into STEP_POSTCONDITION_TIMEOUT.

import type { AppProfile } from "./profiles/types.js";
import { normalizeControlEntry, profileWindowSelector } from "./profiles/types.js";
import type { UiElementSelector, UiElementState } from "./uia/types.js";
import type { PackDefaultExpect, PackExpectCondition } from "./app-packs/types.js";
import type { GetResult, QueryResult } from "./uia/types.js";

export type ExpectContext = {
  getUiElement: (input: {
    hwnd?: string | number; pid?: number; processName?: string; titleContains?: string;
    selector: UiElementSelector; includeProcessPopups?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number;
  }) => Promise<GetResult>;
  queryUi: (input: {
    hwnd?: string | number; pid?: number; processName?: string; titleContains?: string;
    selector: UiElementSelector; includeProcessPopups?: boolean; maxDepth?: number; maxNodes?: number; timeoutMs?: number; maxResults?: number;
  }) => Promise<QueryResult>;
};

export type ExpectInput = PackDefaultExpect & {
  hwnd?: string | number;
  pid?: number;
  processName?: string;
  titleContains?: string;
  profile?: AppProfile;
  includeProcessPopups?: boolean;
  // Local search depth for the postcondition target (pack-declared search
  // scope). Never raises global query limits.
  maxDepth?: number;
};

export type ExpectResult = {
  matched: boolean;
  condition: PackExpectCondition;
  elapsedMs: number;
  timeoutMs: number;
  timedOut: boolean;
  lastObservation: unknown;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function evaluateExpect(deps: ExpectContext, input: ExpectInput): Promise<ExpectResult> {
  const start = Date.now();
  const timeoutMs = input.timeoutMs ?? 5000;
  const pollIntervalMs = input.pollIntervalMs ?? 150;
  const condition = input.condition;

  // Resolve the target selector once: profileControl wins over a raw selector.
  let selectors: UiElementSelector[];
  if (input.profileControl && input.profile) {
    const entry = normalizeControlEntry(input.profile.controls[input.profileControl]);
    if (!entry) {
      return {
        matched: false, condition, elapsedMs: Date.now() - start, timeoutMs, timedOut: true,
        lastObservation: { error: `profileControl '${input.profileControl}' not found in profile` }
      };
    }
    selectors = entry.selectors;
  } else if (input.selector) {
    selectors = [input.selector];
  } else {
    return {
      matched: false, condition, elapsedMs: Date.now() - start, timeoutMs, timedOut: true,
      lastObservation: { error: "expect requires profileControl or selector" }
    };
  }

  const win = input.profile
    ? profileWindowSelector(input.profile, { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains })
    : { hwnd: input.hwnd, pid: input.pid, processName: input.processName, titleContains: input.titleContains };

  let lastObservation: unknown = null;
  const localMaxDepth = input.maxDepth ?? 15;
  while (Date.now() - start < timeoutMs) {
    let state: UiElementState | null = null;
    let count = 0;
    if (condition === "countEquals") {
      const q = await queryOrNull(deps, win, selectors[0]!, input.includeProcessPopups, localMaxDepth);
      count = q?.count ?? 0;
      lastObservation = { count };
    } else {
      state = await firstMatch(deps, win, selectors, input.includeProcessPopups, localMaxDepth);
      lastObservation = state;
    }

    if (conditionMatches(condition, state, count, input)) {
      return { matched: true, condition, elapsedMs: Date.now() - start, timeoutMs, timedOut: false, lastObservation };
    }
    await sleep(pollIntervalMs);
  }

  return { matched: false, condition, elapsedMs: Date.now() - start, timeoutMs, timedOut: true, lastObservation };
}

function conditionMatches(
  condition: PackExpectCondition,
  state: UiElementState | null,
  count: number,
  input: ExpectInput
): boolean {
  switch (condition) {
    case "exists":
      return state !== null;
    case "notExists":
      return state === null;
    case "visible":
      return state !== null && !state.offscreen;
    case "hidden":
      return state !== null && state.offscreen;
    case "enabled":
      return state !== null && state.enabled;
    case "disabled":
      return state !== null && !state.enabled;
    case "selected":
      return state !== null && state.selected === true;
    case "notSelected":
      return state !== null && state.selected === false;
    case "expanded":
      return state !== null && state.expandCollapseState === "Expanded";
    case "collapsed":
      return state !== null && (state.expandCollapseState === "Collapsed" || state.expandCollapseState === "LeafNode");
    case "valueEquals":
      return state !== null && state.value === input.expectedValue;
    case "valueContains":
      return state !== null && state.value !== null && input.expectedValue !== undefined && state.value.includes(input.expectedValue);
    case "toggleStateEquals":
      return state !== null && state.toggleState === input.toggleState;
    case "countEquals":
      return count === input.expectedCount;
    default:
      return false;
  }
}

async function firstMatch(
  deps: ExpectContext,
  win: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  selectors: UiElementSelector[],
  includeProcessPopups?: boolean,
  localMaxDepth = 15
): Promise<UiElementState | null> {
  for (const selector of selectors) {
    try {
      const r = await deps.getUiElement({
        hwnd: win.hwnd, pid: win.pid, processName: win.processName, titleContains: win.titleContains,
        selector, includeProcessPopups, maxDepth: localMaxDepth, timeoutMs: 8000
      });
      if (r.found) return r.element;
    } catch (error) {
      // ELEMENT_AMBIGUOUS means the control EXISTS but matched several
      // elements (e.g. several menu rows). For existence conditions that IS
      // a match; for value conditions we take the first real element state.
      const code = (error as { code?: string }).code;
      if (code === "ELEMENT_AMBIGUOUS") {
        try {
          const q = await deps.queryUi({
            hwnd: win.hwnd, pid: win.pid, processName: win.processName, titleContains: win.titleContains,
            selector, includeProcessPopups, maxDepth: localMaxDepth, maxResults: 1, timeoutMs: 8000
          });
          if (q.elements.length > 0) return q.elements[0]!;
          return { automationId: "", name: "", controlType: "", className: "", frameworkId: "", processId: 0, nativeWindowHandle: "", enabled: true, offscreen: false, focusable: false, hasKeyboardFocus: false, isPassword: false, valueProtected: false, isReadOnly: null, boundingRect: null, runtimeId: [], patterns: [], value: null, rangeValue: null, minimum: null, maximum: null, smallChange: null, largeChange: null, toggleState: null, selected: null, expandCollapseState: null };
        } catch {
          // query also failed - keep polling
        }
      }
    }
  }
  return null;
}

async function queryOrNull(
  deps: ExpectContext,
  win: { hwnd?: string | number; pid?: number; processName?: string; titleContains?: string },
  selector: UiElementSelector,
  includeProcessPopups?: boolean,
  localMaxDepth = 15
): Promise<QueryResult | null> {
  try {
    return await deps.queryUi({
      hwnd: win.hwnd, pid: win.pid, processName: win.processName, titleContains: win.titleContains,
      selector, includeProcessPopups, maxDepth: localMaxDepth, maxNodes: 2000, maxResults: 100, timeoutMs: 8000
    });
  } catch {
    return null;
  }
}
