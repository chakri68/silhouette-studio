import { init, potrace } from "esm-potrace-wasm";
import { state } from "./state";
import { getMaskCanvas } from "./engine/canvas";

/**
 * Silhouette tracing (4.7). potrace traces dark-on-light, so the input must be
 * a BLACK shape on a WHITE ground — otherwise the silhouette comes out inverted
 * (§11). We trace the MASK, not the color image, to get the clean shape.
 *
 * potrace emits `<svg viewBox="0 0 W H"><g transform="translate scale(±0.1)">
 * <path d=.../></g></svg>`: the path coords live in a ~10× Y-flipped space and
 * the group transform maps them back into the W×H viewBox. We keep that group
 * transform verbatim and only restyle the path. `strokeScale` (= 1/|scale|)
 * lets a caller express border width in final px — a raw stroke-width would
 * otherwise be shrunk by the group's scale.
 */

export interface TracedShape {
  viewBox: string;
  transform: string;
  d: string;
  strokeScale: number;
}

let ready: Promise<void> | null = null;

function ensureInit(): Promise<void> {
  if (!ready) ready = init();
  return ready;
}

/** White canvas with the selected region painted black — potrace's input. */
export function buildBilevel(): HTMLCanvasElement {
  const { W, H } = state;
  const bl = document.createElement("canvas");
  bl.width = W;
  bl.height = H;
  const b = bl.getContext("2d")!;

  // Black where selected: stencil the mask, tint black, then fill white behind.
  b.drawImage(getMaskCanvas(), 0, 0); // white/opaque where selected
  b.globalCompositeOperation = "source-in";
  b.fillStyle = "#000";
  b.fillRect(0, 0, W, H); // → black where selected, transparent elsewhere
  b.globalCompositeOperation = "destination-over";
  b.fillStyle = "#fff";
  b.fillRect(0, 0, W, H); // → white ground behind
  b.globalCompositeOperation = "source-over";
  return bl;
}

/** Trace the mask into geometry (path + group transform) for flat-color styling. */
export async function traceMask(): Promise<TracedShape> {
  await ensureInit();
  const out = await potrace(buildBilevel(), {
    turdsize: 2, // drop speckles smaller than 2px
    turnpolicy: 4,
    alphamax: 1,
    opticurve: 1,
    opttolerance: 0.2,
    pathonly: false,
    extractcolors: false, // single-color trace, not per-color layers
  });
  const svg = Array.isArray(out) ? out.join("") : out;

  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const svgEl = doc.querySelector("svg");
  const transform = doc.querySelector("g")?.getAttribute("transform") ?? "";
  // Subpaths carry their own winding, so joining their `d`s preserves holes.
  const d = Array.from(doc.querySelectorAll("path"))
    .map((p) => p.getAttribute("d") ?? "")
    .filter(Boolean)
    .join(" ");

  const scale = /scale\(\s*(-?[\d.]+)/.exec(transform);
  const strokeScale = scale ? 1 / Math.abs(parseFloat(scale[1])) : 1;

  return {
    viewBox: svgEl?.getAttribute("viewBox") ?? `0 0 ${state.W} ${state.H}`,
    transform,
    d,
    strokeScale,
  };
}
