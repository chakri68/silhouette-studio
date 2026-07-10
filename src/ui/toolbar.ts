import { state } from "../state";
import type { Tool } from "../state";
import { markDirty, applyTransform } from "../engine/canvas";
import { enterCrop, cancelCrop } from "../engine/crop";
import { undo, redo, canUndo, canRedo, setHistoryListener } from "../engine/history";

/**
 * Bottom control bar. Phase 2: tool toggle + brush-size slider, with keyboard
 * shortcuts (B add, E erase, [ / ] resize). Undo/redo and Preview land here in
 * later phases.
 */

const BRUSH_MIN = 1;
const BRUSH_MAX = 200;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function initToolbar(container: HTMLElement): void {
  container.innerHTML = `
    <div class="tool-group">
      <button class="tool" id="tool-add" title="Add — B">Add</button>
      <button class="tool" id="tool-erase" title="Erase — E">Erase</button>
    </div>
    <div class="brush">
      <label for="brush">Brush</label>
      <input type="range" id="brush" min="${BRUSH_MIN}" max="${BRUSH_MAX}" step="1" />
      <span class="readout" id="brush-val"></span>
    </div>
    <div class="sep"></div>
    <div class="tool-group">
      <button class="tool" id="undo" title="Undo — Ctrl/Cmd+Z">Undo</button>
      <button class="tool" id="redo" title="Redo — Ctrl/Cmd+Shift+Z">Redo</button>
    </div>
    <div class="sep"></div>
    <div class="tool-group">
      <button class="tool tool-icon" id="flip-h" title="Flip horizontal — H">↔</button>
      <button class="tool tool-icon" id="flip-v" title="Flip vertical — V">↕</button>
      <button class="tool tool-icon" id="rot-ccw" title="Rotate left — Shift+R">↺</button>
      <button class="tool tool-icon" id="rot-cw" title="Rotate right — R">↻</button>
      <button class="tool" id="crop" title="Crop — C">Crop</button>
    </div>
    <div class="sep"></div>
    <button class="tool" id="preview">Preview</button>
  `;

  const addBtn = container.querySelector<HTMLButtonElement>("#tool-add")!;
  const eraseBtn = container.querySelector<HTMLButtonElement>("#tool-erase")!;
  const slider = container.querySelector<HTMLInputElement>("#brush")!;
  const brushVal = container.querySelector<HTMLElement>("#brush-val")!;
  const undoBtn = container.querySelector<HTMLButtonElement>("#undo")!;
  const redoBtn = container.querySelector<HTMLButtonElement>("#redo")!;

  const syncTool = (): void => {
    addBtn.classList.toggle("active", state.tool === "add");
    eraseBtn.classList.toggle("active", state.tool === "erase");
  };
  const syncBrush = (): void => {
    slider.value = String(state.brushSize);
    brushVal.textContent = `${state.brushSize}px`;
  };

  const setTool = (t: Tool): void => {
    state.tool = t;
    syncTool();
    markDirty(); // recolor the cursor ring
  };
  const setBrush = (n: number): void => {
    state.brushSize = clamp(Math.round(n), BRUSH_MIN, BRUSH_MAX);
    syncBrush();
    markDirty(); // resize the cursor ring
  };

  const syncHistory = (): void => {
    undoBtn.disabled = !canUndo();
    redoBtn.disabled = !canRedo();
  };

  // Flip/rotate cancel any open crop first (its rect coords wouldn't survive the
  // geometry change), then remap the whole document — mask and history included.
  const transform = (t: Parameters<typeof applyTransform>[0]): void => {
    cancelCrop();
    applyTransform(t);
  };

  container.querySelector<HTMLButtonElement>("#flip-h")!.addEventListener("click", () =>
    transform({ type: "flipH" }),
  );
  container.querySelector<HTMLButtonElement>("#flip-v")!.addEventListener("click", () =>
    transform({ type: "flipV" }),
  );
  container.querySelector<HTMLButtonElement>("#rot-ccw")!.addEventListener("click", () =>
    transform({ type: "rotateCCW" }),
  );
  container.querySelector<HTMLButtonElement>("#rot-cw")!.addEventListener("click", () =>
    transform({ type: "rotateCW" }),
  );
  container.querySelector<HTMLButtonElement>("#crop")!.addEventListener("click", () => enterCrop());

  addBtn.addEventListener("click", () => setTool("add"));
  eraseBtn.addEventListener("click", () => setTool("erase"));
  slider.addEventListener("input", () => setBrush(Number(slider.value)));
  undoBtn.addEventListener("click", () => undo());
  redoBtn.addEventListener("click", () => redo());
  setHistoryListener(syncHistory);

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    // Leave shortcuts (incl. the existing letters) out of the way of browser
    // chords — Ctrl/Cmd+C must copy, not enter crop; Ctrl+B stays free, etc.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    switch (e.key) {
      case "b":
      case "B":
        setTool("add");
        break;
      case "e":
      case "E":
        setTool("erase");
        break;
      case "[":
        setBrush(state.brushSize - 2);
        break;
      case "]":
        setBrush(state.brushSize + 2);
        break;
      case "h":
      case "H":
        transform({ type: "flipH" });
        break;
      case "v":
      case "V":
        transform({ type: "flipV" });
        break;
      case "r":
        transform({ type: "rotateCW" });
        break;
      case "R":
        transform({ type: "rotateCCW" }); // Shift+R
        break;
      case "c":
      case "C":
        enterCrop();
        break;
    }
  });

  syncTool();
  syncBrush();
  syncHistory();
}
