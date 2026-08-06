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

export type VisibilityResult = {
  visible: boolean;      // element exists and is not offscreen per UIA
  fullyVisible: boolean; // geometrically inside the viewport with margin
  offscreen: boolean;    // UIA reports offscreen
  elementRect?: RectLike;
  viewportRect?: RectLike;
  margin: number;
  viewportSource: "scrollContainer" | "pageRoot" | "windowClient" | "none";
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
