import { buildCutout } from "../engine/canvas";
import { downloadBlob } from "./download";

/** Export the cutout as a transparent PNG (§5). */
export function exportPNG(): void {
  buildCutout().toBlob((blob) => {
    if (blob) downloadBlob(blob, "cutout.png");
  }, "image/png");
}
