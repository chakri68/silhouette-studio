import "./styles.css";
import { initCanvas, setImage, seedMask, fitView } from "./engine/canvas";
import { initViewport } from "./engine/viewport";
import { initBrush } from "./engine/brush";
import { initHistory, resetHistory } from "./engine/history";
import { mediapipeSegmenter, prewarm } from "./segmentation";
import { initDropzone } from "./ui/dropzone";
import { initToolbar } from "./ui/toolbar";
import { initPreviewModal } from "./ui/previewModal";
import { initSilhouettePanel } from "./ui/silhouettePanel";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <h1>silhouette_studio</h1>
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
          <div class="dz-title">DROP AN IMAGE</div>
          <div class="dz-sub">or click to browse — png · jpg · webp · gif · bmp</div>
        </div>
      </div>
      <div class="busy hidden" id="busy">
        <div class="busy-box">
          <div class="busy-label">AUTO-SELECTING</div>
          <div class="busy-bar"><span></span></div>
        </div>
      </div>
    </div>
    <div class="toolbar hidden" id="toolbar"></div>
  </main>

  <input type="file" id="file" accept="image/*" hidden />
`;

const canvas = document.querySelector<HTMLCanvasElement>("#display")!;
const dropzone = document.querySelector<HTMLElement>("#dropzone")!;
const fileInput = document.querySelector<HTMLInputElement>("#file")!;
const openButton = document.querySelector<HTMLElement>("#open")!;
const fitButton = document.querySelector<HTMLButtonElement>("#fit")!;
const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
const busy = document.querySelector<HTMLElement>("#busy")!;

initCanvas(canvas);
initViewport(canvas); // registers pointerdown before the brush, so pan wins
initBrush(canvas);
initHistory();
initToolbar(toolbar);
const silhouette = initSilhouettePanel();
const preview = initPreviewModal(() => silhouette.open());
toolbar.querySelector<HTMLButtonElement>("#preview")!.addEventListener("click", () => preview.open());
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
    const res = await mediapipeSegmenter.segment(source);
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
