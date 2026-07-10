import { state } from "../state";
import { transformHistory } from "./history";

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
// Reused scratch canvas for the composited cutout (preview + PNG/SVG export).
const cutoutCanvas = document.createElement("canvas");
const cctx = cutoutCanvas.getContext("2d")!;

let displayCanvas: HTMLCanvasElement;
let dctx: CanvasRenderingContext2D;
let zoomReadout: HTMLElement | null = null;

let dpr = 1;
let dirty = true; // display needs a redraw
let maskDirty = false; // overlay needs recompute from mask
let maskVersion = 0; // bumped on any mask change; lets the tracer skip re-tracing

// Brush-cursor ring, tracked in CSS-pixel screen space.
const cursor = { x: 0, y: 0, visible: false };

const RING_COLOR = { add: "#ffb000", erase: "#ff6b6b" };

/** View transform snapshot handed to overlay renderers (image→screen mapping). */
export interface ViewInfo {
  scale: number;
  offset: { x: number; y: number };
  dpr: number;
}

// Extra pass drawn in screen space after the image (the crop rectangle). Kept as
// a hook so the crop module can own its own drawing without canvas.ts importing
// it — one-way dependency, no cycle.
let overlayRenderer: ((ctx: CanvasRenderingContext2D, view: ViewInfo) => void) | null = null;
export function setOverlayRenderer(cb: (ctx: CanvasRenderingContext2D, view: ViewInfo) => void): void {
  overlayRenderer = cb;
}

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
  maskVersion++;
}

/** Monotonic counter of mask changes — compare to know if a re-trace is needed. */
export function getMaskVersion(): number {
  return maskVersion;
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

/**
 * Write a foreground-alpha array into the mask (white where selected). Used to
 * pre-fill the selection from auto-segmentation. Scales to W×H if the source
 * mask came back at a different resolution.
 */
export function seedMask(alpha: Uint8ClampedArray, w: number, h: number): void {
  const img = new ImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }

  mctx.clearRect(0, 0, state.W, state.H);
  if (w === state.W && h === state.H) {
    mctx.putImageData(img, 0, 0);
  } else {
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    tmp.getContext("2d")!.putImageData(img, 0, 0);
    mctx.drawImage(tmp, 0, 0, state.W, state.H);
  }
  markMaskDirty();
}

/** The mask canvas, for tracing the silhouette (phase 6). */
export function getMaskCanvas(): HTMLCanvasElement {
  return maskCanvas;
}

/**
 * Geometric edits to the whole document. All are exact pixel remaps (no
 * resampling): flips mirror, rotations are 90° quarter-turns, crop copies a
 * sub-rectangle. Applied identically to the image, the mask, and every history
 * snapshot so the selection never drifts off the picture.
 */
export type Transform =
  | { type: "flipH" }
  | { type: "flipV" }
  | { type: "rotateCW" }
  | { type: "rotateCCW" }
  | { type: "crop"; x: number; y: number; w: number; h: number };

/** Draw `src` (of size sw×sh) into a fresh canvas under transform `t`. */
function renderTransform(
  t: Transform,
  src: CanvasImageSource,
  sw: number,
  sh: number,
): HTMLCanvasElement {
  const swaps = t.type === "rotateCW" || t.type === "rotateCCW";
  const out = document.createElement("canvas");
  out.width = t.type === "crop" ? t.w : swaps ? sh : sw;
  out.height = t.type === "crop" ? t.h : swaps ? sw : sh;
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // exact copy — no blur at 90°/mirror
  switch (t.type) {
    case "flipH":
      ctx.translate(sw, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(src, 0, 0);
      break;
    case "flipV":
      ctx.translate(0, sh);
      ctx.scale(1, -1);
      ctx.drawImage(src, 0, 0);
      break;
    case "rotateCW":
      ctx.translate(out.width, 0);
      ctx.rotate(Math.PI / 2);
      ctx.drawImage(src, 0, 0);
      break;
    case "rotateCCW":
      ctx.translate(0, out.height);
      ctx.rotate(-Math.PI / 2);
      ctx.drawImage(src, 0, 0);
      break;
    case "crop":
      ctx.drawImage(src, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
      break;
  }
  return out;
}

/** Run a history snapshot's alpha through the same transform as the image. */
function remapAlpha(
  t: Transform,
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
): { alpha: Uint8ClampedArray; w: number; h: number } {
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0, j = 0; i < alpha.length; i++, j += 4) {
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = alpha[i];
  }
  sctx.putImageData(img, 0, 0);

  const out = renderTransform(t, src, w, h);
  const od = out.getContext("2d")!.getImageData(0, 0, out.width, out.height).data;
  const na = new Uint8ClampedArray(out.width * out.height);
  for (let i = 0, j = 3; i < na.length; i++, j += 4) na[i] = od[j];
  return { alpha: na, w: out.width, h: out.height };
}

/**
 * Apply a transform to the whole document: image, mask, history, and view. Crop
 * coords are clamped to the current bounds first. Snapshots are transformed via
 * the same `renderTransform`, so undo/redo stay pixel-aligned after the edit.
 */
export function applyTransform(t: Transform): void {
  if (!state.image) return;
  const sw = state.W;
  const sh = state.H;

  if (t.type === "crop") {
    const x = Math.max(0, Math.min(sw - 1, Math.round(t.x)));
    const y = Math.max(0, Math.min(sh - 1, Math.round(t.y)));
    const w = Math.max(1, Math.min(sw - x, Math.round(t.w)));
    const h = Math.max(1, Math.min(sh - y, Math.round(t.h)));
    t = { type: "crop", x, y, w, h };
  }

  // Compute the new pixels from the *current* canvases before resizing (which
  // clears them).
  const nextImage = renderTransform(t, imageCanvas, sw, sh);
  const nextMask = renderTransform(t, maskCanvas, sw, sh);
  const nw = nextImage.width;
  const nh = nextImage.height;

  state.W = nw;
  state.H = nh;
  for (const c of [imageCanvas, maskCanvas, overlayCanvas]) {
    c.width = nw;
    c.height = nh;
  }
  ictx.clearRect(0, 0, nw, nh);
  ictx.drawImage(nextImage, 0, 0);
  mctx.clearRect(0, 0, nw, nh);
  mctx.drawImage(nextMask, 0, 0);

  transformHistory((alpha, aw, ah) => remapAlpha(t, alpha, aw, ah));

  fitView();
  markMaskDirty(); // overlay recompute + re-trace on next frame
}

/** Composite the final cutout: image kept only where selected (4.6). */
export function buildCutout(): HTMLCanvasElement {
  cutoutCanvas.width = state.W;
  cutoutCanvas.height = state.H;
  cctx.globalCompositeOperation = "source-over";
  cctx.clearRect(0, 0, state.W, state.H);
  cctx.drawImage(imageCanvas, 0, 0);
  cctx.globalCompositeOperation = "destination-in";
  cctx.drawImage(maskCanvas, 0, 0);
  cctx.globalCompositeOperation = "source-over";
  return cutoutCanvas;
}

/** True when no pixel is selected — guard exports (§11). */
export function isMaskEmpty(): boolean {
  if (!state.image) return true;
  const { data } = mctx.getImageData(0, 0, state.W, state.H);
  for (let j = 3; j < data.length; j += 4) {
    if (data[j] !== 0) return false;
  }
  return true;
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

  overlayRenderer?.(dctx, { scale, offset, dpr });
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
