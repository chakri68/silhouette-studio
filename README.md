# silhouette_studio

drop an image, get a clean cutout. the machine takes the first pass, you fix the
last 10% by hand with a brush, then export a PNG, an SVG, or a traced flat
silhouette. everything runs on-device — your image never leaves the browser.

## why this exists

i wanted to pull a subject out of a photo without opening photoshop, and without
feeding it to some "free" background remover that keeps the image and emails me
forever after. so: a small browser tool that does the boring 90% automatically
and hands you a brush for the rest.

## what it does

- **auto-cutout** — a matting model runs _in your browser_ and takes the first
  guess. no server, no upload.
- **refine by hand** — an add/erase brush paints the selection mask directly. the
  unselected region shows as a gray overlay; painting reveals or re-hides it.
- **zoom + pan** — scroll to zoom toward the cursor, space- or middle-drag to pan.
  paint at any zoom; edits stay crisp because they happen in image space, not
  screen space.
- **undo / redo** — snapshot per stroke; the auto-seed is the floor you can't undo
  past.
- **export**, three flavors:
  - **PNG** — transparent cutout.
  - **SVG** — the same cutout embedded as a raster inside an SVG wrapper. keeps the
    picture; it's _not_ vectorized color.
  - **Silhouette** — the real vector. traces the _mask_ (not the colors) into a
    flat shape, with fill / border / thickness controls and a live preview.

## how it works (the load-bearing bits)

one selection **mask** and three offscreen canvases — image, mask, overlay — all
at the image's native resolution. the visible canvas is composited every frame
under a zoom/pan transform. painting happens in _image_ coordinates, so strokes
don't smear when you're zoomed in, and devicePixelRatio is folded into the render
transform so the brush lands where the cursor is on a retina screen.

the auto-seed is [RMBG-1.4](https://huggingface.co/briaai/RMBG-1.4) via
[transformers.js](https://github.com/huggingface/transformers.js), running in a
**web worker** so the seconds of inference don't freeze the tab. it uses
**WebGPU** where there's a real GPU adapter — fp16 if the adapter has `shader-f16`,
else fp32 — and falls back to **WASM** everywhere else. the model downloads once
(tens of MB) and caches in the browser; there's a progress bar for the first run.

the silhouette trace is [esm-potrace-wasm](https://github.com/tomayac/esm-potrace-wasm).
potrace traces dark-on-light, so the mask is painted black-on-white first, or the
shape comes out inverted. it also emits the path in its own scaled + y-flipped
space wrapped in a `<g transform>` — that transform is kept verbatim, otherwise
the silhouette lands off-canvas and upside down. ask me how i know.

## stack

- **Vite + vanilla TypeScript** — no framework. state is one plain object with an
  explicit re-render, not a reactive lib.
- **plain CSS** — hand-written, amber-phosphor-CRT theme. no tailwind.
- **@huggingface/transformers** — RMBG-1.4 matting.
- **esm-potrace-wasm** — raster → vector for the silhouette.

two runtime dependencies. kept lean on purpose.

## run it

```sh
npm install
npm run dev      # → localhost:5173
npm run build    # → dist/
```

## keys

| key                     | does               |
| ----------------------- | ------------------ |
| `B` / `E`               | add / erase brush  |
| `[` / `]`               | brush size         |
| scroll                  | zoom toward cursor |
| space- or middle-drag   | pan                |
| `Ctrl`/`Cmd` `+Z`       | undo               |
| `Ctrl`/`Cmd` `+Shift+Z` | redo               |

## honest caveats

- the first cutout waits on a one-time model download (cached after). ~1–2s on
  WebGPU, closer to ~15s on WASM — but it's in a worker, so the page stays alive
  and animated while it churns.
- the auto-seed is good, not psychic. stylized art or unusual subjects need more
  brushing. that's what the brush is for.
- desktop mouse + wheel only for now. touch is structured-for but not built.

## layout

```
src/
  engine/   canvas + compositing, viewport (zoom/pan), brush, undo history
  ui/       toolbar, preview modal, silhouette panel, dropzone
  export/   png · svg · download
  segmentation.ts + .worker.ts   RMBG-1.4, off the main thread
  trace.ts  potrace wrapper
```

---

Inspired by the tool from Shuffles by Pinterest
