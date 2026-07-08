import { ImageSegmenter, FilesetResolver } from "@mediapipe/tasks-vision";

/**
 * Auto-segmentation, behind a backend-agnostic interface (§4.1).
 *
 * A backend takes an image source and returns a per-pixel FOREGROUND alpha
 * (0 = background, 255 = fully selected). Returning alpha rather than category
 * indices keeps the contract neutral: DeepLab produces a hard 0/255, but a
 * matte model (e.g. BiRefNet via transformers.js) can return soft edges through
 * the same shape without touching the seeding code or UI.
 */

export interface SegmentationResult {
  width: number;
  height: number;
  alpha: Uint8ClampedArray; // length width*height
}

export interface Segmenter {
  segment(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): Promise<SegmentationResult>;
}

const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite";
const BACKGROUND = 0; // DeepLab v3 / Pascal-VOC background category index

let initPromise: Promise<ImageSegmenter> | null = null;

function init(): Promise<ImageSegmenter> {
  if (!initPromise) {
    initPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_URL);
      return ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "IMAGE",
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      });
    })();
  }
  return initPromise;
}

/** Kick off WASM + model download in the background so the first seed is fast. */
export function prewarm(): void {
  void init().catch(() => {
    /* surfaced when segment() is actually awaited */
  });
}

export const mediapipeSegmenter: Segmenter = {
  async segment(source) {
    const segmenter = await init();
    const result = segmenter.segment(source);
    const mask = result.categoryMask;
    if (!mask) {
      result.close();
      throw new Error("segmentation returned no category mask");
    }
    const width = mask.width;
    const height = mask.height;
    const cat = mask.getAsUint8Array();
    const alpha = new Uint8ClampedArray(width * height);
    for (let i = 0; i < alpha.length; i++) {
      alpha[i] = cat[i] === BACKGROUND ? 0 : 255;
    }
    result.close();
    return { width, height, alpha };
  },
};
