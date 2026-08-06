// Visibility geometry for ensureVisible.
//
// A control is FULLY visible only when its bounding rectangle lies entirely
// inside the effective viewport rectangle (with an optional margin), in the
// SAME coordinate space. UIA boundingRect is screen-space physical pixels;
// the window client rect must be converted to screen space before comparing.
// Pure functions - unit-testable without UIA.

export type Rect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RectLike = Partial<Rect> & { x?: number; y?: number; width?: number; height?: number };

// Scroll direction relative to a viewport, for a vertical scrollbar whose
// value INCREASES as content scrolls DOWN (the standard mapping):
//   backward = scroll up   = value decreases = decrement
//   forward  = scroll down = value increases = increment
export type ScrollDirection = "backward" | "forward" | "none";

// Determine which way to scroll to bring `elementRect` fully inside
// `viewportRect` (with margin). Pure geometry - never uses control names or
// page types.
//   element bottom > viewport bottom - margin -> forward (scroll down;
//                                                 value increases)
//   element top < viewport top + margin       -> backward (scroll up;
//                                                 value decreases)
//   otherwise                                  -> none
// Order matters: an element hanging BELOW the viewport often also has its
// top above the viewport top (it spans the whole viewport); the bottom
// overhang decides first, so the direction is forward, never backward.
export function determineScrollDirection(
  elementRect: RectLike | null | undefined,
  viewportRect: RectLike | null | undefined,
  margin: number
): ScrollDirection {
  if (!elementRect || !viewportRect) return "none";
  const m = Math.max(0, margin);
  const e = {
    top: elementRect.y ?? 0,
    bottom: (elementRect.y ?? 0) + (elementRect.height ?? 0)
  };
  const v = {
    top: viewportRect.y ?? 0,
    bottom: (viewportRect.y ?? 0) + (viewportRect.height ?? 0)
  };
  if (e.bottom > v.bottom - m) return "forward";
  if (e.top < v.top + m) return "backward";
  return "none";
}

// Compute the next finite RangeValue step toward `direction` from the
// current value. Never jumps straight to minimum/maximum.
//   effectiveStep prefers largeChange, then smallChange, then
//   max((maximum-minimum)*0.1, 1) (the proportional step is floored at 1 so
//   tiny spans still make progress), and clamps at the range bounds.
export function nextRangeValueStep(
  current: number,
  direction: "backward" | "forward",
  range: { minimum?: number | null; maximum?: number | null; smallChange?: number | null; largeChange?: number | null }
): number {
  const min = range.minimum ?? 0;
  const max = range.maximum ?? Math.max(min + 1, current + 1);
  const span = Math.max(0, max - min);
  const effectiveStep =
    (range.largeChange ?? 0) > 0 ? range.largeChange! :
    (range.smallChange ?? 0) > 0 ? range.smallChange! :
    Math.max(span * 0.1, 1);
  if (direction === "forward") {
    return Math.min(max, current + effectiveStep);
  }
  return Math.max(min, current - effectiveStep);
}

export type VisibilityResult = {
  visible: boolean;      // element exists and is not offscreen per UIA
  fullyVisible: boolean; // geometrically inside the viewport with margin
  offscreen: boolean;    // UIA reports offscreen
  elementRect?: RectLike;
  viewportRect?: RectLike;
  margin: number;
  viewportSource: "scrollContainer" | "pageRoot" | "windowClientRect" | "windowBoundingRect" | "none";
};

export function isRectFullyVisible(
  elementRect: RectLike | null | undefined,
  viewportRect: RectLike | null | undefined,
  margin: number
): boolean {
  if (!elementRect || !viewportRect) return false;
  const m = Math.max(0, margin);
  const e = { left: elementRect.x ?? 0, top: elementRect.y ?? 0, right: (elementRect.x ?? 0) + (elementRect.width ?? 0), bottom: (elementRect.y ?? 0) + (elementRect.height ?? 0) };
  const v = { left: viewportRect.x ?? 0, top: viewportRect.y ?? 0, right: (viewportRect.x ?? 0) + (viewportRect.width ?? 0), bottom: (viewportRect.y ?? 0) + (viewportRect.height ?? 0) };
  const vw = v.right - v.left;
  const vh = v.bottom - v.top;
  // Margin larger than the viewport makes the effective viewport empty.
  if (m * 2 >= vw || m * 2 >= vh) return false;
  return e.left >= v.left + m && e.top >= v.top + m && e.right <= v.right - m && e.bottom <= v.bottom - m;
}

// Normalize a UIA boundingRect (already screen-space) or a raw rect into the
// RectLike used by the geometry checks. Returns undefined when essential
// fields are missing.
export function toRect(rect: RectLike | null | undefined): RectLike | undefined {
  if (!rect) return undefined;
  if (rect.x === undefined || rect.y === undefined || rect.width === undefined || rect.height === undefined) {
    return undefined;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

// Combine a UIA element's reported state with the geometric check. `offscreen`
// is the provider's opinion; `fullyVisible` is the geometric truth. Never
// equate offscreen:false with fully visible.
export function evaluateVisibility(
  element: {
    offscreen?: boolean | null;
    boundingRect?: RectLike | null;
  } | null | undefined,
  viewportRect: RectLike | null | undefined,
  margin: number,
  viewportSource: VisibilityResult["viewportSource"]
): VisibilityResult {
  if (!element) {
    return { visible: false, fullyVisible: false, offscreen: true, margin, viewportSource };
  }
  const offscreen = element.offscreen === true;
  const elementRect = toRect(element.boundingRect);
  const fullyVisible = isRectFullyVisible(elementRect, viewportRect, margin);
  return {
    visible: !offscreen,
    fullyVisible,
    offscreen,
    ...(elementRect ? { elementRect } : {}),
    ...(viewportRect ? { viewportRect: toRect(viewportRect) } : {}),
    margin,
    viewportSource
  };
}
