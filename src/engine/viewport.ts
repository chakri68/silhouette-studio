import { state, hasImage } from "../state";
import { markDirty } from "./canvas";

/**
 * Zoom and pan. All math is in CSS-pixel screen space; the render loop applies DPR.
 *
 * Desktop: wheel zooms toward the cursor, middle-mouse or space+left-drag pans.
 * Touch:   one finger paints (the brush owns it); two fingers pinch-zoom toward
 *          their midpoint and pan by moving that midpoint. When the second finger
 *          lands mid-stroke we fire the gesture-start listeners so the brush can
 *          drop the stray dot the first finger left, then take over as navigation.
 *
 * Input is funneled through pointer events so all three transforms share one path.
 */

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Shared so the brush knows not to paint while the view is being moved.
let spaceDown = false;
let panning = false; // mouse/pen drag-pan
let gesturing = false; // two-finger touch pinch/pan

export function isPanActive(): boolean {
  return spaceDown || panning || gesturing;
}

// Fired when a two-finger gesture begins. The brush registers here to abort the
// stroke its first finger may have started, so navigation never smears the mask.
const gestureStartListeners: Array<() => void> = [];
export function onGestureStart(cb: () => void): void {
  gestureStartListeners.push(cb);
}

/** Pointer (screen, CSS px) → image space. Used by every brush stroke later. */
export function screenToImage(sx: number, sy: number): { x: number; y: number } {
  return {
    x: (sx - state.offset.x) / state.scale,
    y: (sy - state.offset.y) / state.scale,
  };
}

export function initViewport(canvas: HTMLCanvasElement): void {
  let lastX = 0;
  let lastY = 0;

  // Active touch points in client coords, keyed by pointerId. The first two (in
  // insertion order) drive the pinch; extra fingers are ignored.
  const touches = new Map<number, { x: number; y: number }>();
  let pinchDist = 0; // finger spread at the previous frame (screen px)
  let prevMidX = 0; // gesture midpoint at the previous frame (canvas-relative)
  let prevMidY = 0;

  /** Geometry of the first two active touches, in client coords. */
  const pinchGeometry = (): { dist: number; midX: number; midY: number } => {
    const [a, b] = [...touches.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
  };

  /**
   * Recompute the pinch baseline from the current fingers. Called whenever a
   * finger is added or lifted so a changing finger set doesn't cause a jump.
   * Toggles `gesturing` on the two-finger threshold.
   */
  const syncPinchBaseline = (): void => {
    if (touches.size >= 2) {
      const rect = canvas.getBoundingClientRect();
      const g = pinchGeometry();
      pinchDist = g.dist;
      prevMidX = g.midX - rect.left;
      prevMidY = g.midY - rect.top;
      gesturing = true;
    } else {
      gesturing = false;
      pinchDist = 0;
    }
  };

  canvas.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      if (!hasImage()) return;
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const before = screenToImage(mx, my);

      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      state.scale = clamp(state.scale * factor, MIN_SCALE, MAX_SCALE);

      // Keep the image point under the cursor pinned in place.
      state.offset.x = mx - before.x * state.scale;
      state.offset.y = my - before.y * state.scale;
      markDirty();
    },
    { passive: false },
  );

  // Suppress middle-click autoscroll.
  canvas.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      if (!hasImage()) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const wasGesturing = gesturing;
      syncPinchBaseline();
      // Just crossed into a two-finger gesture: let the brush drop its stroke.
      if (gesturing && !wasGesturing) {
        for (const cb of gestureStartListeners) cb();
      }
      return;
    }
    const wantsPan = e.button === 1 || (e.button === 0 && spaceDown);
    if (!wantsPan || !hasImage()) return;
    panning = true;
    lastX = e.clientX;
    lastY = e.clientY;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer to capture */
    }
    canvas.style.cursor = "grabbing";
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesturing || touches.size < 2) return;

      const rect = canvas.getBoundingClientRect();
      const g = pinchGeometry();
      const midX = g.midX - rect.left;
      const midY = g.midY - rect.top;

      // Pan by the midpoint's movement, so the image tracks the fingers.
      state.offset.x += midX - prevMidX;
      state.offset.y += midY - prevMidY;

      // Zoom about the current midpoint, keeping the image point under it pinned.
      if (pinchDist > 0) {
        const before = screenToImage(midX, midY);
        state.scale = clamp(state.scale * (g.dist / pinchDist), MIN_SCALE, MAX_SCALE);
        state.offset.x = midX - before.x * state.scale;
        state.offset.y = midY - before.y * state.scale;
      }

      pinchDist = g.dist;
      prevMidX = midX;
      prevMidY = midY;
      markDirty();
      return;
    }
    if (!panning) return;
    state.offset.x += e.clientX - lastX;
    state.offset.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    markDirty();
  });

  const endTouch = (e: PointerEvent): void => {
    if (!touches.delete(e.pointerId)) return;
    syncPinchBaseline(); // recompute or clear the gesture as fingers drop off
  };

  const endPan = (e: PointerEvent) => {
    if (!panning) return;
    panning = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = spaceDown ? "grab" : "";
  };

  const onPointerEnd = (e: PointerEvent): void => {
    if (e.pointerType === "touch") endTouch(e);
    else endPan(e);
  };
  canvas.addEventListener("pointerup", onPointerEnd);
  canvas.addEventListener("pointercancel", onPointerEnd);

  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !spaceDown) {
      spaceDown = true;
      if (!panning) canvas.style.cursor = "grab";
      // Don't scroll the page on space when the canvas has focus intent.
      if (e.target === document.body || e.target === canvas) e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.code === "Space") {
      spaceDown = false;
      if (!panning) canvas.style.cursor = "";
    }
  });
}
