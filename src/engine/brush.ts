import { state, hasImage } from "../state";
import { getMaskContext, markMaskDirty, setCursor } from "./canvas";
import { screenToImage, isPanActive } from "./viewport";
import { beginStroke } from "./history";

/**
 * Add/Erase brush. Paints into maskCanvas in IMAGE space so edits stay crisp at
 * any zoom (4.3). Strokes are drawn as a round-capped line from the previous to
 * the current point, so a single fast drag leaves no gaps and overlapping stamps
 * don't double-blend their anti-aliased rims.
 *
 * Add    → source-over white  (select; punches gray out of the overlay)
 * Erase  → destination-out    (deselect; overlay gray returns)
 */

type Pt = { x: number; y: number };

let last: Pt | null = null;

/** setPointerCapture throws if the pointer isn't active (e.g. synthetic events). */
function capture(el: Element, id: number): void {
  try {
    el.setPointerCapture(id);
  } catch {
    /* no active pointer — nothing to capture */
  }
}

export function initBrush(canvas: HTMLCanvasElement): void {
  const toImage = (e: PointerEvent): Pt => {
    const rect = canvas.getBoundingClientRect();
    return screenToImage(e.clientX - rect.left, e.clientY - rect.top);
  };

  const updateCursor = (e: PointerEvent): void => {
    const rect = canvas.getBoundingClientRect();
    setCursor(e.clientX - rect.left, e.clientY - rect.top, hasImage() && !isPanActive());
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !hasImage() || isPanActive()) return;
    state.isPainting = true;
    beginStroke(); // snapshot mask as it was before this stroke
    last = toImage(e);
    stamp(last);
    capture(canvas, e.pointerId);
  });

  canvas.addEventListener("pointermove", (e) => {
    updateCursor(e);
    if (!state.isPainting || !last) return;
    const p = toImage(e);
    strokeSegment(last, p);
    last = p;
  });

  const end = (e: PointerEvent): void => {
    if (!state.isPainting) return;
    state.isPainting = false;
    last = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  canvas.addEventListener("pointerenter", updateCursor);
  canvas.addEventListener("pointerleave", () => setCursor(0, 0, false));
}

/** Set composite op + paint color for the active tool. */
function configure(ctx: CanvasRenderingContext2D): void {
  if (state.tool === "add") {
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#fff";
  } else {
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "#000"; // color irrelevant for destination-out; alpha is what matters
    ctx.strokeStyle = "#000";
  }
}

function stamp(p: Pt): void {
  const ctx = getMaskContext();
  configure(ctx);
  ctx.beginPath();
  ctx.arc(p.x, p.y, state.brushSize, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over"; // always reset (gotchas §11)
  markMaskDirty();
}

function strokeSegment(a: Pt, b: Pt): void {
  const ctx = getMaskContext();
  configure(ctx);
  ctx.lineWidth = state.brushSize * 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.globalCompositeOperation = "source-over";
  markMaskDirty();
}
