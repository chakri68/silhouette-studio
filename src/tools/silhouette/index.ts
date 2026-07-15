import type { Route } from "../../main";
import { initCanvas, setImage, seedMask, fitView } from "../../engine/canvas";
import { initViewport } from "../../engine/viewport";
import { initBrush } from "../../engine/brush";
import {
  initCrop,
  applyCrop,
  cancelCrop,
  isCropActive,
  setCropListener,
} from "../../engine/crop";
import { initHistory, resetHistory } from "../../engine/history";
import { segmenter, prewarm, setSegmentationProgress } from "../../segmentation";
import { initDropzone } from "../../ui/dropzone";
import { initToolbar } from "../../ui/toolbar";
import { initPreviewModal } from "../../ui/previewModal";
import { initSilhouettePanel } from "../../ui/silhouettePanel";

/**
 * The silhouette / cutout tool. Owns its own screen: topbar, canvas workspace,
 * bottom toolbar. Mounted once, lazily, when the route is first opened — which
 * is also when the segmentation model starts prewarming, so hub-only and
 * grainery-only visitors never fetch it.
 */
export function mountSilhouette(root: HTMLElement, navigate: (route: Route) => void): void {
  root.innerHTML = `
    <header class="topbar">
      <button class="btn back" id="back" title="Back to studio">←</button>
      <h1>silhouette</h1>
      <div class="spacer"></div>
      <span class="readout" id="zoom">—</span>
      <button class="btn" id="fit" disabled>Fit</button>
      <button class="btn" id="open">Open…</button>
    </header>

    <main class="workspace">
      <div class="screen">
        <canvas id="display"></canvas>
        <div class="dropzone" id="dropzone">
          <div class="dz-inner">
            <div class="dz-title">DROP OR PASTE AN IMAGE</div>
            <div class="dz-sub">click to browse, or paste — png · jpg · webp · gif · bmp</div>
          </div>
        </div>
        <div class="busy hidden" id="busy">
          <div class="busy-box">
            <div class="busy-label">AUTO-SELECTING</div>
            <div class="busy-bar"><span></span></div>
          </div>
        </div>
        <div class="cropbar hidden" id="cropbar">
          <span class="cropbar-label">CROP</span>
          <span class="cropbar-hint">drag a region</span>
          <button class="tool" id="crop-apply">Apply</button>
          <button class="tool" id="crop-cancel">Cancel</button>
        </div>
      </div>
      <div class="toolbar hidden" id="toolbar"></div>
    </main>

    <input type="file" id="file" accept="image/*" hidden />
  `;

  const canvas = root.querySelector<HTMLCanvasElement>("#display")!;
  const dropzone = root.querySelector<HTMLElement>("#dropzone")!;
  const fileInput = root.querySelector<HTMLInputElement>("#file")!;
  const openButton = root.querySelector<HTMLElement>("#open")!;
  const fitButton = root.querySelector<HTMLButtonElement>("#fit")!;
  const toolbar = root.querySelector<HTMLElement>("#toolbar")!;
  const busy = root.querySelector<HTMLElement>("#busy")!;
  const busyLabel = busy.querySelector<HTMLElement>(".busy-label")!;

  root.querySelector<HTMLButtonElement>("#back")!.addEventListener("click", () => navigate("hub"));

  initCanvas(canvas);
  initViewport(canvas); // registers pointerdown before the brush, so pan wins
  initCrop(canvas); // crop runs before the brush too, so it claims the drag first
  initBrush(canvas);
  initHistory();
  initToolbar(toolbar);
  const silhouette = initSilhouettePanel();
  const preview = initPreviewModal(() => silhouette.open());
  toolbar
    .querySelector<HTMLButtonElement>("#preview")!
    .addEventListener("click", () => preview.open());

  // Crop mode: the action bar and the rest of the toolbar swap in/out together.
  const cropbar = root.querySelector<HTMLElement>("#cropbar")!;
  cropbar.querySelector<HTMLButtonElement>("#crop-apply")!.addEventListener("click", () => applyCrop());
  cropbar.querySelector<HTMLButtonElement>("#crop-cancel")!.addEventListener("click", () => cancelCrop());
  setCropListener(() => {
    const on = isCropActive();
    cropbar.classList.toggle("hidden", !on);
    toolbar.classList.toggle("disabled", on); // no brushing/tools while framing a crop
  });
  window.addEventListener("keydown", (e) => {
    if (!isCropActive()) return;
    if (e.key === "Enter") {
      e.preventDefault();
      applyCrop();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelCrop();
    }
  });
  setSegmentationProgress((p) => {
    busyLabel.textContent =
      p.stage === "loading" && p.pct !== null ? `LOADING MODEL ${p.pct}%` : "AUTO-SELECTING";
  });
  prewarm(); // start fetching the segmentation model in the background

  initDropzone({ dropzone, fileInput, openButton }, (bmp) => {
    setImage(bmp);
    resetHistory();
    dropzone.classList.add("hidden");
    toolbar.classList.remove("hidden");
    fitButton.disabled = false;
    void seed(bmp);
  });

  fitButton.addEventListener("click", () => fitView());

  /** Auto-segment and pre-fill the mask. The busy overlay blocks brushing until done. */
  async function seed(source: ImageBitmap): Promise<void> {
    busy.classList.remove("hidden");
    try {
      const res = await segmenter.segment(source);
      seedMask(res.alpha, res.width, res.height);
      resetHistory(); // the seed is the history floor
    } catch (err) {
      // Model unavailable or subject unrecognized — leave the mask empty; the
      // brush is the workhorse. Not fatal.
      console.error("auto-segmentation failed:", err);
    } finally {
      busy.classList.add("hidden");
    }
  }
}
