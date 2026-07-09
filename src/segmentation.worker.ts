import { AutoModel, AutoProcessor, RawImage } from "@huggingface/transformers";
import type { PreTrainedModel, Processor } from "@huggingface/transformers";

/**
 * Segmentation worker: RMBG-1.4 model load + inference off the main thread, so
 * the ~16s WASM seed never freezes the UI. The main thread (segmentation.ts)
 * posts raw RGBA pixels in and gets a foreground-alpha buffer back; progress and
 * errors come back as messages. See segmentation.ts for the why behind the
 * AutoModel/`model_type: "custom"` load and the device selection.
 */

type Incoming =
  | { type: "prewarm" }
  | { type: "segment"; id: number; data: Uint8ClampedArray; width: number; height: number };

interface WorkerCtx {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<Incoming>) => void) | null;
}
const ctx = self as unknown as WorkerCtx;

const MODEL = "briaai/RMBG-1.4";

function reportLoading(pct: number): void {
  ctx.postMessage({ type: "progress", progress: { stage: "loading", pct } });
}

/**
 * Prefer WebGPU when a real adapter exists. Pick fp16 only if the adapter
 * advertises `shader-f16` — some adapters (ANGLE GL compatibility mode) expose
 * WebGPU without it, and would fail an fp16 graph — otherwise fp32.
 */
async function pickBackend(): Promise<{ device: "webgpu" | "wasm"; dtype: "fp16" | "fp32" | "q8" }> {
  try {
    const gpu = (self.navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapterLike | null> } })
      .gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        const f16 = adapter.features?.has?.("shader-f16") ?? false;
        return { device: "webgpu", dtype: f16 ? "fp16" : "fp32" };
      }
    }
  } catch {
    /* no usable adapter — fall through to WASM */
  }
  return { device: "wasm", dtype: "q8" };
}

interface GpuAdapterLike {
  features?: { has?: (name: string) => boolean };
}

function loadModel(device: "webgpu" | "wasm", dtype: "fp16" | "fp32" | "q8"): Promise<PreTrainedModel> {
  return AutoModel.from_pretrained(MODEL, {
    config: { model_type: "custom" } as never,
    device,
    dtype,
    progress_callback: (e) => {
      if (e.status === "progress") reportLoading(Math.round(e.progress));
    },
  });
}

async function loadModelWithFallback(): Promise<PreTrainedModel> {
  const backend = await pickBackend();
  if (backend.device === "webgpu") {
    try {
      return await loadModel("webgpu", backend.dtype);
    } catch (err) {
      // GPU present but the graph failed to load/run — WASM still works.
      console.warn("WebGPU segmentation load failed; falling back to WASM.", err);
    }
  }
  return loadModel("wasm", "q8");
}

let ready: Promise<[PreTrainedModel, Processor]> | null = null;

function init(): Promise<[PreTrainedModel, Processor]> {
  if (!ready) {
    const processor = AutoProcessor.from_pretrained(MODEL, {
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
      } as never,
    });
    ready = Promise.all([loadModelWithFallback(), processor]);
  }
  return ready;
}

ctx.onmessage = async (e: MessageEvent<Incoming>) => {
  const msg = e.data;
  if (msg.type === "prewarm") {
    void init().catch(() => {
      /* surfaced when a segment request is made */
    });
    return;
  }

  const { id, data, width, height } = msg;
  try {
    const [model, processor] = await init();
    ctx.postMessage({ type: "progress", progress: { stage: "running", pct: null } });

    const image = new RawImage(data, width, height, 4);
    const { pixel_values } = await processor(image);
    const result = await model({ input: pixel_values });
    const tensor = (result.output ?? Object.values(result)[0]) as (typeof result)[string];
    const mask = await RawImage.fromTensor(tensor[0].mul(255).to("uint8")).resize(width, height);

    const alpha = new Uint8ClampedArray(mask.data.length);
    alpha.set(mask.data);
    ctx.postMessage({ type: "result", id, width: mask.width, height: mask.height, alpha }, [
      alpha.buffer,
    ]);
  } catch (err) {
    ctx.postMessage({ type: "error", id, message: String(err) });
  }
};
