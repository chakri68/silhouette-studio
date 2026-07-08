import { state } from "../state";
import { isMaskEmpty, getMaskVersion } from "../engine/canvas";
import { traceMask } from "../trace";
import type { TracedShape } from "../trace";
import { downloadText } from "../export/download";

/**
 * Silhouette panel (§5, §6): trace the mask once, then live-preview flat-color
 * styling (fill / border color / border thickness) as the user tweaks. Only
 * re-trace when the mask changed since the last trace — color/thickness tweaks
 * just re-render the SVG string.
 */

export interface SilhouettePanel {
  open: () => void;
}

export function initSilhouettePanel(): SilhouettePanel {
  const root = document.createElement("div");
  root.className = "modal-backdrop hidden";
  root.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Silhouette">
      <h3>Silhouette</h3>
      <div class="preview-stage sil-stage">
        <div class="sil-preview" id="sil-preview"></div>
        <div class="sil-status hidden" id="sil-status">TRACING…</div>
        <div class="preview-empty hidden" id="sil-empty">NOTHING SELECTED</div>
      </div>
      <div class="sil-controls">
        <label>Fill<input type="color" id="sil-fill" value="#000000" /></label>
        <label>Border<input type="color" id="sil-border" value="#ffb000" /></label>
        <label class="sil-thickness">Border width
          <input type="range" id="sil-thickness" min="0" max="40" step="1" value="0" />
          <span class="readout" id="sil-thickness-val">0</span>
        </label>
      </div>
      <div class="modal-actions">
        <button class="btn primary" id="sil-download">Download SVG</button>
        <span class="modal-spacer"></span>
        <button class="btn" id="sil-close">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const preview = root.querySelector<HTMLElement>("#sil-preview")!;
  const status = root.querySelector<HTMLElement>("#sil-status")!;
  const empty = root.querySelector<HTMLElement>("#sil-empty")!;
  const fill = root.querySelector<HTMLInputElement>("#sil-fill")!;
  const border = root.querySelector<HTMLInputElement>("#sil-border")!;
  const thickness = root.querySelector<HTMLInputElement>("#sil-thickness")!;
  const thicknessVal = root.querySelector<HTMLElement>("#sil-thickness-val")!;
  const downloadBtn = root.querySelector<HTMLButtonElement>("#sil-download")!;
  const closeBtn = root.querySelector<HTMLButtonElement>("#sil-close")!;

  let shape: TracedShape | null = null;
  let tracedVersion = -1;

  const buildSvg = (): string => {
    const { W, H } = state;
    if (!shape) return "";
    const t = Number(thickness.value);
    const stroke =
      t > 0
        ? ` stroke="${border.value}" stroke-width="${t * shape.strokeScale}" stroke-linejoin="round"`
        : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${shape.viewBox}" width="${W}" height="${H}">` +
      `<g transform="${shape.transform}">` +
      `<path d="${shape.d}" fill="${fill.value}"${stroke}/>` +
      `</g></svg>`
    );
  };

  const rerender = (): void => {
    thicknessVal.textContent = thickness.value;
    if (shape) preview.innerHTML = buildSvg();
  };

  const isOpen = (): boolean => !root.classList.contains("hidden");
  const close = (): void => root.classList.add("hidden");

  const open = async (): Promise<void> => {
    root.classList.remove("hidden");
    const emptyMask = isMaskEmpty();
    empty.classList.toggle("hidden", !emptyMask);
    preview.classList.toggle("hidden", emptyMask);
    downloadBtn.disabled = emptyMask;
    if (emptyMask) return;

    // Re-trace only if the mask changed since we last traced.
    const version = getMaskVersion();
    if (shape === null || version !== tracedVersion) {
      status.classList.remove("hidden");
      preview.innerHTML = "";
      try {
        shape = await traceMask();
        tracedVersion = version;
      } catch (err) {
        console.error("trace failed:", err);
        status.textContent = "TRACE FAILED";
        return;
      } finally {
        if (status.textContent === "TRACING…") status.classList.add("hidden");
      }
    }
    rerender();
  };

  fill.addEventListener("input", rerender);
  border.addEventListener("input", rerender);
  thickness.addEventListener("input", rerender);
  downloadBtn.addEventListener("click", () => {
    if (shape) downloadText(buildSvg(), "silhouette.svg", "image/svg+xml");
  });
  closeBtn.addEventListener("click", close);
  root.addEventListener("mousedown", (e) => {
    if (e.target === root) close();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen()) close();
  });

  return { open: () => void open() };
}
