/**
 * Auto-segmentation, behind a backend-agnostic interface (§4.1).
 *
 * A backend takes an image source and returns a per-pixel FOREGROUND alpha
 * (0 = background, 255 = fully selected). The interface returns alpha (not
 * category indices) precisely so a matting model can slot in — which is what
 * this is: RMBG-1.4 (a BRIA/ISNet background remover) via transformers.js. Its
 * soft matte gives far cleaner edges than the old DeepLab semantic-segmentation
 * seed.
 *
 * The heavy lifting (model load + inference) runs in a Web Worker
 * (segmentation.worker.ts) so a ~16s WASM seed never freezes the UI. This module
 * is just the main-thread client: it hands the worker raw pixels and relays the
 * alpha result + progress back.
 */

import SegmentationWorker from "./segmentation.worker.ts?worker";

export interface SegmentationResult {
  width: number;
  height: number;
  alpha: Uint8ClampedArray; // length width*height
}

export interface Segmenter {
  segment(source: ImageBitmap | HTMLCanvasElement | HTMLImageElement): Promise<SegmentationResult>;
}

export interface SegProgress {
  stage: "loading" | "running";
  pct: number | null; // download percentage while loading; null once running
}

type WorkerMessage =
  | { type: "progress"; progress: SegProgress }
  | { type: "result"; id: number; width: number; height: number; alpha: Uint8ClampedArray }
  | { type: "error"; id: number; message: string };

let onProgress: ((p: SegProgress) => void) | null = null;

export function setSegmentationProgress(cb: (p: SegProgress) => void): void {
  onProgress = cb;
}

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, (r: SegmentationResult | null, err?: string) => void>();

function getWorker(): Worker {
  if (!worker) {
    worker = new SegmentationWorker();
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "progress") {
        onProgress?.(m.progress);
      } else if (m.type === "result") {
        pending.get(m.id)?.({ width: m.width, height: m.height, alpha: m.alpha });
        pending.delete(m.id);
      } else if (m.type === "error") {
        pending.get(m.id)?.(null, m.message);
        pending.delete(m.id);
      }
    };
  }
  return worker;
}

/** Start downloading + initializing the model in the background worker. */
export function prewarm(): void {
  getWorker().postMessage({ type: "prewarm" });
}

export const segmenter: Segmenter = {
  segment(source) {
    const width = source.width;
    const height = source.height;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, width, height);

    const id = ++nextId;
    return new Promise<SegmentationResult>((resolve, reject) => {
      pending.set(id, (r, err) => (r ? resolve(r) : reject(new Error(err))));
      // Transfer the pixel buffer to avoid a copy.
      getWorker().postMessage({ type: "segment", id, data, width, height }, [data.buffer]);
    });
  },
};
