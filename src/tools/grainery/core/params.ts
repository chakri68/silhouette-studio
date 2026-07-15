/**
 * Grainery parameters, defaults and presets.
 *
 * Pipeline: ingest → upscale → deblock → grain → finish. The one piece still
 * deferred is Stage 0's autocorrelation block-period detector, so the deblock
 * block size is derived from the upscale factor rather than measured.
 */

export type Kernel = "mitchell" | "catmull" | "nearest";
export type Blend = "additive" | "softlight" | "multiply";

export interface Params {
  scale: number; // output scale factor, 2..8
  kernel: Kernel; // upscale kernel
  deblock: number; // deblock strength, 0..100
  edgePreserve: number; // edge preservation, 0..100
  grainAmount: number; // 0..100
  grainSize: number; // device px, 0.5..4
  octaves: 1 | 2; // grain octaves
  shadowRolloff: number; // luma-response gamma, 0.4..3
  chroma: number; // chroma grain, 0..30
  blend: Blend;
  desaturate: number; // 0..100, for monochrome looks
  sharpen: number; // micro-contrast %, 0..100
  halation: number; // highlight bloom %, 0..100
}

export const DEFAULTS: Params = {
  scale: 4,
  kernel: "mitchell",
  deblock: 45,
  edgePreserve: 55,
  grainAmount: 34,
  grainSize: 1.4,
  octaves: 2,
  shadowRolloff: 1.0,
  chroma: 8,
  blend: "additive",
  desaturate: 0,
  sharpen: 15,
  halation: 8,
};

export type PresetName = "Rescue" | "35mm" | "Push" | "Newsprint" | "Soft" | "Pixel art";

export const PRESETS: Record<PresetName, Partial<Params>> = {
  // Conservative. Makes a bad image acceptable without announcing itself.
  Rescue: { ...DEFAULTS },
  // Full film treatment — visible grain, halation, warm micro-contrast.
  "35mm": {
    deblock: 42,
    edgePreserve: 58,
    grainAmount: 55,
    grainSize: 1.6,
    octaves: 2,
    shadowRolloff: 1.1,
    chroma: 10,
    blend: "softlight",
    sharpen: 22,
    halation: 16,
    desaturate: 0,
  },
  // Heavy, coarse grain. High-ISO, low-light, grimy.
  Push: {
    deblock: 55,
    edgePreserve: 42,
    grainAmount: 82,
    grainSize: 2.6,
    octaves: 2,
    shadowRolloff: 0.8,
    chroma: 14,
    blend: "additive",
    sharpen: 10,
    halation: 6,
    desaturate: 12,
  },
  // Coarse monochrome grain, crushed contrast, no chroma grain.
  Newsprint: {
    deblock: 58,
    edgePreserve: 50,
    grainAmount: 70,
    grainSize: 2.2,
    octaves: 1,
    shadowRolloff: 0.7,
    chroma: 0,
    blend: "multiply",
    sharpen: 30,
    halation: 0,
    desaturate: 100,
  },
  // Maximum softness, minimum grain. Pixelation is the enemy, texture unwanted.
  Soft: {
    kernel: "mitchell",
    deblock: 100,
    edgePreserve: 30,
    grainAmount: 6,
    grainSize: 1.2,
    octaves: 1,
    chroma: 2,
    blend: "additive",
    sharpen: 4,
    halation: 4,
    desaturate: 0,
  },
  // Honest escape hatch — some images should stay crunchy.
  "Pixel art": {
    kernel: "nearest",
    deblock: 0,
    edgePreserve: 100,
    grainAmount: 0,
    grainSize: 1.0,
    octaves: 1,
    chroma: 0,
    sharpen: 0,
    halation: 0,
    desaturate: 0,
  },
};
