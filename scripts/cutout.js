#!/usr/bin/env node
// Headless cutout: run the same model the app uses (RMBG-1.4) over an image on
// disk and write a transparent PNG cutout. No browser, no server — transformers.js
// does inference through onnxruntime-node (CPU) and image I/O through sharp, both
// already pulled in by @huggingface/transformers.
//
//   node scripts/cutout.js <image> [more images...]
//   node scripts/cutout.js <image> -o <output.png>
//   npm run cutout -- <image>

import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const MODEL = "briaai/RMBG-1.4";

const HELP = `silhouette_studio — cutout CLI

Auto-remove an image's background with the same model the app uses (RMBG-1.4)
and write a transparent PNG cutout.

Usage:
  node scripts/cutout.js <image> [more images...]
  node scripts/cutout.js <image> -o <output.png>
  npm run cutout -- <image>

Options:
  -o, --out <path>   Output path (single input only).
                     Default: <image-dir>/<name>-cutout.png
  -h, --help         Show this help.
`;

function parseArgs(argv) {
  const inputs = [];
  let out = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-o" || a === "--out") out = argv[++i];
    else if (a === "-h" || a === "--help") help = true;
    else inputs.push(a);
  }
  return { inputs, out, help };
}

function die(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

const { inputs, out, help } = parseArgs(process.argv.slice(2));

if (help || inputs.length === 0) {
  process.stdout.write(HELP);
  process.exit(help ? 0 : 1);
}
if (out && inputs.length > 1) die("-o/--out only works with a single input image.");
for (const p of inputs) if (!existsSync(p)) die(`no such file: ${p}`);

// ── Load the model once (downloads + caches on first run) ───────────────
process.stderr.write("Loading RMBG-1.4…\n");
let lastPct = -1;
const model = await AutoModel.from_pretrained(MODEL, {
  config: { model_type: "custom" },
  dtype: "q8", // same quantized weights the app's WASM path uses; ~44MB
  progress_callback: (e) => {
    if (e.status === "progress" && typeof e.progress === "number") {
      const pct = Math.floor(e.progress);
      if (pct !== lastPct) {
        lastPct = pct;
        process.stderr.write(`\r  downloading… ${pct}%   `);
      }
    } else if (e.status === "done" && lastPct >= 0) {
      process.stderr.write("\r  downloaded          \n");
      lastPct = -1;
    }
  },
});
const processor = await AutoProcessor.from_pretrained(MODEL, {
  config: {
    do_normalize: true,
    do_pad: false,
    do_rescale: true,
    do_resize: true,
    image_mean: [0.5, 0.5, 0.5],
    image_std: [1, 1, 1],
    feature_extractor_type: "ImageFeatureExtractor",
    processor_class: "ImageProcessor",
    resample: 2,
    rescale_factor: 1 / 255,
    size: { width: 1024, height: 1024 },
  },
});

// ── Cut out each image ──────────────────────────────────────────────────
for (const input of inputs) {
  const abs = resolve(input);
  process.stderr.write(`Segmenting ${basename(abs)}…\n`);

  const image = await RawImage.read(abs);
  const { pixel_values } = await processor(image);
  const result = await model({ input: pixel_values });
  const tensor = result.output ?? Object.values(result)[0];
  // Single-channel matte in [0,1] → 0..255, resized back to the source dims.
  const mask = await RawImage.fromTensor(tensor[0].mul(255).to("uint8")).resize(
    image.width,
    image.height,
  );

  const cutout = image.clone();
  cutout.putAlpha(mask); // keep the picture, use the matte as its alpha channel

  const outPath = out ?? join(dirname(abs), `${basename(abs, extname(abs))}-cutout.png`);
  await cutout.save(outPath);
  console.log(outPath);
}
