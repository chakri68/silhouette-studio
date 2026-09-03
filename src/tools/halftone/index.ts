import type { Route } from "../../main";
import { initDropzone } from "../../ui/dropzone";
import { controls, formatVal } from "../../ui/controls";
import { buildLuminanceBuffer, buildIntegral } from "./core/luminance";
import { preprocess } from "./core/preprocess";
import { renderHalftone, type LumaField, type Viewport } from "./core/render";
import {
  DEFAULT_SETTINGS,
  PRESETS,
  PREPROCESS_KEYS,
  type HalftoneSettings,
  type PresetName,
} from "./core/settings";

/**
 * The halftone tool: rebuild an image out of a rigid grid of black circles, the
 * way a comic page is printed. Left is the screen, right is the panel.
 *
 * Two caches sit behind the sliders, because the work splits cleanly in two. The
 * tonal pass (brightness…blur…threshold) walks every pixel and is the expensive
 * one; the draw pass only visits grid cells. Dot sliders therefore skip straight
 * to drawing, and only the image sliders pay for a re-preprocess.
 */

// Sampling resolution. Beyond this, extra source pixels stop changing cell
// averages in any way a dot radius can express — they just cost time.
const WORKING_MAX = 1400;
const MAX_WORKING_PX = 4_000_000;
const MAX_EXPORT_PX = 40_000_000;
const MAX_ZOOM = 24;

const PRESET_NAMES: PresetName[] = ["Clean", "Comic", "Heavy ink"];

export function mountHalftone(root: HTMLElement, navigate: (route: Route) => void): void {
  root.innerHTML = `
    <header class="topbar">
      <button class="btn back" id="h-back" title="Back to studio">←</button>
      <h1>halftone</h1>
      <div class="spacer"></div>
      <span class="readout" id="h-res">—</span>
      <button class="btn" id="h-open">Open…</button>
      <button class="btn" id="h-copy" disabled>Copy</button>
      <button class="btn primary" id="h-save" disabled>Save</button>
    </header>
    <div class="g-body">
      <div class="screen g-screen h-screen">
        <canvas id="h-canvas"></canvas>
        <div class="dropzone" id="h-dropzone">
          <div class="dz-inner">
            <div class="dz-title">DROP OR PASTE AN IMAGE</div>
            <div class="dz-sub">click to browse, or paste — png · jpg · webp · gif · bmp</div>
          </div>
        </div>
        <div class="g-hint hidden" id="h-hint">scroll to zoom · drag to pan · SPACE for source</div>
      </div>
      <aside class="panel g-panel"></aside>
    </div>
    <input type="file" id="h-file" accept="image/*" hidden />
  `;

  const canvas = root.querySelector<HTMLCanvasElement>("#h-canvas")!;
  const ctx = canvas.getContext("2d")!;
  const dropzone = root.querySelector<HTMLElement>("#h-dropzone")!;
  const fileInput = root.querySelector<HTMLInputElement>("#h-file")!;
  const panel = root.querySelector<HTMLElement>(".g-panel")!;
  const hint = root.querySelector<HTMLElement>("#h-hint")!;
  const readout = root.querySelector<HTMLElement>("#h-res")!;
  const openBtn = root.querySelector<HTMLButtonElement>("#h-open")!;
  const copyBtn = root.querySelector<HTMLButtonElement>("#h-copy")!;
  const saveBtn = root.querySelector<HTMLButtonElement>("#h-save")!;

  root.querySelector<HTMLButtonElement>("#h-back")!.addEventListener("click", () => navigate("hub"));

  const settings: HalftoneSettings = { ...DEFAULT_SETTINGS };

  let bitmap: ImageBitmap | null = null; // kept for the SPACE source flash
  let sourceName = "image";
  let W = 0; // working (sampling) size
  let H = 0;
  let baseLuma: Float32Array | null = null; // untouched source luminance
  let field: LumaField | null = null; // preprocessed + summed-area table
  let dots = 0;
  let exportScale = 2;
  let showSource = false;

  let zoom = 1;
  let panX = 0;
  let panY = 0;

  // ── View maths ───────────────────────────────────────────────────────
  // The image is aspect-fitted and centred; zoom multiplies that, pan slides it.
  // All of this lives in the draw pass, so it never re-runs the tonal pipeline.
  const fitScale = (): number => Math.min(canvas.width / W, canvas.height / H);

  const clampPan = (): void => {
    const s = fitScale() * zoom;
    const limX = Math.max(0, (W * s - canvas.width) / 2);
    const limY = Math.max(0, (H * s - canvas.height) / 2);
    panX = Math.max(-limX, Math.min(limX, panX));
    panY = Math.max(-limY, Math.min(limY, panY));
  };

  const viewport = (): Viewport => {
    const s = fitScale() * zoom;
    return {
      scale: s,
      originX: (canvas.width - W * s) / 2 + panX,
      originY: (canvas.height - H * s) / 2 + panY,
      width: canvas.width,
      height: canvas.height,
    };
  };

  // ── Render scheduling ────────────────────────────────────────────────
  let fieldDirty = false;
  let drawDirty = false;
  let raf = 0;

  const frame = (): void => {
    raf = 0;
    if (!baseLuma) return;
    if (fieldDirty) {
      const luma = preprocess(baseLuma, W, H, settings);
      // The table is built unconditionally so flipping the sampling mode stays a
      // draw-pass decision — it costs one pass over a buffer we just wrote anyway.
      field = { luma, sat: buildIntegral(luma, W, H), width: W, height: H };
      fieldDirty = false;
      drawDirty = true;
    }
    if (drawDirty) {
      draw();
      drawDirty = false;
    }
  };
  const kick = (): void => {
    if (!raf) raf = requestAnimationFrame(frame);
  };
  const scheduleField = (): void => {
    if (!baseLuma) return;
    fieldDirty = true;
    kick();
  };
  const scheduleDraw = (): void => {
    if (!baseLuma) return;
    drawDirty = true;
    kick();
  };

  function draw(): void {
    if (!field) return;
    if (showSource && bitmap) {
      const v = viewport();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, v.originX, v.originY, W * v.scale, H * v.scale);
      return;
    }
    dots = renderHalftone(field, ctx, settings, viewport());
    refreshReadout();
  }

  const refreshReadout = (): void => {
    readout.textContent = baseLuma ? `${W}×${H} · ${dots.toLocaleString()} dots` : "—";
  };

  // ── Canvas sizing ────────────────────────────────────────────────────
  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w;
    canvas.height = h;
    if (baseLuma) clampPan();
    scheduleDraw();
  };
  window.addEventListener("resize", resize);
  resize();

  // ── Ingest ───────────────────────────────────────────────────────────
  function ingest(bmp: ImageBitmap, name: string): void {
    if (bitmap && bitmap !== bmp) bitmap.close();
    bitmap = bmp;
    sourceName = name.replace(/\.[^.]+$/, "") || "image";

    let s = Math.min(1, WORKING_MAX / Math.max(bmp.width, bmp.height));
    const px = bmp.width * bmp.height;
    if (px * s * s > MAX_WORKING_PX) s = Math.sqrt(MAX_WORKING_PX / px);
    W = Math.max(1, Math.round(bmp.width * s));
    H = Math.max(1, Math.round(bmp.height * s));

    const off = document.createElement("canvas");
    off.width = W;
    off.height = H;
    const octx = off.getContext("2d", { willReadFrequently: true })!;
    octx.drawImage(bmp, 0, 0, W, H);
    baseLuma = buildLuminanceBuffer(octx.getImageData(0, 0, W, H).data, W, H);

    zoom = 1;
    panX = 0;
    panY = 0;
    dropzone.classList.add("hidden");
    hint.classList.remove("hidden");
    copyBtn.disabled = false;
    saveBtn.disabled = false;
    syncExportScales();
    scheduleField();
  }

  initDropzone({ dropzone, fileInput, openButton: openBtn }, ingest);

  // ── Zoom + pan ───────────────────────────────────────────────────────
  // Device-pixel coords, because that is the space the viewport is expressed in.
  const toDevice = (clientX: number, clientY: number): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) * (canvas.width / r.width),
      y: (clientY - r.top) * (canvas.height / r.height),
    };
  };

  /** Zoom about a screen point, holding the image pixel under it still. */
  const zoomToward = (factor: number, clientX: number, clientY: number): void => {
    const next = Math.max(1, Math.min(MAX_ZOOM, zoom * factor));
    if (next === zoom) return;
    const p = toDevice(clientX, clientY);
    const f = fitScale();
    const s0 = f * zoom;
    const s1 = f * next;
    const imgX = (p.x - ((canvas.width - W * s0) / 2 + panX)) / s0;
    const imgY = (p.y - ((canvas.height - H * s0) / 2 + panY)) / s0;
    panX = p.x - imgX * s1 - (canvas.width - W * s1) / 2;
    panY = p.y - imgY * s1 - (canvas.height - H * s1) / 2;
    zoom = next;
    if (zoom === 1) {
      panX = 0;
      panY = 0;
    }
    clampPan();
    scheduleDraw();
  };

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; panX: number; panY: number } | null = null;
  let pinch: { dist: number; midX: number; midY: number } | null = null;

  const beginPinch = (): void => {
    const [a, b] = [...pointers.values()];
    pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
    };
    drag = null;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (!baseLuma) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* nothing to capture */
    }
    if (pointers.size >= 2) {
      beginPinch();
      e.preventDefault();
      return;
    }
    if (e.button === 0) drag = { x: e.clientX, y: e.clientY, panX, panY };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const r = canvas.getBoundingClientRect();
    const toDev = canvas.width / r.width;
    if (pinch) {
      const [a, b] = [...pointers.values()];
      if (!a || !b) return;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      if (pinch.dist > 0) {
        zoomToward(dist / pinch.dist, midX, midY);
        panX += (midX - pinch.midX) * toDev;
        panY += (midY - pinch.midY) * (canvas.height / r.height);
        clampPan();
        scheduleDraw();
      }
      pinch = { dist, midX, midY };
    } else if (drag) {
      panX = drag.panX + (e.clientX - drag.x) * toDev;
      panY = drag.panY + (e.clientY - drag.y) * (canvas.height / r.height);
      clampPan();
      scheduleDraw();
    }
  });

  const endPointer = (e: PointerEvent): void => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (pointers.size === 1 && pinch) {
      const [p] = [...pointers.values()];
      pinch = null;
      drag = { x: p.x, y: p.y, panX, panY };
    } else if (pointers.size === 0) {
      drag = null;
      pinch = null;
    }
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!baseLuma) return;
      e.preventDefault();
      zoomToward(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false },
  );
  canvas.addEventListener("dblclick", () => {
    if (!baseLuma || zoom === 1) return;
    zoom = 1;
    panX = 0;
    panY = 0;
    scheduleDraw();
  });

  // SPACE swaps in the source. Worth having: at a glance the dots read as tone,
  // and the only way to judge whether they read as the *right* tone is the flip.
  window.addEventListener("keydown", (e) => {
    if (e.key !== " " || showSource || isHidden(root)) return;
    showSource = true;
    e.preventDefault();
    scheduleDraw();
  });
  window.addEventListener("keyup", (e) => {
    if (e.key !== " " || !showSource) return;
    showSource = false;
    scheduleDraw();
  });

  // ── Panel ────────────────────────────────────────────────────────────
  buildPanel(panel, settings, (key) => {
    if (PREPROCESS_KEYS.has(key)) scheduleField();
    else scheduleDraw();
  });

  const exportGroup = document.createElement("div");
  exportGroup.className = "g-group";
  exportGroup.innerHTML = `
    <h2>export</h2>
    <div class="g-row">
      <label for="h-export-scale">resolution</label>
      <select id="h-export-scale" data-noparam></select>
    </div>
    <small class="g-note">The dot pattern is fixed in image space, so a bigger export is the same
    halftone rasterised finer — not more dots. Circles stay crisp all the way up.</small>
  `;
  panel.appendChild(exportGroup);
  const scaleSel = exportGroup.querySelector<HTMLSelectElement>("#h-export-scale")!;

  /** Offer only the multipliers whose output stays inside the safe pixel budget. */
  function syncExportScales(): void {
    if (!baseLuma) {
      scaleSel.innerHTML = `<option>—</option>`;
      scaleSel.disabled = true;
      return;
    }
    scaleSel.disabled = false;
    const opts: string[] = [];
    let best = 1;
    for (const s of [1, 2, 3, 4]) {
      const w = Math.round(W * s);
      const h = Math.round(H * s);
      if (w * h > MAX_EXPORT_PX) break;
      opts.push(`<option value="${s}">${s}× — ${w}×${h}</option>`);
      if (s <= 2) best = s;
    }
    scaleSel.innerHTML = opts.join("");
    exportScale = best;
    scaleSel.value = String(best);
  }
  scaleSel.addEventListener("change", () => {
    exportScale = Number(scaleSel.value);
  });
  syncExportScales();

  // ── Export ───────────────────────────────────────────────────────────
  copyBtn.addEventListener("click", () => void exportImage("copy"));
  saveBtn.addEventListener("click", () => void exportImage("save"));

  async function exportImage(mode: "copy" | "save"): Promise<void> {
    if (!field) return;
    const w = Math.round(W * exportScale);
    const h = Math.round(H * exportScale);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    // Same renderer, same settings — only the viewport differs. That is what
    // makes the export a re-render rather than a screenshot of the preview.
    renderHalftone(field, out.getContext("2d")!, settings, {
      scale: exportScale,
      originX: 0,
      originY: 0,
      width: w,
      height: h,
    });

    const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
    if (!blob) return;

    if (mode === "copy") {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        flash(copyBtn, "Copied");
      } catch {
        flash(copyBtn, "Blocked");
      }
      return;
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${sourceName}-halftone.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** True when this tool's route screen is hidden, so global key handlers no-op. */
function isHidden(root: HTMLElement): boolean {
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
  settings: HalftoneSettings,
  onChange: (key: string) => void,
): void {
  const { slider, chips, toggle } = controls("h");
  panel.innerHTML = `
    <div class="g-group">
      <h2>preset</h2>
      <div class="g-presets">
        ${PRESET_NAMES.map((n) => `<button class="chip" data-preset="${n}">${n}</button>`).join("")}
        <button class="chip" data-preset="reset">Reset</button>
      </div>
    </div>
    <div class="g-group">
      <h2>dots</h2>
      ${slider("spacing", "spacing", 3, 40, 1, settings.spacing, "px")}
      ${slider("maxRadiusRatio", "max size", 0.25, 0.85, 0.01, settings.maxRadiusRatio, "×")}
      ${slider("minRadius", "min size", 0, 3, 0.1, settings.minRadius, "px")}
      ${slider("dotGamma", "response", 0.2, 3, 0.05, settings.dotGamma, "")}
    </div>
    <div class="g-group">
      <h2>image</h2>
      ${slider("brightness", "brightness", -1, 1, 0.01, settings.brightness, "")}
      ${slider("contrast", "contrast", -1, 1, 0.01, settings.contrast, "")}
      ${slider("imageGamma", "gamma", 0.2, 3, 0.05, settings.imageGamma, "")}
      ${slider("blurRadius", "blur", 0, 10, 0.1, settings.blurRadius, "px")}
    </div>
    <div class="g-group">
      <h2>stylise</h2>
      ${toggle("thresholdEnabled", "threshold", settings.thresholdEnabled)}
      <div data-requires="thresholdEnabled">
        ${slider("threshold", "level", 0, 1, 0.01, settings.threshold, "")}
        ${slider("thresholdSoftness", "softness", 0, 0.5, 0.01, settings.thresholdSoftness, "")}
      </div>
      ${toggle("invert", "invert", settings.invert)}
    </div>
    <div class="g-group">
      <h2>grid</h2>
      ${slider("offsetX", "offset x", -20, 20, 0.5, settings.offsetX, "px")}
      ${slider("offsetY", "offset y", -20, 20, 0.5, settings.offsetY, "px")}
    </div>
    <div class="g-group">
      <h2>render</h2>
      ${chips("samplingMode", "sampling", settings.samplingMode, [
        ["average", "Average"],
        ["center", "Center"],
      ])}
      ${toggle("antialias", "antialias", settings.antialias)}
    </div>
  `;

  const bag = settings as unknown as Record<string, unknown>;

  // One generic handler: the element's own type says how to read it, so adding a
  // setting means adding a row and nothing else.
  panel
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[data-key], select[data-key]",
    )
    .forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.key!;
        if (el instanceof HTMLInputElement && el.type === "checkbox") {
          bag[key] = el.checked;
        } else if (el instanceof HTMLInputElement && el.type === "range") {
          bag[key] = Number(el.value);
          const out = el.parentElement?.querySelector<HTMLElement>(".g-val");
          if (out) out.textContent = formatVal(el.value, el.dataset.unit ?? "");
        } else {
          bag[key] = el.value;
        }
        syncDependants(panel, settings);
        syncPresetHighlight(panel, settings);
        onChange(key);
      });
    });

  panel.querySelectorAll<HTMLElement>(".g-chips").forEach((group) => {
    group.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        group.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
        chip.classList.add("on");
        bag[group.dataset.key!] = chip.dataset.val!;
        onChange(group.dataset.key!);
      });
    });
  });

  panel.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.preset!;
      // Merge over the defaults, never over the current state, so a preset means
      // the same thing whatever you were looking at when you clicked it.
      Object.assign(
        settings,
        DEFAULT_SETTINGS,
        name === "reset" ? {} : PRESETS[name as PresetName],
      );
      syncControls(panel, settings);
      onChange("brightness"); // a preset can touch tonal keys — rebuild the field
    });
  });

  syncControls(panel, settings);
}

/** Push settings back into the controls (after a preset or reset). */
function syncControls(panel: HTMLElement, settings: HalftoneSettings): void {
  const bag = settings as unknown as Record<string, unknown>;
  panel
    .querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      "input[data-key], select[data-key]",
    )
    .forEach((el) => {
      const value = bag[el.dataset.key!];
      if (el instanceof HTMLInputElement && el.type === "checkbox") {
        el.checked = Boolean(value);
        return;
      }
      el.value = String(value);
      const out = el.parentElement?.querySelector<HTMLElement>(".g-val");
      if (out) out.textContent = formatVal(el.value, el.dataset.unit ?? "");
    });
  panel.querySelectorAll<HTMLElement>(".g-chips").forEach((group) => {
    const value = String(bag[group.dataset.key!]);
    group.querySelectorAll<HTMLButtonElement>(".chip").forEach((chip) => {
      chip.classList.toggle("on", chip.dataset.val === value);
    });
  });
  syncDependants(panel, settings);
  syncPresetHighlight(panel, settings);
}

/** Grey out rows whose governing toggle is off (threshold level/softness). */
function syncDependants(panel: HTMLElement, settings: HalftoneSettings): void {
  const bag = settings as unknown as Record<string, unknown>;
  panel.querySelectorAll<HTMLElement>("[data-requires]").forEach((el) => {
    el.classList.toggle("off", !bag[el.dataset.requires!]);
  });
}

/** Light up the preset whose settings the current state exactly matches. */
function syncPresetHighlight(panel: HTMLElement, settings: HalftoneSettings): void {
  const bag = settings as unknown as Record<string, unknown>;
  panel.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((btn) => {
    const name = btn.dataset.preset!;
    const preset =
      name === "reset" ? DEFAULT_SETTINGS : PRESETS[name as PresetName];
    btn.classList.toggle(
      "on",
      Object.entries(preset).every(([k, v]) => bag[k] === v),
    );
  });
}
