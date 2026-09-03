import type { HalftoneSettings } from "./settings";

/**
 * Tonal preprocessing, run on the luminance buffer before the grid ever samples
 * it. Order is fixed and matters: brightness → contrast → gamma → blur →
 * threshold. Blurring before the threshold is what lets softness act on shapes
 * rather than on sensor noise; thresholding first would just posterise the grain.
 */

/**
 * Remap luminance around a threshold. Not a binary cut — values inside the
 * softness band ramp linearly, so the same control covers "punchier photo" at one
 * end and "posterised comic silhouette" at the other.
 */
export function applySoftThreshold(
  value: number,
  threshold: number,
  softness: number,
): number {
  const low = threshold - softness;
  const high = threshold + softness;
  if (high <= low) return value <= threshold ? 0 : 1; // softness 0 → hard cut
  if (value <= low) return 0;
  if (value >= high) return 1;
  return (value - low) / (high - low);
}

/**
 * Box widths whose repeated application approximates a gaussian of the given
 * sigma (three passes gets within ~3% of a true gaussian, for a fraction of the
 * cost — each box pass is O(1) per pixel via a running sum).
 */
export function boxesForGauss(sigma: number, n: number): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  if (wl < 1) wl = 1;
  const wu = wl + 2;
  const mIdeal =
    (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

/** Horizontal box blur, edges clamped, running-sum so cost is independent of r. */
function boxH(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
): void {
  const norm = 1 / (r + r + 1);
  const last = width - 1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = src[row] * (r + 1);
    for (let i = 0; i < r; i++) sum += src[row + Math.min(i, last)];
    for (let x = 0; x < width; x++) {
      sum += src[row + Math.min(x + r, last)] - src[row + Math.max(x - r - 1, 0)];
      dst[row + x] = sum * norm;
    }
  }
}

/** Vertical box blur — same running sum, striding by a row. */
function boxV(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  r: number,
): void {
  const norm = 1 / (r + r + 1);
  const last = height - 1;
  for (let x = 0; x < width; x++) {
    let sum = src[x] * (r + 1);
    for (let i = 0; i < r; i++) sum += src[Math.min(i, last) * width + x];
    for (let y = 0; y < height; y++) {
      sum +=
        src[Math.min(y + r, last) * width + x] -
        src[Math.max(y - r - 1, 0) * width + x];
      dst[y * width + x] = sum * norm;
    }
  }
}

/**
 * Gaussian blur in place, via three ping-ponged box passes per axis. `buf` holds
 * the result on return; `scratch` is clobbered.
 */
export function gaussianBlur(
  buf: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  sigma: number,
): void {
  for (const size of boxesForGauss(sigma, 3)) {
    const r = (size - 1) / 2;
    if (r < 1) continue; // a zero-radius box is the identity; skip the two passes
    boxH(buf, scratch, width, height, r);
    boxV(scratch, buf, width, height, r);
  }
}

/**
 * Full tonal pass. Returns a fresh buffer — the caller keeps the untouched source
 * luminance so that dragging a slider re-derives from the original rather than
 * compounding onto the last result.
 */
export function preprocess(
  src: Float32Array,
  width: number,
  height: number,
  s: HalftoneSettings,
): Float32Array {
  const out = new Float32Array(src);

  // Spec's contrast factor, on the -255..255 convention. It is deliberately
  // non-linear at the top: contrast 1 lands a factor of ~130, which is a near-
  // binary cut — a legitimate endpoint for a comic renderer.
  const c = Math.max(-1, Math.min(1, s.contrast)) * 255;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = s.imageGamma;

  for (let i = 0; i < out.length; i++) {
    let v = out[i] + s.brightness;
    v = factor * (v - 0.5) + 0.5;
    v = v <= 0 ? 0 : v >= 1 ? 1 : v;
    if (gamma !== 1) v = Math.pow(v, gamma);
    out[i] = v;
  }

  if (s.blurRadius > 0.05) {
    gaussianBlur(out, new Float32Array(out.length), width, height, s.blurRadius);
  }

  if (s.thresholdEnabled) {
    for (let i = 0; i < out.length; i++) {
      out[i] = applySoftThreshold(out[i], s.threshold, s.thresholdSoftness);
    }
  }

  return out;
}
