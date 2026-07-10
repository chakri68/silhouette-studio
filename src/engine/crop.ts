import { state, hasImage } from "../state";
import { markDirty, applyTransform, setOverlayRenderer, type ViewInfo } from "./canvas";
import { screenToImage, isPanActive } from "./viewport";

/**
 * Interactive crop. Enter the mode, then drag out a rectangle (image space),
 * move it, or grab a handle to resize. Apply commits a `crop` transform; Cancel
 * leaves the image untouched. The rectangle is drawn by the canvas render loop
 * via `setOverlayRenderer`, so it stays crisp and pans/zooms with the view.
 *
 * While active the brush stands down (it checks `isCropActive`); two-finger
 * zoom and space-pan still work, and a pan cancels any in-progress crop drag.
 */

type Rect = { x: number; y: number; w: number; h: number };

// Eight resize handles as (hx, hy) in {-1, 0, 1}, skipping the center. The pair
// also names which edges move: -1 = min edge, 1 = max edge, 0 = fixed.
const HANDLES: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

const HANDLE_HIT = 14; // CSS px: generous grab radius (finger-friendly)
const HANDLE_HALF = 4; // CSS px: half the drawn handle square

let active = false;
let rect: Rect | null = null;
let onChange: (() => void) | null = null;

type Drag =
  | { kind: "new"; ax: number; ay: number }
  | { kind: "move"; ox: number; oy: number; orig: Rect }
  | { kind: "resize"; hx: number; hy: number; orig: Rect };
let drag: Drag | null = null;

export function isCropActive(): boolean {
  return active;
}

/** Fired when the mode toggles on/off, so the UI can show/hide the crop bar. */
export function setCropListener(cb: () => void): void {
  onChange = cb;
}

export function enterCrop(): void {
  if (!hasImage() || active) return;
  active = true;
  // Start inset, not full-frame: the margin gives you somewhere to drag out a
  // fresh rectangle (a drag that starts *inside* the rect moves it instead), and
  // it reads as "adjustable." Expand back to the edges via the handles.
  const mx = Math.round(state.W * 0.1);
  const my = Math.round(state.H * 0.1);
  rect = { x: mx, y: my, w: state.W - mx * 2, h: state.H - my * 2 };
  markDirty();
  onChange?.();
}

export function cancelCrop(): void {
  if (!active) return;
  active = false;
  rect = null;
  drag = null;
  markDirty();
  onChange?.();
}

export function applyCrop(): void {
  if (!active) return;
  const r = rect ? clamp(normalize(rect)) : null;
  active = false;
  rect = null;
  drag = null;
  onChange?.();
  // Skip the transform when the selection is the full image (nothing to do).
  const changes = r && (r.x > 0 || r.y > 0 || r.w < state.W || r.h < state.H);
  if (r && changes) applyTransform({ type: "crop", x: r.x, y: r.y, w: r.w, h: r.h });
  else markDirty();
}

/** Left/top-anchored, non-negative rect (drags can produce inverted ones). */
function normalize(r: Rect): Rect {
  return {
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  };
}

/** Keep a rect inside the image, at least 1px each side. */
function clamp(r: Rect): Rect {
  const x = Math.max(0, Math.min(state.W - 1, r.x));
  const y = Math.max(0, Math.min(state.H - 1, r.y));
  return {
    x,
    y,
    w: Math.max(1, Math.min(state.W - x, r.w)),
    h: Math.max(1, Math.min(state.H - y, r.h)),
  };
}

/** Resize `o` by moving the (hx, hy) handle to image point `p`; opposite edges fixed. */
function resized(o: Rect, hx: number, hy: number, p: { x: number; y: number }): Rect {
  let { x, y, w, h } = o;
  if (hx === -1) {
    const right = o.x + o.w;
    x = Math.min(p.x, right - 1);
    w = right - x;
  } else if (hx === 1) {
    w = Math.max(1, p.x - o.x);
  }
  if (hy === -1) {
    const bottom = o.y + o.h;
    y = Math.min(p.y, bottom - 1);
    h = bottom - y;
  } else if (hy === 1) {
    h = Math.max(1, p.y - o.y);
  }
  return { x, y, w, h };
}

export function initCrop(canvas: HTMLCanvasElement): void {
  const toImage = (e: PointerEvent): { x: number; y: number } => {
    const b = canvas.getBoundingClientRect();
    return screenToImage(e.clientX - b.left, e.clientY - b.top);
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!active || !rect || e.button !== 0 || isPanActive()) return;
    const b = canvas.getBoundingClientRect();
    const sx = e.clientX - b.left;
    const sy = e.clientY - b.top;
    const p = toImage(e);
    const r = normalize(rect);

    // Handle grab wins over move wins over drawing a new rect.
    for (const [hx, hy] of HANDLES) {
      const px = (r.x + ((hx + 1) / 2) * r.w) * state.scale + state.offset.x;
      const py = (r.y + ((hy + 1) / 2) * r.h) * state.scale + state.offset.y;
      if (Math.abs(px - sx) <= HANDLE_HIT && Math.abs(py - sy) <= HANDLE_HIT) {
        drag = { kind: "resize", hx, hy, orig: r };
        rect = r;
        beginDrag(canvas, e);
        return;
      }
    }
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      drag = { kind: "move", ox: p.x, oy: p.y, orig: r };
      rect = r;
      beginDrag(canvas, e);
      return;
    }
    drag = { kind: "new", ax: p.x, ay: p.y };
    rect = { x: p.x, y: p.y, w: 0, h: 0 };
    beginDrag(canvas, e);
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!active || !drag) return;
    if (isPanActive()) {
      drag = null; // a pan started mid-drag — abandon this crop gesture
      return;
    }
    const p = toImage(e);
    if (drag.kind === "new") {
      rect = clamp(normalize({ x: drag.ax, y: drag.ay, w: p.x - drag.ax, h: p.y - drag.ay }));
    } else if (drag.kind === "move") {
      const x = Math.max(0, Math.min(state.W - drag.orig.w, drag.orig.x + (p.x - drag.ox)));
      const y = Math.max(0, Math.min(state.H - drag.orig.h, drag.orig.y + (p.y - drag.oy)));
      rect = { x, y, w: drag.orig.w, h: drag.orig.h };
    } else {
      rect = clamp(resized(drag.orig, drag.hx, drag.hy, p));
    }
    markDirty();
  });

  const end = (e: PointerEvent): void => {
    if (!drag) return;
    drag = null;
    if (rect) rect = clamp(normalize(rect));
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    markDirty();
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  setOverlayRenderer(drawCrop);
}

function beginDrag(canvas: HTMLCanvasElement, e: PointerEvent): void {
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* no active pointer to capture */
  }
  e.preventDefault();
  markDirty();
}

/** Dim outside the selection, outline it, draw thirds guides + handles. */
function drawCrop(ctx: CanvasRenderingContext2D, view: ViewInfo): void {
  if (!active || !rect) return;
  const { scale, offset, dpr } = view;
  const r = normalize(rect);
  const x = (r.x * scale + offset.x) * dpr;
  const y = (r.y * scale + offset.y) * dpr;
  const w = r.w * scale * dpr;
  const h = r.h * scale * dpr;
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;

  ctx.save();

  // Scrim everywhere except the selection (even-odd = outer minus inner).
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.beginPath();
  ctx.rect(0, 0, cw, ch);
  ctx.rect(x, y, w, h);
  ctx.fill("evenodd");

  // Rule-of-thirds guides.
  ctx.strokeStyle = "rgba(255, 176, 0, 0.3)";
  ctx.lineWidth = Math.max(1, dpr * 0.75);
  ctx.beginPath();
  for (let i = 1; i < 3; i++) {
    const gx = x + (w * i) / 3;
    const gy = y + (h * i) / 3;
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
  }
  ctx.stroke();

  // Border.
  ctx.strokeStyle = "#ffb000";
  ctx.lineWidth = Math.max(1, dpr);
  ctx.strokeRect(x, y, w, h);

  // Handles.
  ctx.fillStyle = "#ffb000";
  const hs = HANDLE_HALF * dpr;
  for (const [hx, hy] of HANDLES) {
    const px = x + ((hx + 1) / 2) * w;
    const py = y + ((hy + 1) / 2) * h;
    ctx.fillRect(px - hs, py - hs, hs * 2, hs * 2);
  }

  ctx.restore();
}
