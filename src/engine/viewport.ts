import { state, hasImage } from "../state";
import { markDirty } from "./canvas";

/**
 * Zoom (wheel, toward cursor) and pan (middle-mouse or space + left-drag).
 * All math is in CSS-pixel screen space; the render loop applies DPR.
 *
 * Input is deliberately funneled through pointer events so touch can be layered
 * on later without reworking the transforms.
 */

const MIN_SCALE = 0.05;
const MAX_SCALE = 40;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// Shared so the brush knows not to paint while the view is being panned.
let spaceDown = false;
let panning = false;

export function isPanActive(): boolean {
  return spaceDown || panning;
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
    if (!panning) return;
    state.offset.x += e.clientX - lastX;
    state.offset.y += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    markDirty();
  });

  const endPan = (e: PointerEvent) => {
    if (!panning) return;
    panning = false;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    canvas.style.cursor = spaceDown ? "grab" : "";
  };
  canvas.addEventListener("pointerup", endPan);
  canvas.addEventListener("pointercancel", endPan);

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
