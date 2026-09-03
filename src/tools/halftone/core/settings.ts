/**
 * Halftone settings, defaults and presets.
 *
 * Every length here is in *working pixels* — the resolution the luminance buffer
 * is built at. Rasterisation scale is a separate, non-preset knob (fit-to-screen
 * for the preview, a multiplier for export), so one settings object describes the
 * same dot pattern whether it lands on a 900px preview or a 5600px export. That
 * separation is the whole trick to preview/export parity: the pattern is
 * resolution-independent, only its rendering isn't.
 */

export type SamplingMode = "center" | "average";

export interface HalftoneSettings {
  // Grid — dot centres.
  spacing: number; // distance between centres
  offsetX: number; // shifts the whole lattice; the grid never bends to content
  offsetY: number;

  // Dots.
  maxRadiusRatio: number; // × spacing. >0.5 lets neighbours merge into ink masses
  minRadius: number; // below this a dot is dropped rather than drawn as a speck
  dotGamma: number; // response curve on darkness; <1 fattens midtones

  // Sampling.
  samplingMode: SamplingMode;

  // Preprocessing — applied to luminance, before any sampling happens.
  brightness: number; // -1..1, added
  contrast: number; // -1..1
  imageGamma: number; // independent of dotGamma
  blurRadius: number; // gaussian sigma

  // Stylisation.
  thresholdEnabled: boolean;
  threshold: number; // 0..1
  thresholdSoftness: number; // 0..0.5; 0 is a hard posterise

  // Rendering.
  invert: boolean; // bright areas get the big dots instead
  antialias: boolean; // false → hard-threshold the raster afterwards
}

export const DEFAULT_SETTINGS: HalftoneSettings = {
  spacing: 10,
  offsetX: 0,
  offsetY: 0,

  maxRadiusRatio: 0.62,
  minRadius: 0.3,
  dotGamma: 1,

  samplingMode: "average",

  brightness: 0,
  contrast: 0.15,
  imageGamma: 1,
  blurRadius: 1,

  thresholdEnabled: false,
  threshold: 0.5,
  thresholdSoftness: 0.2,

  invert: false,
  antialias: true,
};

export type PresetName = "Clean" | "Comic" | "Heavy ink";

/**
 * Presets are merged over DEFAULT_SETTINGS, not over whatever was there before —
 * so picking one twice in a row, or hopping between two, always lands on the same
 * image. Only the keys a preset actually names are compared when highlighting it.
 */
export const PRESETS: Record<PresetName, Partial<HalftoneSettings>> = {
  // Separated dots, faithful tone. The photographic end of the range.
  Clean: {
    spacing: 8,
    maxRadiusRatio: 0.5,
    dotGamma: 1,
    contrast: 0.1,
    blurRadius: 0.5,
    thresholdEnabled: false,
  },
  // The reference look: dots merge in the shadows, threshold pushes the midtones
  // apart so the result reads as ink rather than as a photograph of ink.
  Comic: {
    spacing: 10,
    maxRadiusRatio: 0.62,
    dotGamma: 0.85,
    contrast: 0.3,
    blurRadius: 1,
    thresholdEnabled: true,
    threshold: 0.55,
    thresholdSoftness: 0.25,
  },
  // Coarse and overprinted — dark regions go almost solid.
  "Heavy ink": {
    spacing: 12,
    maxRadiusRatio: 0.75,
    dotGamma: 0.7,
    contrast: 0.4,
    blurRadius: 1.5,
    thresholdEnabled: true,
    threshold: 0.6,
    thresholdSoftness: 0.15,
  },
};

/**
 * Settings whose change invalidates the preprocessed luminance field (and its
 * summed-area table). Everything else only affects the draw pass, which is the
 * cheap one — so dragging the dot sliders never re-blurs the image.
 */
export const PREPROCESS_KEYS: ReadonlySet<string> = new Set([
  "brightness",
  "contrast",
  "imageGamma",
  "blurRadius",
  "thresholdEnabled",
  "threshold",
  "thresholdSoftness",
]);
