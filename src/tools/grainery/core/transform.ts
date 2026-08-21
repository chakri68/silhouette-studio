/**
 * Geometric edits to the source bitmap: exact pixel remaps, no resampling. Flips
 * mirror, rotations are 90° quarter-turns, crop copies a sub-rectangle. Each
 * returns a fresh ImageBitmap that gets handed straight back to the GL pipeline
 * as the new source — so downstream (upscale, deblock, grain) just re-runs on it.
 */

export type TransformKind = "flipH" | "flipV" | "rotateCW" | "rotateCCW";

// Match the ingest contract: the GL pipeline assumes a premultiplied source
// texture, and the UA default is otherwise its own choice. See ui/dropzone.ts.
const BITMAP_OPTS: ImageBitmapOptions = { premultiplyAlpha: "premultiply" };

export async function transformBitmap(src: ImageBitmap, kind: TransformKind): Promise<ImageBitmap> {
  const swaps = kind === "rotateCW" || kind === "rotateCCW";
  const cnv = document.createElement("canvas");
  cnv.width = swaps ? src.height : src.width;
  cnv.height = swaps ? src.width : src.height;
  const ctx = cnv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // exact copy at 90° / mirror
  switch (kind) {
    case "flipH":
      ctx.translate(src.width, 0);
      ctx.scale(-1, 1);
      break;
    case "flipV":
      ctx.translate(0, src.height);
      ctx.scale(1, -1);
      break;
    case "rotateCW":
      ctx.translate(cnv.width, 0);
      ctx.rotate(Math.PI / 2);
      break;
    case "rotateCCW":
      ctx.translate(0, cnv.height);
      ctx.rotate(-Math.PI / 2);
      break;
  }
  ctx.drawImage(src, 0, 0);
  return createImageBitmap(cnv, BITMAP_OPTS);
}

export async function cropBitmap(
  src: ImageBitmap,
  x: number,
  y: number,
  w: number,
  h: number,
): Promise<ImageBitmap> {
  const cnv = document.createElement("canvas");
  cnv.width = w;
  cnv.height = h;
  const ctx = cnv.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, x, y, w, h, 0, 0, w, h);
  return createImageBitmap(cnv, BITMAP_OPTS);
}
