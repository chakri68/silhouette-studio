import { buildCutout, isMaskEmpty } from "../engine/canvas";
import { exportPNG } from "../export/png";
import { exportSVG } from "../export/svg";

/**
 * Preview modal: shows the final cutout on a transparency checkerboard with the
 * export buttons (§5, §6). PNG/SVG live here; Silhouette joins in phase 6.
 */

export interface PreviewModal {
  open: () => void;
}

export function initPreviewModal(onSilhouette: () => void): PreviewModal {
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Preview">
      <h3>Preview</h3>
      <div class="preview-stage">
        <img id="preview-img" alt="cutout preview" />
        <div class="preview-empty hidden">NOTHING SELECTED</div>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="export-png">PNG</button>
        <button class="btn" id="export-svg">SVG</button>
        <button class="btn" id="export-silhouette">Silhouette</button>
        <span class="modal-spacer"></span>
        <button class="btn" id="modal-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const img = root.querySelector<HTMLImageElement>("#preview-img")!;
  const empty = root.querySelector<HTMLElement>(".preview-empty")!;
  const pngBtn = root.querySelector<HTMLButtonElement>("#export-png")!;
  const svgBtn = root.querySelector<HTMLButtonElement>("#export-svg")!;
  const silBtn = root.querySelector<HTMLButtonElement>("#export-silhouette")!;
  const closeBtn = root.querySelector<HTMLButtonElement>("#modal-close")!;

  const isOpen = (): boolean => !root.classList.contains("hidden");
  const close = (): void => root.classList.add("hidden");

  const open = (): void => {
    const emptyMask = isMaskEmpty();
    empty.classList.toggle("hidden", !emptyMask);
    img.classList.toggle("hidden", emptyMask);
    pngBtn.disabled = emptyMask;
    svgBtn.disabled = emptyMask;
    silBtn.disabled = emptyMask;
    if (!emptyMask) img.src = buildCutout().toDataURL("image/png");
    root.classList.remove("hidden");
  };

  pngBtn.addEventListener("click", () => exportPNG());
  svgBtn.addEventListener("click", () => exportSVG());
  silBtn.addEventListener("click", () => {
    close(); // hand off to the silhouette panel
    onSilhouette();
  });
  closeBtn.addEventListener("click", close);
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close(); // click on backdrop, not the panel
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  return { open };
}
