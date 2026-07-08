import { state } from "../state";

/**
 * Owns the canvases and the render loop.
 *
 * All working canvases live at native image resolution (W×H) and are never
 * shown directly:
 *   imageCanvas   — source image, source of truth
 *   maskCanvas    — selection: opaque white where selected, transparent where not
 *   overlayCanvas — derived from the mask each time it changes: gray ONLY where
 *                   NOT selected
 *
 * displayCanvas fills the viewport and is redrawn under the view transform
 * whenever something is dirty.
 */

const imageCanvas = document.createElement("canvas");
const ictx = imageCanvas.getContext("2d")!;
const maskCanvas = document.createElement("canvas");
// willReadFrequently: history snapshots getImageData the mask every stroke.
const mctx = maskCanvas.getContext("2d", { willReadFrequently: true })!;
const overlayCanvas = document.createElement("canvas");
const octx = overlayCanvas.getContext("2d")!;

let displayCanvas: HTMLCanvasElement;
let dctx: CanvasRenderingContext2D;
let zoomReadout: HTMLElement | null = null;

let dpr = 1;
let dirty = true; // display needs a redraw
let maskDirty = false; // overlay needs recompute from mask

// Brush-cursor ring, tracked in CSS-pixel screen space.
const cursor = { x: 0, y: 0, visible: false };

const RING_COLOR = { add: "#ffb000", erase: "#ff6b6b" };

export function initCanvas(canvas: HTMLCanvasElement): void {
  displayCanvas = canvas;
  dctx = canvas.getContext("2d")!;
  zoomReadout = document.getElementById("zoom");

  resizeToViewport();
  window.addEventListener("resize", () => {
    resizeToViewport();
    markDirty();
  });

  requestAnimationFrame(loop);
}

export function markDirty(): void {
  dirty = true;
}

/** Mask pixels changed — recompute the overlay (once) next frame, then redraw. */
export function markMaskDirty(): void {
  maskDirty = true;
}

/** The mask context, in image space. The brush paints directly into it. */
export function getMaskContext(): CanvasRenderingContext2D {
  return mctx;
}

/** Position the brush-cursor ring (screen/CSS px). */
export function setCursor(x: number, y: number, visible: boolean): void {
  cursor.x = x;
  cursor.y = y;
  cursor.visible = visible;
  markDirty();
}

/** Match the display backing store to its CSS box scaled by devicePixelRatio. */
function resizeToViewport(): void {
  dpr = window.devicePixelRatio || 1;
  const w = displayCanvas.clientWidth;
  const h = displayCanvas.clientHeight;
  displayCanvas.width = Math.max(1, Math.round(w * dpr));
  displayCanvas.height = Math.max(1, Math.round(h * dpr));
}

/** Draw a freshly-loaded source image, reset the mask, fit the view. */
export function setImage(bitmap: ImageBitmap): void {
  state.image = bitmap;
  state.W = bitmap.width;
  state.H = bitmap.height;

  for (const c of [imageCanvas, maskCanvas, overlayCanvas]) {
    c.width = state.W;
    c.height = state.H;
  }
  ictx.clearRect(0, 0, state.W, state.H);
  ictx.drawImage(bitmap, 0, 0);

  // Start fully unselected: empty mask → overlay gray everywhere.
  mctx.clearRect(0, 0, state.W, state.H);
  recomputeOverlay();

  fitView();
  markDirty();
}

/** Center the image in the viewport at the largest scale that leaves a margin. */
export function fitView(): void {
  if (!state.image) return;
  const vw = displayCanvas.clientWidth;
  const vh = displayCanvas.clientHeight;
  const s = Math.min(vw / state.W, vh / state.H) * 0.9;
  state.scale = s;
  state.offset.x = (vw - state.W * s) / 2;
  state.offset.y = (vh - state.H * s) / 2;
  markDirty();
}

/** Derive overlay from mask: gray, then punch out the selected region (4.2). */
function recomputeOverlay(): void {
  octx.globalCompositeOperation = "source-over";
  octx.clearRect(0, 0, state.W, state.H);
  octx.fillStyle = "rgba(120,120,120,0.6)";
  octx.fillRect(0, 0, state.W, state.H);
  octx.globalCompositeOperation = "destination-out";
  octx.drawImage(maskCanvas, 0, 0);
  octx.globalCompositeOperation = "source-over";
}

function loop(): void {
  if (maskDirty) {
    recomputeOverlay();
    maskDirty = false;
    dirty = true;
  }
  if (dirty) {
    render();
    dirty = false;
  }
  requestAnimationFrame(loop);
}

function render(): void {
  dctx.setTransform(1, 0, 0, 1, 0, 0);
  dctx.clearRect(0, 0, displayCanvas.width, displayCanvas.height);

  if (!state.image) return;

  const { scale, offset } = state;
  // Fold DPR into the base transform; scale/offset stay in CSS pixels.
  dctx.setTransform(scale * dpr, 0, 0, scale * dpr, offset.x * dpr, offset.y * dpr);
  dctx.imageSmoothingEnabled = scale < 1; // crisp pixels when zoomed in
  dctx.drawImage(imageCanvas, 0, 0);
  dctx.drawImage(overlayCanvas, 0, 0);
  dctx.setTransform(1, 0, 0, 1, 0, 0);

  drawCursorRing();

  if (zoomReadout) zoomReadout.textContent = `${Math.round(scale * 100)}%`;
}

/** Brush outline in screen space, radius = brushSize * scale, tinted by tool. */
function drawCursorRing(): void {
  if (!cursor.visible) return;
  const r = state.brushSize * state.scale * dpr;
  dctx.beginPath();
  dctx.arc(cursor.x * dpr, cursor.y * dpr, r, 0, Math.PI * 2);
  dctx.lineWidth = Math.max(1, dpr);
  dctx.strokeStyle = RING_COLOR[state.tool];
  dctx.stroke();
}
