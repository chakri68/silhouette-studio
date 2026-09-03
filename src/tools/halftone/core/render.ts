import { areaAverage } from "./luminance";
import type { HalftoneSettings } from "./settings";

/**
 * The renderer: uniform grid in, black circles out. Framework-free and
 * canvas-agnostic — it takes a 2D context and a viewport, so the same code path
 * draws the on-screen preview and the export.
 *
 * The grid lives in working-image pixels; the viewport is the only thing that
 * knows about output pixels. Preview and export therefore agree on *which* dots
 * exist and how big they are relative to each other — export just rasterises the
 * same pattern larger, which for analytic circles is free quality.
 */

export const PAPER = "#ffffff";
export const INK = "#000000";

const TAU = Math.PI * 2;
/** Dots per path before flushing. One giant path stalls some rasterisers; one
 *  path per dot pays the fill setup 20,000 times. This is the middle. */
const BATCH = 2048;

export interface LumaField {
  luma: Float32Array;
  /** Summed-area table for `average` sampling. Null falls back to a direct loop. */
  sat: Float64Array | null;
  width: number;
  height: number;
}

/** Maps working-image space onto the output canvas. */
export interface Viewport {
  scale: number; // working px → output px
  originX: number; // where the image's top-left lands, in output px
  originY: number;
  width: number; // output canvas size
  height: number;
}

/**
 * Grid centres along one axis: `offset + spacing/2 + k·spacing` for every k whose
 * dot can touch the image at all.
 *
 * `margin` is the largest radius a dot can reach, which is why an offset grid
 * still inks the edges: a centre sitting just outside the frame keeps the sliver
 * of its circle that falls inside. Walking k from a computed bound rather than
 * looping from zero is what makes negative offsets shift the lattice instead of
 * trimming it.
 */
export function gridAxis(
  length: number,
  spacing: number,
  offset: number,
  margin: number,
): { start: number; count: number } {
  const base = offset + spacing / 2;
  const kMin = Math.ceil((-margin - base) / spacing);
  const kMax = Math.floor((length + margin - base) / spacing);
  return { start: base + kMin * spacing, count: Math.max(0, kMax - kMin + 1) };
}

/**
 * Luminance → dot radius in working px. Returns 0 for a dot that should not be
 * drawn at all, so the caller has one test rather than two.
 *
 * minRadius is compared here, in grid space, not after scaling — otherwise the
 * set of surviving dots would change between preview and export, and the export
 * would quietly stop matching what you approved.
 */
export function radiusFor(luminance: number, s: HalftoneSettings): number {
  let darkness = s.invert ? luminance : 1 - luminance;
  darkness = darkness <= 0 ? 0 : darkness >= 1 ? 1 : darkness;
  const r =
    Math.pow(darkness, s.dotGamma) * s.spacing * s.maxRadiusRatio;
  return r < s.minRadius ? 0 : r;
}

/**
 * Luminance under one grid cell. `center` reads the single pixel beneath the dot
 * centre; `average` means the whole cell, which is slower to set up but is the
 * honest answer — a centre sample on a fine grid aliases hard against any texture
 * whose period is near the spacing.
 */
export function sampleCell(
  field: LumaField,
  cx: number,
  cy: number,
  spacing: number,
  mode: HalftoneSettings["samplingMode"],
): number {
  const { luma, sat, width, height } = field;

  if (mode === "center") {
    const px = Math.min(width - 1, Math.max(0, Math.floor(cx)));
    const py = Math.min(height - 1, Math.max(0, Math.floor(cy)));
    return luma[py * width + px];
  }

  const half = spacing / 2;
  // Clamp, then guarantee at least one pixel of extent: a dot centred outside the
  // frame still needs a defensible sample, and the nearest edge pixel is it.
  let x0 = Math.min(width - 1, Math.max(0, Math.floor(cx - half)));
  let y0 = Math.min(height - 1, Math.max(0, Math.floor(cy - half)));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(cx + half)));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(cy + half)));
  x0 = Math.min(x0, x1 - 1);
  y0 = Math.min(y0, y1 - 1);

  if (sat) return areaAverage(sat, width, x0, y0, x1, y1);

  let sum = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) sum += luma[row + x];
  }
  return sum / ((x1 - x0) * (y1 - y0));
}

/**
 * Draw the halftone. Returns the number of dots actually inked, which the UI
 * reports — it is the one number that tells you whether a setting did anything.
 */
export function renderHalftone(
  field: LumaField,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  s: HalftoneSettings,
  view: Viewport,
): number {
  const { width: W, height: H } = field;
  const { scale, originX, originY } = view;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = PAPER;
  ctx.fillRect(originX, originY, W * scale, H * scale);
  ctx.fillStyle = INK;

  const maxRadius = s.spacing * s.maxRadiusRatio;
  const cols = gridAxis(W, s.spacing, s.offsetX, maxRadius);
  const rows = gridAxis(H, s.spacing, s.offsetY, maxRadius);
  if (cols.count === 0 || rows.count === 0) return 0;

  // Cull to the visible region in grid space. Zooming in therefore gets *cheaper*,
  // not more expensive — we only ever pay for dots that land on the canvas.
  const bleed = maxRadius * scale;
  const kRange = (
    start: number,
    origin: number,
    extent: number,
    count: number,
  ): [number, number] => {
    const lo = Math.ceil(((-bleed - origin) / scale - start) / s.spacing);
    const hi = Math.floor(((extent + bleed - origin) / scale - start) / s.spacing);
    return [Math.max(0, lo), Math.min(count - 1, hi)];
  };
  const [c0, c1] = kRange(cols.start, originX, view.width, cols.count);
  const [r0, r1] = kRange(rows.start, originY, view.height, rows.count);

  let drawn = 0;
  let batch = 0;
  ctx.beginPath();

  for (let row = r0; row <= r1; row++) {
    const cy = rows.start + row * s.spacing;
    const py = originY + cy * scale;
    for (let col = c0; col <= c1; col++) {
      const cx = cols.start + col * s.spacing;
      const r = radiusFor(sampleCell(field, cx, cy, s.spacing, s.samplingMode), s);
      if (r === 0) continue;

      const px = originX + cx * scale;
      const pr = r * scale;
      // moveTo the arc's own start point first: arc() otherwise draws a connecting
      // line from wherever the last one ended, and those chords fill too.
      ctx.moveTo(px + pr, py);
      ctx.arc(px, py, pr, 0, TAU);
      drawn++;
      if (++batch >= BATCH) {
        ctx.fill();
        ctx.beginPath();
        batch = 0;
      }
    }
  }
  if (batch > 0) ctx.fill();

  if (!s.antialias) hardenEdges(ctx, view, W * scale, H * scale);
  return drawn;
}

/**
 * Collapse the anti-aliased rim of every circle to pure black or pure white.
 * Costs a full read-modify-write of the image rect, which is why it is opt-in —
 * but it is the only way to get a raster with exactly two values in it, which is
 * what anything downstream that expects "line art" actually wants.
 */
function hardenEdges(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  view: Viewport,
  imgW: number,
  imgH: number,
): void {
  const x = Math.max(0, Math.floor(view.originX));
  const y = Math.max(0, Math.floor(view.originY));
  const w = Math.min(view.width, Math.ceil(view.originX + imgW)) - x;
  const h = Math.min(view.height, Math.ceil(view.originY + imgH)) - y;
  if (w <= 0 || h <= 0) return;

  const img = ctx.getImageData(x, y, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    // Paper and ink are greys, so the red channel alone decides. Partially
    // transparent pixels only occur outside the paper rect, which we don't touch.
    const v = d[i] < 128 ? 0 : 255;
    d[i] = v;
    d[i + 1] = v;
    d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, x, y);
}
