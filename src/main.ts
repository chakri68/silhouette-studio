import "./styles.css";
import { initCanvas, setImage, fitView } from "./engine/canvas";
import { initViewport } from "./engine/viewport";
import { initBrush } from "./engine/brush";
import { initHistory, resetHistory } from "./engine/history";
import { initDropzone } from "./ui/dropzone";
import { initToolbar } from "./ui/toolbar";

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

initCanvas(canvas);
initViewport(canvas); // registers pointerdown before the brush, so pan wins
initBrush(canvas);
initHistory();
initToolbar(toolbar);

initDropzone({ dropzone, fileInput, openButton }, (bmp) => {
  setImage(bmp);
  resetHistory(); // seed becomes the history floor
  dropzone.classList.add("hidden");
  toolbar.classList.remove("hidden");
  fitButton.disabled = false;
});

fitButton.addEventListener("click", () => fitView());
