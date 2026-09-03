/**
 * Luminance extraction, plus the summed-area table that makes per-cell averaging
 * O(1) instead of O(spacing²).
 *
 * Everything downstream works on a single Float32Array of normalised luminance —
 * the RGBA bytes are touched exactly once, on ingest. Sampling inside the dot loop
 * never goes near ImageData.
 */

/** Rec. 709 luminance from 8-bit sRGB channels, normalised to 0..1. */
export function rgbToLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * RGBA bytes → normalised luminance, compositing over white.
 *
 * The compositing matters more than it looks: a cutout PNG (which this studio is
 * very good at producing) carries rgb 0,0,0 under its transparent pixels, and
 * straight luminance would read that as solid black — a field of fat dots where
 * there is nothing at all. Paper shows through instead.
 *
 * Expects straight (un-premultiplied) alpha, which is what getImageData returns
 * regardless of how the bitmap was decoded.
 */
export function buildLuminanceBuffer(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) {
    const p = i * 4;
    const a = data[p + 3] / 255;
    out[i] = rgbToLuminance(data[p], data[p + 1], data[p + 2]) * a + (1 - a);
  }
  return out;
}

/**
 * Summed-area table over the luminance buffer, padded by one row/column of zeros
 * so the four-corner lookup needs no bounds tests.
 *
 * Float64 is not paranoia: a 1400×1050 field of values ≤1 sums to ~1.5e6, which
 * float32 can only resolve to ~0.1 near the bottom-right corner — the difference
 * of two such corners is exactly what a cell average is made of, so the error
 * would land as visible banding in the dot sizes.
 */
export function buildIntegral(
  luma: Float32Array,
  width: number,
  height: number,
): Float64Array {
  const w1 = width + 1;
  const sat = new Float64Array(w1 * (height + 1));
  for (let y = 0; y < height; y++) {
    const src = y * width;
    const prev = y * w1;
    const cur = prev + w1;
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += luma[src + x];
      sat[cur + x + 1] = sat[prev + x + 1] + row;
    }
  }
  return sat;
}

/** Mean luminance of the half-open rect [x0,x1) × [y0,y1), in O(1). */
export function areaAverage(
  sat: Float64Array,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const w1 = width + 1;
  const top = y0 * w1;
  const bot = y1 * w1;
  const sum = sat[bot + x1] - sat[bot + x0] - sat[top + x1] + sat[top + x0];
  return sum / ((x1 - x0) * (y1 - y0));
}
