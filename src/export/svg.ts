import { state } from "../state";
import { buildCutout } from "../engine/canvas";
import { downloadText } from "./download";

/**
 * Export the cutout as raster-in-SVG (§5): the cutout PNG embedded as a data-URI
 * <image> inside an SVG wrapper. Preserves the full-color picture — this is NOT
 * vectorized color (only the Silhouette export is truly traced).
 */
export function exportSVG(): void {
  const dataUrl = buildCutout().toDataURL("image/png");
  const { W, H } = state;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<image href="${dataUrl}" width="${W}" height="${H}"/>` +
    `</svg>`;
  downloadText(svg, "cutout.svg", "image/svg+xml");
}
