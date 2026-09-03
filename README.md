# studio

three on-device image tools that never phone home. pick one from the hub:

- **silhouette** — drop an image, get a clean cutout. the machine takes the first
  pass, you fix the last 10% by hand with a brush, then export a PNG, an SVG, or a
  traced flat silhouette.
- **grainery** — de-pixelate a low-res image and buy the detail back with
  film-grade grain. upscale in linear light, straighten the block edges the pixel
  grid drew, then lay down blue-noise grain that rides perceptual lightness so it
  reads like film, not TV static.
- **halftone** — rebuild an image out of comic ink dots. a rigid grid of black
  circles on white, each one sized by the darkness underneath it, with a soft
  threshold to push it from photographic into full ben-day comic territory.

everything runs in the browser. your image never leaves the tab — no upload, no
"free" server that keeps a copy. drop a file, click to browse, or paste from the
clipboard (`Cmd`/`Ctrl`+`V`).

## why this exists

**silhouette**: i wanted to pull a subject out of a photo without opening
photoshop, and without feeding it to some "free" background remover that keeps the
image and emails me forever after. so: a small browser tool that does the boring
90% automatically and hands you a brush for the rest.

**grainery**: upscalers hand you a choice between soft mush and that plasticky
AI-smoothed look, and both of them sand off the thing that made the picture read
as a photo — grain. so this one reconstructs the edges the pixel grid mangled,
then puts the texture back. the grain is the point, not an afterthought.

**halftone**: every "halftone filter" i tried was really a dither, or a CMYK print
simulation with four rosette screens fighting each other. i wanted the dumb
version — one screen, black circles, comic page. it turns out the dumb version is
the one that actually looks like the thing.

---

## silhouette

### what it does

- **auto-cutout** — a matting model runs _in your browser_ and takes the first
  guess. no server, no upload.
- **refine by hand** — an add/erase brush paints the selection mask directly. the
  unselected region shows as a gray overlay; painting reveals or re-hides it.
- **transform** — flip horizontal / vertical, rotate in 90° steps, crop to a
  region. the image, the selection mask, and the whole undo history all move
  together, so your cutout never drifts off the picture.
- **zoom + pan** — scroll (or pinch) to zoom toward the cursor, space- or
  middle-drag to pan. on touch, one finger paints and two navigate. paint at any
  zoom; edits stay crisp because they happen in image space, not screen space.
- **undo / redo** — snapshot per stroke; the auto-seed is the floor you can't undo
  past.
- **export**, three flavors:
  - **PNG** — transparent cutout.
  - **SVG** — the same cutout embedded as a raster inside an SVG wrapper. keeps the
    picture; it's _not_ vectorized color.
  - **Silhouette** — the real vector. traces the _mask_ (not the colors) into a
    flat shape, with fill / border / thickness controls and a live preview.

### how it works (the load-bearing bits)

one selection **mask** and three offscreen canvases — image, mask, overlay — all
at the image's native resolution. the visible canvas is composited every frame
under a zoom/pan transform. painting happens in _image_ coordinates, so strokes
don't smear when you're zoomed in, and devicePixelRatio is folded into the render
transform so the brush lands where the cursor is on a retina screen.

flip/rotate/crop are exact pixel remaps (mirror, 90° quarter-turn, sub-rect
copy) — no resampling, so nothing softens. the trick is that the _same_ remap
runs over the image, the mask, and every undo snapshot in one pass, which is what
keeps the selection pinned to the picture across an edit. touch rides the same
pointer-event path as the mouse: one finger is a brush stroke, a second finger
switches to a two-finger pinch/pan and drops the stray dot the first one left.

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

---

## grainery

### what it does

- **upscale** — bicubic (Mitchell or Catmull-Rom) or nearest, done in linear light
  so the transitions don't go dirty. gamma-space blends of black and white land at
  ~22% grey instead of 50%; that's the muck you usually get.
- **deblock** — structure-tensor-guided smoothing that straightens the staircase
  the pixel grid drew, without melting the real edges. an edge-preservation knob
  trades how hard it holds the borders.
- **grain** — blue-noise film grain on the OKLab lightness channel: perceptually
  even, hue-stable, peaks in the mids and fades out of the blacks and blown
  highlights. amount / size / octaves / shadow rolloff / a little chroma, plus
  additive, soft-light, and multiply blends. presets from `35mm` to `Newsprint`.
- **finish** — small-radius micro-contrast, a thresholded highlight bloom for
  halation, and a desaturate.
- **transform** — flip, rotate 90°, and crop with draggable edge/corner handles
  (grab a side and extend it, or draw a fresh box).
- **compare** — split the before/after with a draggable divider, or hold `Space`
  for the raw original. toggle the divider off entirely when you just want the
  result.
- **export** — PNG, or JPEG with a quality slider. grain is the first thing a JPEG
  quantizer throws away, so it warns you and nudges you toward PNG.

### how it works (the load-bearing bits)

the whole pipeline is one WebGL2 fragment-shader graph — source → upscale →
deblock → grain → finish → present — ping-ponging between framebuffers. it runs at
the output resolution, so the preview _is_ the export: what you see is what you
save. everything happens in linear light and OKLab; sRGB shows up only at ingest
and the final present, where an 8-bit TPDF dither kills gradient banding. the
expensive passes (upscale, deblock) only re-run when their inputs change, so
dragging a grain slider skips straight to the cheap end of the graph.

the grain is void-and-cluster blue noise, generated once and fully deterministic
(seeded LCG, no `Math.random`). it rides the OKLab **L** channel with a
luma-response curve — `pow(4L(1-L), γ)` — so it's strong in the mids and gone in
the shadows. grain on raw RGB makes chroma noise and hammers the shadows harder
than it looks; riding perceptual lightness fixes both.

the deblock is the part i'm quietly proud of. bicubic on a blocky source gives you
_soft_ blocks — the steps are still there, just ramped. so per pixel it builds a
structure tensor, eigen-decomposes the 2×2, and runs an elliptical bilateral
kernel long _along_ the edge direction and short _across_ it. that reconstructs
the line the staircase was trying to approximate, instead of trading blockiness
for mush. a bilateral range weight stops it bleeding over high-contrast borders.

no model, no library — grainery is hand-written GLSL and adds **zero** runtime
dependencies. it needs WebGL2 and 16-bit-float render targets (`RGBA16F`); missing
the float extension, it drops to 8-bit and says so. every interaction is a pointer
event with `touch-action: none`, so the split-drag and the crop handles work the
same under a finger as a mouse.

## halftone

### what it does

drop an image, get it back as a grid of black circles on white — the way a comic
page is actually printed. every dot sits on a fixed lattice and only its *radius*
moves: dark patch, fat dot; bright patch, small dot or none. dots are allowed to
overrun their own cell, which is what turns shadows into solid ink masses instead
of a polite grey.

- **dots** — spacing, max size (as a fraction of spacing), min size, response curve
- **image** — brightness, contrast, gamma, blur, all applied to luminance before
  anything is sampled
- **stylise** — a soft threshold that ramps instead of cutting, so you can slide
  from "photographic halftone" to "posterised comic silhouette" without falling off
  a cliff. plus invert, for the white-on-black variant
- **grid** — sub-pixel offsets, for when the lattice lands badly on a face
- three presets (clean · comic · heavy ink), PNG export at up to 4×

### how it works (the load-bearing bits)

luminance is Rec. 709, not an RGB average — green carries most of the perceived
brightness and averaging throws that away. transparent pixels composite onto white
first, so a cutout from the silhouette tool doesn't come back as a field of fat
dots where there is nothing at all.

the work splits in two, and that split is why the sliders feel instant. the tonal
pass (brightness → contrast → gamma → blur → threshold) walks every pixel; the draw
pass only visits grid cells. dot sliders skip straight to drawing — only the image
sliders pay for a re-blur.

`average` sampling reads the whole cell rather than the one pixel under the centre,
because a centre sample aliases viciously against any texture whose period lands
near the spacing. doing that honestly is O(spacing²) per dot, so there's a
summed-area table over the luminance buffer and a cell average costs four lookups.
float64, not float32: a 1400×1050 field sums to ~1.5e6, where float32 resolves
steps of ~0.1, and a cell average is exactly the difference of two such corners.
that error would land as visible banding in the dot sizes.

everything is measured in *working pixels*, with the rasterisation scale as a
separate knob. so the pattern is resolution-independent — a 4× export is the same
halftone drawn finer, same dots and same count, just more pixels per circle. the
preview isn't screenshotted, it's re-rendered.

zooming in gets *cheaper*: the draw pass culls to the visible grid range, so at 24×
you're rasterising a few dozen circles.

no model, no library, no WebGL. canvas 2D and a great many `arc()` calls.

## stack

- **Vite + vanilla TypeScript** — no framework. a hash-routed hub lazy-loads each
  tool as its own chunk, so grainery's 40-odd kB, halftone's 14 and silhouette's
  model only load when you open them.
- **plain CSS** — hand-written, amber-phosphor-CRT theme. no tailwind.
- **@huggingface/transformers** — RMBG-1.4 matting (silhouette).
- **esm-potrace-wasm** — raster → vector for the silhouette trace.

two runtime dependencies, both silhouette's. grainery is pure WebGL2, halftone is
pure canvas 2D, and neither pulls in anything. kept lean on purpose.

## run it

```sh
npm install
npm run dev      # → localhost:5173
npm run build    # → dist/
```

## cutout from the command line

silhouette has a headless twin — same model, no browser. point it at an image,
get a transparent PNG:

```sh
npm run cutout -- photo.jpg              # → photo-cutout.png, next to it
npm run cutout -- photo.jpg -o out.png   # pick the output path
npm run cutout -- a.jpg b.jpg c.jpg      # batch; each → *-cutout.png
```

it reuses the exact same RMBG-1.4 model the app does — just running on CPU via
onnxruntime-node, with sharp for image i/o. both already ship with
transformers.js, so there are no extra dependencies. the output path prints to
stdout and progress to stderr, so it pipes cleanly. first run pulls the weights
(~44MB, cached after) into node's own cache, separate from the browser's.

## keys

**silhouette**

| key                     | does                        |
| ----------------------- | --------------------------- |
| `B` / `E`               | add / erase brush           |
| `[` / `]`               | brush size                  |
| `H` / `V`               | flip horizontal / vertical  |
| `R` / `Shift+R`         | rotate right / left         |
| `C`                     | crop (`Enter` apply, `Esc` cancel) |
| scroll                  | zoom toward cursor          |
| space- or middle-drag   | pan                         |
| `Ctrl`/`Cmd` `+Z`       | undo                        |
| `Ctrl`/`Cmd` `+Shift+Z` | redo                        |

on touch: one finger paints, two fingers pinch-zoom and pan.

**grainery** — hold `Space` for the original; in crop, `Enter` applies and `Esc`
cancels. everything else is a slider or a button.

**halftone** — hold `Space` for the source; scroll to zoom, drag to pan,
double-click back to fit.

## honest caveats

- silhouette's first cutout waits on a one-time model download (cached after).
  ~1–2s on WebGPU, closer to ~15s on WASM — but it's in a worker, so the page
  stays alive and animated while it churns.
- the auto-seed is good, not psychic. stylized art or unusual subjects need more
  brushing. that's what the brush is for.
- rotate is 90° steps only — no free angle yet (that one needs mask resampling).
- silhouette's transforms aren't in the undo stack: flip or rotate back to
  reverse, crop commits. your _brush_ history survives them intact, though —
  every snapshot gets remapped alongside the image.
- grainery sizes its deblock off the upscale factor, so an image that's _already_
  been upscaled at a low factor gets under-smoothed (there's no block-period
  detector yet). crank the scale or the deblock amount and it catches up.
- JPEG export eats grain — that's the whole reason for the warning. prefer PNG
  unless you need the smaller file, and keep quality ≥ 90.
- halftone samples at ≤1400px on the long edge. deliberate — past that, extra
  source pixels stop moving a cell average by anything a dot radius can express —
  but it does mean the detail ceiling is set there, 4× export or not.
- halftone's contrast is the classic 259/255 factor, which is savagely non-linear
  at the top: past ~0.8 it's effectively a hard threshold. a feature for comics, a
  nuisance for photos.
- halftone has no SVG export yet, which is the obvious thing to want from a
  renderer whose entire output is circles. it's on the list.

## layout

```
src/
  main.ts         hash-routed hub; lazy-mounts each tool as its own chunk
  ui/             landing hub, toolbar, panel controls, dropzone (drop / browse / paste)
  tools/
    silhouette/   the cutout tool (see engine/, export/ below)
    grainery/     the de-pixelate + grain tool
      gl/         WebGL2 context, shaders, the ping-pong render graph
      core/       blue-noise generator, params/presets, canvas transforms
    halftone/     the comic dot renderer
      core/       luminance + integral image, tonal preprocess, grid renderer
  engine/         silhouette: canvas + compositing, viewport, brush, crop, undo
  export/         silhouette: png · svg · download
  segmentation.ts + .worker.ts   RMBG-1.4, off the main thread
  trace.ts        potrace wrapper
scripts/
  cutout.js       headless "image → transparent PNG" CLI (same model, on CPU)
```

---

Inspired by the tool from Shuffles by Pinterest
