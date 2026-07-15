import type { Route } from "../../main";
import { initDropzone } from "../../ui/dropzone";
import { Grapher } from "./gl/graph";
import {
  transformBitmap,
  cropBitmap,
  type TransformKind,
} from "./core/transform";
import { DEFAULTS, PRESETS, type Params, type PresetName } from "./core/params";

/**
 * The Grainery tool: de-pixelate a low-res image and buy the detail back with
 * film-grade grain. Left panel is the screen + split compare; right panel is
 * presets and the live controls. The pipeline runs on the GPU, so every slider
 * is immediate — param changes re-run upscale→grain→finish, dragging the compare
 * divider only re-presents.
 */

const PRESET_NAMES: PresetName[] = [
  "Rescue",
  "35mm",
  "Push",
  "Newsprint",
  "Soft",
  "Pixel art",
];

export function mountGrainery(
  root: HTMLElement,
  navigate: (route: Route) => void,
): void {
  root.innerHTML = `
    <header class="topbar">
      <button class="btn back" id="g-back" title="Back to studio">←</button>
      <h1>grainery</h1>
      <div class="spacer"></div>
      <span class="readout" id="g-res">—</span>
      <button class="btn" id="g-open">Open…</button>
      <button class="btn" id="g-copy" disabled>Copy</button>
      <button class="btn primary" id="g-save" disabled>Save</button>
    </header>
    <div class="g-body">
      <div class="screen g-screen">
        <canvas id="g-canvas"></canvas>
        <div class="g-edit hidden" id="g-edit">
          <div class="tool-group">
            <button class="tool tool-icon" id="g-flip-h" title="Flip horizontal">↔</button>
            <button class="tool tool-icon" id="g-flip-v" title="Flip vertical">↕</button>
            <button class="tool tool-icon" id="g-rot-ccw" title="Rotate left">↺</button>
            <button class="tool tool-icon" id="g-rot-cw" title="Rotate right">↻</button>
          </div>
          <button class="tool" id="g-crop">Crop</button>
          <button class="tool active" id="g-compare" title="Toggle the before/after split">Compare</button>
        </div>
        <div class="cropbar hidden" id="g-cropbar">
          <span class="cropbar-label">CROP</span>
          <span class="cropbar-hint">drag the handles or a new region · enter to apply</span>
          <button class="tool" id="g-crop-apply">Apply</button>
          <button class="tool" id="g-crop-cancel">Cancel</button>
        </div>
        <div class="g-crop-layer hidden" id="g-crop-layer">
          <div class="g-crop-rect" id="g-crop-rect"></div>
        </div>
        <div class="dropzone" id="g-dropzone">
          <div class="dz-inner">
            <div class="dz-title">DROP OR PASTE AN IMAGE</div>
            <div class="dz-sub">a pixelated one — click to browse, or paste from the clipboard</div>
          </div>
        </div>
        <div class="g-hint hidden" id="g-hint">drag to compare · scroll to zoom · SPACE for original</div>
      </div>
      <aside class="panel g-panel"></aside>
    </div>
    <input type="file" id="g-file" accept="image/*" hidden />
  `;

  const canvas = root.querySelector<HTMLCanvasElement>("#g-canvas")!;
  const screen = root.querySelector<HTMLElement>(".g-screen")!;
  const dropzone = root.querySelector<HTMLElement>("#g-dropzone")!;
  const fileInput = root.querySelector<HTMLInputElement>("#g-file")!;
  const panel = root.querySelector<HTMLElement>(".g-panel")!;
  const hint = root.querySelector<HTMLElement>("#g-hint")!;
  const resReadout = root.querySelector<HTMLElement>("#g-res")!;
  const openBtn = root.querySelector<HTMLButtonElement>("#g-open")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#g-copy")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#g-save")!;
  const editBar = root.querySelector<HTMLElement>("#g-edit")!;
  const cropbar = root.querySelector<HTMLElement>("#g-cropbar")!;
  const cropLayer = root.querySelector<HTMLElement>("#g-crop-layer")!;
  const cropRectEl = root.querySelector<HTMLElement>("#g-crop-rect")!;

  root
    .querySelector<HTMLButtonElement>("#g-back")!
    .addEventListener("click", () => navigate("hub"));

  let grapher: Grapher;
  try {
    grapher = new Grapher(canvas);
  } catch (err) {
    screen.innerHTML = `<div class="g-error">${(err as Error).message}<br><small>Grainery needs WebGL2.</small></div>`;
    return;
  }

  const params: Params = { ...DEFAULTS };
  const exportOpts = { format: "png" as "png" | "jpeg", quality: 92 };
  let sourceName = "image";
  let currentBitmap: ImageBitmap | null = null; // kept so flip/rotate/crop can re-derive
  let split = 0.5;
  let flashOriginal = false;
  let compareOn = true; // show the draggable before/after divider
  let cropActive = false;
  let dpr = 1;
  // View state for inspecting detail: zoom (1 = fit) with a canvas-space pan.
  // Lives entirely in the present pass, so it never re-runs the pipeline.
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  const MAX_ZOOM = 16;
  // Keep the pan inside the image: the range opens up as you zoom past the point
  // where the fitted image fills the canvas, and locks to 0 at fit.
  const clampPan = (): void => {
    const fit = grapher.fitFactors(canvas.width, canvas.height);
    const limX = Math.max(0, (fit.x * zoom - 1) / 2);
    const limY = Math.max(0, (fit.y * zoom - 1) / 2);
    panX = Math.max(-limX, Math.min(limX, panX));
    panY = Math.max(-limY, Math.min(limY, panY));
  };
  const resetView = (): void => {
    zoom = 1;
    panX = 0;
    panY = 0;
  };

  buildPanel(panel, params, () => {
    scheduleRender();
    syncPresetHighlight(panel, params);
  });

  // Export settings live outside the Params loop so presets never touch them.
  const exportGroup = document.createElement("div");
  exportGroup.className = "g-group";
  exportGroup.innerHTML = `
    <h2>export</h2>
    <div class="g-row">
      <label for="g-format">format</label>
      <select id="g-format">
        <option value="png" selected>PNG</option>
        <option value="jpeg">JPEG</option>
      </select>
    </div>
    <div class="g-row hidden" id="g-quality-row">
      <label for="g-quality">quality<span class="g-val">92</span></label>
      <input id="g-quality" type="range" min="60" max="100" step="1" value="92" />
    </div>
    <small class="g-note hidden" id="g-jpeg-note">JPEG compression eats fine grain — it's the first thing the quantizer throws away. Prefer PNG, or keep quality ≥ 90.</small>
  `;
  panel.appendChild(exportGroup);

  const formatSel = exportGroup.querySelector<HTMLSelectElement>("#g-format")!;
  const qualityRow = exportGroup.querySelector<HTMLElement>("#g-quality-row")!;
  const qualityInput =
    exportGroup.querySelector<HTMLInputElement>("#g-quality")!;
  const qualityVal = exportGroup.querySelector<HTMLElement>(".g-val")!;
  const jpegNote = exportGroup.querySelector<HTMLElement>("#g-jpeg-note")!;
  formatSel.addEventListener("change", () => {
    exportOpts.format = formatSel.value as "png" | "jpeg";
    const jpeg = exportOpts.format === "jpeg";
    qualityRow.classList.toggle("hidden", !jpeg);
    jpegNote.classList.toggle("hidden", !jpeg);
  });
  qualityInput.addEventListener("input", () => {
    exportOpts.quality = Number(qualityInput.value);
    qualityVal.textContent = qualityInput.value;
  });

  // ── Render scheduling ────────────────────────────────────────────────
  let pipelineDirty = false;
  let presentDirty = false;
  let raf = 0;
  const frame = (): void => {
    raf = 0;
    if (pipelineDirty) {
      grapher.render(params);
      pipelineDirty = false;
      presentDirty = true;
    }
    if (presentDirty) {
      // SPACE (flashOriginal) always wins so you can peek the original anytime,
      // even mid-crop. Otherwise the divider shows only when compare is on, off
      // during crop, and hidden when dragged fully to an edge.
      const showSplit = flashOriginal
        ? true
        : compareOn && !cropActive && split > 0.001 && split < 0.999;
      grapher.present(
        canvas.width,
        canvas.height,
        flashOriginal ? 1 : split,
        showSplit,
        zoom,
        panX,
        panY,
      );
      presentDirty = false;
    }
  };
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const scheduleRender = (): void => {
    if (!grapher.hasSource()) return;
    pipelineDirty = true;
    kick();
  };
  const schedulePresent = (): void => {
    if (!grapher.hasSource()) return;
    presentDirty = true;
    kick();
  };

  // ── Canvas sizing ────────────────────────────────────────────────────
  const resize = (): void => {
    dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    clampPan(); // fit changed with the canvas — keep the pan in range
    schedulePresent();
    if (cropActive) drawCrop(); // the image's on-screen box moved — retrack the rect
  };
  window.addEventListener("resize", resize);
  resize();

  // ── Ingest ───────────────────────────────────────────────────────────
  const refreshRes = (): void => {
    if (!grapher.hasSource()) return;
    const { w: sw, h: sh } = grapher.sourceSize();
    const { w, h } = grapher.processSize(params.scale);
    resReadout.textContent = `${sw}×${sh} → ${w}×${h}`;
  };

  // Adopt a new source bitmap (fresh upload, or the result of a flip/rotate/crop).
  // Owns the current bitmap so geometric edits can re-derive from it; the previous
  // one is released once we've handed the new one to the GPU.
  const adoptSource = (bmp: ImageBitmap): void => {
    if (currentBitmap && currentBitmap !== bmp) currentBitmap.close();
    currentBitmap = bmp;
    grapher.setSource(bmp);
    split = 0.5;
    resetView(); // a new/edited image starts fitted
    refreshRes();
    scheduleRender();
  };

  // A brand-new image (upload / Open), as opposed to an in-place edit: reveal the
  // working chrome and remember the name for export.
  const loadImage = (bmp: ImageBitmap, name: string): void => {
    sourceName = name.replace(/\.[^.]+$/, "") || "image";
    dropzone.classList.add("hidden");
    hint.classList.remove("hidden");
    editBar.classList.remove("hidden");
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    if (cropActive) exitCrop();
    adoptSource(bmp);
  };

  initDropzone({ dropzone, fileInput, openButton: openBtn }, loadImage);

  // Keep the resolution readout honest as the scale changes.
  panel.addEventListener("input", refreshRes);

  // ── View + compare ───────────────────────────────────────────────────
  // Single-drag moves the compare divider. Middle-drag (desktop) or two fingers
  // (touch) pan; scroll or pinch zooms toward the cursor; double-click resets to
  // fit. Space still flashes the original — that's why pan is middle/two-finger,
  // not space-drag like the silhouette tool.
  const setSplitFromEvent = (e: PointerEvent): void => {
    const r = canvas.getBoundingClientRect();
    split = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    schedulePresent();
  };

  // Client px → canvas view space (0..1, y-up: v_uv.y=0 is the bottom).
  const toViewUV = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left) / r.width, y: 1 - (clientY - r.top) / r.height };
  };

  // Zoom by `factor` while keeping the image point under (clientX, clientY) fixed.
  const zoomToward = (factor: number, clientX: number, clientY: number): void => {
    const next = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
    if (next === zoom) return;
    const c = toViewUV(clientX, clientY);
    panX = c.x - 0.5 - (next / zoom) * (c.x - 0.5 - panX);
    panY = c.y - 0.5 - (next / zoom) * (c.y - 0.5 - panY);
    zoom = next;
    if (zoom === 1) {
      panX = 0;
      panY = 0;
    }
    clampPan();
    schedulePresent();
  };

  const pointers = new Map<number, { x: number; y: number }>();
  type Gesture =
    | { kind: "compare" }
    | { kind: "pan"; startX: number; startY: number; panX: number; panY: number }
    | { kind: "pinch"; prevDist: number; prevMidX: number; prevMidY: number };
  let gesture: Gesture | null = null;

  const beginPinch = (): void => {
    const [a, b] = [...pointers.values()];
    gesture = {
      kind: "pinch",
      prevDist: Math.hypot(a.x - b.x, a.y - b.y),
      prevMidX: (a.x + b.x) / 2,
      prevMidY: (a.y + b.y) / 2,
    };
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!grapher.hasSource() || cropActive) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* no active pointer to capture */
    }
    if (pointers.size >= 2) {
      beginPinch(); // second finger — switch to pinch/pan, drop the stray compare
      e.preventDefault();
      return;
    }
    if (e.pointerType === "mouse" && e.button === 1) {
      gesture = { kind: "pan", startX: e.clientX, startY: e.clientY, panX, panY };
      e.preventDefault();
    } else if (e.button === 0 && compareOn) {
      gesture = { kind: "compare" };
      setSplitFromEvent(e);
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!gesture) return;
    const r = canvas.getBoundingClientRect();
    if (gesture.kind === "compare") {
      setSplitFromEvent(e);
    } else if (gesture.kind === "pan") {
      panX = gesture.panX + (e.clientX - gesture.startX) / r.width;
      panY = gesture.panY - (e.clientY - gesture.startY) / r.height; // screen y is inverted
      clampPan();
      schedulePresent();
    } else {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (gesture.prevDist > 0) {
        zoomToward(dist / gesture.prevDist, midX, midY);
        panX += (midX - gesture.prevMidX) / r.width; // then follow the midpoint's travel
        panY -= (midY - gesture.prevMidY) / r.height;
        clampPan();
        schedulePresent();
      }
      gesture.prevDist = dist;
      gesture.prevMidX = midX;
      gesture.prevMidY = midY;
    }
  });
  const endPointer = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size === 1 && gesture?.kind === "pinch") {
      const [p] = [...pointers.values()]; // dropped to one finger — keep panning
      gesture = { kind: "pan", startX: p.x, startY: p.y, panX, panY };
    } else if (pointers.size === 0) {
      gesture = null;
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!grapher.hasSource() || cropActive) return;
      e.preventDefault();
      zoomToward(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", () => {
    if (!grapher.hasSource() || cropActive || zoom === 1) return;
    resetView();
    schedulePresent();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === " " && !flashOriginal && !isVisibleHidden(root)) {
      flashOriginal = true;
      schedulePresent();
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === " " && flashOriginal) {
      flashOriginal = false;
      schedulePresent();
    }
  });

  // Compare toggle: show/hide the draggable divider. SPACE-for-original is always
  // available regardless, so the hint keeps that line either way.
  const compareBtn = root.querySelector<HTMLButtonElement>("#g-compare")!;
  const syncHint = (): void => {
    hint.textContent = compareOn
      ? "drag to compare · scroll to zoom · SPACE for original"
      : "scroll to zoom · SPACE for original";
  };
  compareBtn.addEventListener("click", () => {
    compareOn = !compareOn;
    compareBtn.classList.toggle("active", compareOn); // filled/primary when on
    syncHint();
    schedulePresent();
  });

  // ── Geometric edits: flip / rotate / crop ────────────────────────────
  const doTransform = async (kind: TransformKind): Promise<void> => {
    if (!currentBitmap) return;
    if (cropActive) exitCrop();
    adoptSource(await transformBitmap(currentBitmap, kind));
  };
  root
    .querySelector<HTMLButtonElement>("#g-flip-h")!
    .addEventListener("click", () => void doTransform("flipH"));
  root
    .querySelector<HTMLButtonElement>("#g-flip-v")!
    .addEventListener("click", () => void doTransform("flipV"));
  root
    .querySelector<HTMLButtonElement>("#g-rot-ccw")!
    .addEventListener("click", () => void doTransform("rotateCCW"));
  root
    .querySelector<HTMLButtonElement>("#g-rot-cw")!
    .addEventListener("click", () => void doTransform("rotateCW"));

  // The image's on-screen rectangle in CSS px within the canvas box — aspect-fit
  // and centered, mirroring the present pass's letterboxing. Crop coords map
  // through this back to source pixels.
  const imageRect = (): {
    x: number;
    y: number;
    w: number;
    h: number;
    sw: number;
    sh: number;
  } => {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    const { w: sw, h: sh } = grapher.sourceSize();
    const ar = sw / sh;
    let w = cw;
    let h = ch;
    if (cw / ch > ar) {
      h = ch;
      w = ch * ar;
    } else {
      w = cw;
      h = cw / ar;
    }
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, sw, sh };
  };

  // Interactive crop, mirroring the silhouette tool: enter with an inset rect,
  // then grab a handle to extend an edge/corner, drag the middle to move it, or
  // draw a fresh rectangle by starting outside. The selection lives in source
  // pixels so it survives resizes; Apply commits a crop, Cancel/Escape bails.
  type CropRect = { x: number; y: number; w: number; h: number };

  // Eight handles as (hx, hy) in {-1,0,1}; the pair also names which edges move
  // (-1 = min edge, 1 = max edge, 0 = fixed).
  const HANDLES: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const HANDLE_HIT = 14; // css px: generous, finger-friendly grab radius

  let cropRect: CropRect | null = null;
  type CropDrag =
    | { kind: "new"; ax: number; ay: number }
    | { kind: "move"; ox: number; oy: number; orig: CropRect }
    | { kind: "resize"; hx: number; hy: number; orig: CropRect };
  let cropDrag: CropDrag | null = null;

  // Handle + rule-of-thirds children, positioned as percentages of the rect so
  // they track it for free — only the rect box itself is repositioned per frame.
  for (const [hx, hy] of HANDLES) {
    const el = document.createElement("div");
    el.className = "g-crop-handle";
    el.style.left = `${((hx + 1) / 2) * 100}%`;
    el.style.top = `${((hy + 1) / 2) * 100}%`;
    cropRectEl.appendChild(el);
  }
  for (const p of [1, 2]) {
    const v = document.createElement("div");
    v.className = "g-crop-guide v";
    v.style.left = `${(p / 3) * 100}%`;
    cropRectEl.appendChild(v);
    const h = document.createElement("div");
    h.className = "g-crop-guide h";
    h.style.top = `${(p / 3) * 100}%`;
    cropRectEl.appendChild(h);
  }

  const cnorm = (r: CropRect): CropRect => ({
    x: Math.min(r.x, r.x + r.w),
    y: Math.min(r.y, r.y + r.h),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
  });
  const cclamp = (r: CropRect): CropRect => {
    const { w: sw, h: sh } = grapher.sourceSize();
    const x = Math.max(0, Math.min(sw - 1, r.x));
    const y = Math.max(0, Math.min(sh - 1, r.y));
    return {
      x,
      y,
      w: Math.max(1, Math.min(sw - x, r.w)),
      h: Math.max(1, Math.min(sh - y, r.h)),
    };
  };
  // Resize `o` by moving the (hx, hy) handle to source point `p`; opposite edges fixed.
  const cResized = (
    o: CropRect,
    hx: number,
    hy: number,
    p: { x: number; y: number },
  ): CropRect => {
    let { x, y, w, h } = o;
    if (hx === -1) {
      const right = o.x + o.w;
      x = Math.min(p.x, right - 1);
      w = right - x;
    } else if (hx === 1) {
      w = Math.max(1, p.x - o.x);
    }
    if (hy === -1) {
      const bottom = o.y + o.h;
      y = Math.min(p.y, bottom - 1);
      h = bottom - y;
    } else if (hy === 1) {
      h = Math.max(1, p.y - o.y);
    }
    return { x, y, w, h };
  };

  // Pointer → source pixels (unclamped; callers clamp the resulting rect).
  const toSource = (e: PointerEvent): { x: number; y: number } => {
    const b = cropLayer.getBoundingClientRect();
    const ir = imageRect();
    return {
      x: ((e.clientX - b.left - ir.x) / ir.w) * ir.sw,
      y: ((e.clientY - b.top - ir.y) / ir.h) * ir.sh,
    };
  };

  const drawCrop = (): void => {
    if (!cropRect) {
      cropRectEl.style.display = "none";
      return;
    }
    const r = cnorm(cropRect);
    const ir = imageRect();
    cropRectEl.style.display = "block";
    cropRectEl.style.left = `${ir.x + (r.x / ir.sw) * ir.w}px`;
    cropRectEl.style.top = `${ir.y + (r.y / ir.sh) * ir.h}px`;
    cropRectEl.style.width = `${(r.w / ir.sw) * ir.w}px`;
    cropRectEl.style.height = `${(r.h / ir.sh) * ir.h}px`;
  };

  function enterCrop(): void {
    if (!grapher.hasSource()) return;
    cropActive = true;
    cropDrag = null;
    resetView(); // crop coords assume the fitted view — snap back to it
    // Start inset, not full-frame: the margin leaves room to draw a fresh rect
    // (a drag inside the rect moves it instead) and reads as adjustable.
    const { w: sw, h: sh } = grapher.sourceSize();
    const mx = Math.round(sw * 0.1);
    const my = Math.round(sh * 0.1);
    cropRect = { x: mx, y: my, w: sw - mx * 2, h: sh - my * 2 };
    cropLayer.classList.remove("hidden");
    cropbar.classList.remove("hidden");
    editBar.classList.add("hidden");
    hint.classList.add("hidden");
    drawCrop();
    schedulePresent(); // drop the divider while framing the crop
  }
  function exitCrop(): void {
    cropActive = false;
    cropDrag = null;
    cropRect = null;
    cropRectEl.style.display = "none";
    cropLayer.classList.add("hidden");
    cropbar.classList.add("hidden");
    editBar.classList.remove("hidden");
    hint.classList.remove("hidden");
    schedulePresent(); // divider comes back (if compare is on)
  }

  cropLayer.addEventListener("pointerdown", (e) => {
    if (!cropActive || !cropRect || e.button !== 0) return;
    const b = cropLayer.getBoundingClientRect();
    const sx = e.clientX - b.left;
    const sy = e.clientY - b.top;
    const p = toSource(e);
    const r = cnorm(cropRect);
    const ir = imageRect();

    // Handle grab wins over move wins over drawing a new rect.
    for (const [hx, hy] of HANDLES) {
      const hxs = r.x + ((hx + 1) / 2) * r.w;
      const hys = r.y + ((hy + 1) / 2) * r.h;
      const px = ir.x + (hxs / ir.sw) * ir.w;
      const py = ir.y + (hys / ir.sh) * ir.h;
      if (Math.abs(px - sx) <= HANDLE_HIT && Math.abs(py - sy) <= HANDLE_HIT) {
        cropDrag = { kind: "resize", hx, hy, orig: r };
        cropRect = r;
        cropLayer.setPointerCapture(e.pointerId);
        drawCrop();
        return;
      }
    }
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      cropDrag = { kind: "move", ox: p.x, oy: p.y, orig: r };
      cropRect = r;
    } else {
      cropDrag = { kind: "new", ax: p.x, ay: p.y };
      cropRect = { x: p.x, y: p.y, w: 0, h: 0 };
    }
    cropLayer.setPointerCapture(e.pointerId);
    drawCrop();
  });
  cropLayer.addEventListener("pointermove", (e) => {
    if (!cropActive || !cropDrag) return;
    const p = toSource(e);
    const { w: sw, h: sh } = grapher.sourceSize();
    if (cropDrag.kind === "new") {
      cropRect = cclamp(
        cnorm({
          x: cropDrag.ax,
          y: cropDrag.ay,
          w: p.x - cropDrag.ax,
          h: p.y - cropDrag.ay,
        }),
      );
    } else if (cropDrag.kind === "move") {
      const x = Math.max(
        0,
        Math.min(sw - cropDrag.orig.w, cropDrag.orig.x + (p.x - cropDrag.ox)),
      );
      const y = Math.max(
        0,
        Math.min(sh - cropDrag.orig.h, cropDrag.orig.y + (p.y - cropDrag.oy)),
      );
      cropRect = { x, y, w: cropDrag.orig.w, h: cropDrag.orig.h };
    } else {
      cropRect = cclamp(cResized(cropDrag.orig, cropDrag.hx, cropDrag.hy, p));
    }
    drawCrop();
  });
  const endCropDrag = (e: PointerEvent): void => {
    if (!cropDrag) return;
    cropDrag = null;
    if (cropRect) cropRect = cclamp(cnorm(cropRect));
    if (cropLayer.hasPointerCapture(e.pointerId))
      cropLayer.releasePointerCapture(e.pointerId);
    drawCrop();
  };
  cropLayer.addEventListener("pointerup", endCropDrag);
  cropLayer.addEventListener("pointercancel", endCropDrag);

  const applyCrop = async (): Promise<void> => {
    if (!cropActive || !currentBitmap || !cropRect) {
      exitCrop();
      return;
    }
    const { w: sw, h: sh } = grapher.sourceSize();
    const r = cclamp(cnorm(cropRect));
    // Full-frame selection is a no-op — just leave crop mode.
    const changes = r.x > 0 || r.y > 0 || r.w < sw || r.h < sh;
    exitCrop();
    if (!changes) return;
    const bmp = await cropBitmap(
      currentBitmap,
      Math.round(r.x),
      Math.round(r.y),
      Math.round(r.w),
      Math.round(r.h),
    );
    adoptSource(bmp);
  };

  root
    .querySelector<HTMLButtonElement>("#g-crop")!
    .addEventListener("click", () => enterCrop());
  root
    .querySelector<HTMLButtonElement>("#g-crop-apply")!
    .addEventListener("click", () => void applyCrop());
  root
    .querySelector<HTMLButtonElement>("#g-crop-cancel")!
    .addEventListener("click", () => exitCrop());
  window.addEventListener("keydown", (e) => {
    if (!cropActive || isVisibleHidden(root)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void applyCrop();
    } else if (e.key === "Escape") {
      e.preventDefault();
      exitCrop();
    }
  });

  // ── Export ───────────────────────────────────────────────────────────
  copyBtn.addEventListener("click", () => void exportImage("copy"));
  saveBtn.addEventListener("click", () => void exportImage("save"));

  async function exportImage(mode: "copy" | "save"): Promise<void> {
    if (!grapher.hasSource()) return;
    grapher.render(params); // ensure the full-res result is current
    const { data, w, h } = grapher.readResult();
    const off = new OffscreenCanvas(w, h);
    const img = new ImageData(w, h);
    img.data.set(data);
    off.getContext("2d")!.putImageData(img, 0, 0);

    // Copy always goes to the clipboard as PNG (widest ClipboardItem support).
    if (mode === "copy") {
      const blob = await off.convertToBlob({ type: "image/png" });
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ "image/png": blob }),
        ]);
        flash(copyBtn, "Copied");
      } catch {
        flash(copyBtn, "Blocked");
      }
      return;
    }

    const jpeg = exportOpts.format === "jpeg";
    const blob = await off.convertToBlob(
      jpeg
        ? { type: "image/jpeg", quality: exportOpts.quality / 100 }
        : { type: "image/png" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sourceName}-grain.${jpeg ? "jpg" : "png"}`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (grapher.capabilityNote) {
    const note = document.createElement("small");
    note.className = "g-cap-note";
    note.textContent = grapher.capabilityNote;
    panel.appendChild(note);
  }
}

/** True when this tool's route screen is hidden (so global key handlers no-op). */
function isVisibleHidden(root: HTMLElement): boolean {
  return root.closest(".route-screen")?.classList.contains("hidden") ?? false;
}

function flash(btn: HTMLButtonElement, text: string): void {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = prev), 1200);
}

// ── Control panel ──────────────────────────────────────────────────────

function buildPanel(
  panel: HTMLElement,
  params: Params,
  onChange: () => void,
): void {
  panel.innerHTML = `
    <div class="g-group">
      <h2>preset</h2>
      <div class="g-presets">
        ${PRESET_NAMES.map((n) => `<button class="chip" data-preset="${n}">${n}</button>`).join("")}
      </div>
    </div>
    <div class="g-group">
      <h2>upscale</h2>
      ${slider("scale", "scale", 2, 8, 0.5, params.scale, "×")}
      ${select("kernel", "kernel", params.kernel, [
        ["mitchell", "Mitchell"],
        ["catmull", "Catmull-Rom"],
        ["nearest", "Nearest"],
      ])}
    </div>
    <div class="g-group">
      <h2>deblock</h2>
      ${slider("deblock", "amount", 0, 100, 1, params.deblock, "")}
      ${slider("edgePreserve", "edge preservation", 0, 100, 1, params.edgePreserve, "")}
    </div>
    <div class="g-group">
      <h2>grain</h2>
      ${slider("grainAmount", "amount", 0, 100, 1, params.grainAmount, "")}
      ${slider("grainSize", "size", 0.5, 4, 0.1, params.grainSize, "px")}
      ${chips("octaves", "octaves", String(params.octaves), [
        ["1", "1"],
        ["2", "2"],
      ])}
      ${slider("shadowRolloff", "shadow rolloff", 0.4, 3, 0.1, params.shadowRolloff, "")}
      ${slider("chroma", "chroma", 0, 30, 1, params.chroma, "")}
      ${select("blend", "blend", params.blend, [
        ["additive", "Additive"],
        ["softlight", "Soft light"],
        ["multiply", "Multiply"],
      ])}
    </div>
    <div class="g-group">
      <h2>finish</h2>
      ${slider("sharpen", "micro-contrast", 0, 100, 1, params.sharpen, "%")}
      ${slider("halation", "halation", 0, 100, 1, params.halation, "%")}
      ${slider("desaturate", "desaturate", 0, 100, 1, params.desaturate, "%")}
    </div>
  `;

  const numeric = new Set([
    "scale",
    "deblock",
    "edgePreserve",
    "grainAmount",
    "grainSize",
    "shadowRolloff",
    "chroma",
    "sharpen",
    "halation",
    "desaturate",
  ]);

  panel
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")
    .forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.key as keyof Params;
        if (numeric.has(key)) {
          (params[key] as number) = Number((el as HTMLInputElement).value);
          const out = el.parentElement?.querySelector<HTMLElement>(".g-val");
          if (out) out.textContent = formatVal(el.value, el.dataset.unit ?? "");
        } else if (key === "octaves") {
          (params.octaves as number) = Number(el.value) as 1 | 2;
        } else {
          (params[key] as string) = el.value;
        }
        onChange();
      });
    });

  // Chip groups (octaves) — toggle active, write value.
  panel.querySelectorAll<HTMLElement>(".g-chips").forEach((group) => {
    group.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        group
          .querySelectorAll(".chip")
          .forEach((c) => c.classList.remove("on"));
        chip.classList.add("on");
        const key = group.dataset.key as keyof Params;
        (params.octaves as number) = Number(chip.dataset.val) as 1 | 2;
        void key;
        onChange();
      });
    });
  });

  // Presets.
  panel.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      Object.assign(params, PRESETS[btn.dataset.preset as PresetName]);
      syncControls(panel, params);
      onChange();
    });
  });

  syncControls(panel, params);
  syncPresetHighlight(panel, params);
}

function slider(
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  unit: string,
): string {
  return `
    <div class="g-row">
      <label for="g-${key}">${label}<span class="g-val">${formatVal(String(value), unit)}</span></label>
      <input id="g-${key}" type="range" data-key="${key}" data-unit="${unit}" min="${min}" max="${max}" step="${step}" value="${value}" />
    </div>`;
}

function select(
  key: string,
  label: string,
  value: string,
  opts: [string, string][],
): string {
  return `
    <div class="g-row">
      <label for="g-${key}">${label}</label>
      <select id="g-${key}" data-key="${key}">
        ${opts.map(([v, t]) => `<option value="${v}"${v === value ? " selected" : ""}>${t}</option>`).join("")}
      </select>
    </div>`;
}

function chips(
  key: string,
  label: string,
  value: string,
  opts: [string, string][],
): string {
  return `
    <div class="g-row">
      <span class="g-chips-label">${label}</span>
      <div class="g-chips" data-key="${key}" role="group" aria-label="${label}">
        ${opts.map(([v, t]) => `<button class="chip${v === value ? " on" : ""}" data-val="${v}">${t}</button>`).join("")}
      </div>
    </div>`;
}

function formatVal(v: string, unit: string): string {
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return unit === "×"
    ? `${s}×`
    : unit
      ? `${s}${unit === "px" || unit === "%" ? "" : " "}${unit}`
      : s;
}

/** Push params back into the controls (after a preset or reset). */
function syncControls(panel: HTMLElement, params: Params): void {
  panel
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>("[data-key]")
    .forEach((el) => {
      const key = el.dataset.key as keyof Params;
      if (key === "octaves") return;
      const val = String(params[key]);
      (el as HTMLInputElement).value = val;
      const out = el.parentElement?.querySelector<HTMLElement>(".g-val");
      if (out) out.textContent = formatVal(val, el.dataset.unit ?? "");
    });
  panel.querySelectorAll<HTMLElement>(".g-chips").forEach((group) => {
    group.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
      chip.classList.toggle("on", chip.dataset.val === String(params.octaves));
    });
  });
}

/** Light up the preset chip whose settings the current params exactly match. */
function syncPresetHighlight(panel: HTMLElement, params: Params): void {
  panel.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    const preset = PRESETS[btn.dataset.preset as PresetName];
    const match = Object.entries(preset).every(
      ([k, v]) => params[k as keyof Params] === v,
    );
    btn.classList.toggle("on", match);
  });
}
