import { createContext, program, createTarget, type Caps, type Target } from "./context";
import { VERT, UPSCALE, DEBLOCK, GRAIN, FINISH, PRESENT } from "./shaders";
import { generateBlueNoise } from "../core/noise";
import type { Params, Kernel } from "../core/params";

/**
 * The ping-pong render graph: source → upscale → deblock → grain → finish →
 * present.
 *
 * Processing runs at the chosen output resolution (source × scale, capped), so
 * preview and export are the same graph — what you see is what you export. The
 * present pass down-fits the result to the canvas and handles the split compare,
 * which means dragging the divider only re-runs present, never the pipeline.
 */

const MAX_LONG_EDGE = 4096;
const KERNEL_ID: Record<Kernel, number> = { nearest: 0, mitchell: 1, catmull: 2 };

export class Grapher {
  private caps: Caps;
  private gl: WebGL2RenderingContext;
  private progUpscale: WebGLProgram;
  private progDeblock: WebGLProgram;
  private progGrain: WebGLProgram;
  private progFinish: WebGLProgram;
  private progPresent: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private uniforms = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  private srcTex: WebGLTexture | null = null;
  private srcW = 0;
  private srcH = 0;
  private noiseTex: WebGLTexture;
  private noiseSize: number;

  private a: Target | null = null; // upscale out
  private b: Target | null = null; // deblock out
  private c: Target | null = null; // grain out
  private d: Target | null = null; // finish out (linear)
  private lastKernel = -1;
  private lastDeblockSig = "";

  constructor(canvas: HTMLCanvasElement) {
    this.caps = createContext(canvas);
    this.gl = this.caps.gl;
    this.progUpscale = program(this.gl, VERT, UPSCALE);
    this.progDeblock = program(this.gl, VERT, DEBLOCK);
    this.progGrain = program(this.gl, VERT, GRAIN);
    this.progFinish = program(this.gl, VERT, FINISH);
    this.progPresent = program(this.gl, VERT, PRESENT);
    this.vao = this.gl.createVertexArray()!; // empty VAO — positions come from gl_VertexID

    const noise = generateBlueNoise(64);
    this.noiseSize = noise.size;
    this.noiseTex = this.uploadNoise(noise.data, noise.size);
  }

  get capabilityNote(): string {
    return this.caps.halfFloat ? "" : "16-bit float unavailable — using 8-bit, gradients may band.";
  }

  private uploadNoise(data: Uint8Array, size: number): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  setSource(bitmap: ImageBitmap): void {
    const gl = this.gl;
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // Upload straight: the ImageBitmap's first row (image top) becomes texel
    // v=0. (UNPACK_FLIP_Y_WEBGL is silently ignored for an orientation-processed
    // ImageBitmap in Chromium, so we don't rely on it — present() flips v
    // instead, which also keeps the export readback correct.)
    // RGBA8 keeps the alpha channel; callers decode with premultiplyAlpha
    // "premultiply" so the texture's premultiplication state is known rather than
    // UA-dependent — UNPACK_PREMULTIPLY_ALPHA_WEBGL is ignored for ImageBitmap
    // sources, so asking at decode time is the only way to be sure.
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    // NEAREST: upscale taps land on texel centres, and the "before" view wants the
    // honest blocky source.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.srcTex = tex;
    this.srcW = bitmap.width;
    this.srcH = bitmap.height;
    this.lastKernel = -1; // force an upscale rebuild
  }

  hasSource(): boolean {
    return this.srcTex !== null;
  }

  sourceSize(): { w: number; h: number } {
    return { w: this.srcW, h: this.srcH };
  }

  /** Output resolution for a scale factor, capped to the long-edge budget. */
  processSize(scale: number): { w: number; h: number } {
    const cap = Math.min(this.caps.maxTexture, MAX_LONG_EDGE);
    const long = Math.max(this.srcW, this.srcH);
    const eff = Math.min(scale, cap / long);
    return { w: Math.max(1, Math.round(this.srcW * eff)), h: Math.max(1, Math.round(this.srcH * eff)) };
  }

  private u(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    let byName = this.uniforms.get(prog);
    if (!byName) {
      byName = new Map();
      this.uniforms.set(prog, byName);
    }
    if (!byName.has(name)) byName.set(name, this.gl.getUniformLocation(prog, name));
    return byName.get(name)!;
  }

  private ensureTargets(w: number, h: number): boolean {
    if (this.a && this.a.w === w && this.a.h === h) return false;
    const gl = this.gl;
    for (const t of [this.a, this.b, this.c, this.d]) {
      if (t) {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      }
    }
    this.a = createTarget(this.caps, w, h);
    this.b = createTarget(this.caps, w, h);
    this.c = createTarget(this.caps, w, h);
    this.d = createTarget(this.caps, w, h);
    return true;
  }

  private draw(target: Target | null, w: number, h: number): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.viewport(0, 0, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u(prog, name), unit);
  }

  /**
   * Run the pipeline. Upscale and deblock only re-run when their inputs change
   * (geometry/kernel, or the deblock params) — they're the expensive passes, so
   * a grain or finish tweak skips straight to grain. Grain and finish are cheap
   * and always re-run.
   */
  render(p: Params): void {
    if (!this.srcTex) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.disable(gl.BLEND);

    const { w, h } = this.processSize(p.scale);
    const resized = this.ensureTargets(w, h);
    const kernelId = KERNEL_ID[p.kernel];
    const upscaleRan = resized || kernelId !== this.lastKernel;

    if (upscaleRan) {
      gl.useProgram(this.progUpscale);
      this.bindTex(this.progUpscale, "u_src", this.srcTex, 0);
      gl.uniform2f(this.u(this.progUpscale, "u_srcSize"), this.srcW, this.srcH);
      gl.uniform1i(this.u(this.progUpscale, "u_kernel"), kernelId);
      this.draw(this.a!, w, h);
      this.lastKernel = kernelId;
    }

    // Deblock. Block size ≈ output pixels per source pixel (staircase step).
    const deblockSig = `${w}x${h}|${p.deblock}|${p.edgePreserve}`;
    if (upscaleRan || deblockSig !== this.lastDeblockSig) {
      gl.useProgram(this.progDeblock);
      this.bindTex(this.progDeblock, "u_tex", this.a!.tex, 0);
      gl.uniform2f(this.u(this.progDeblock, "u_size"), w, h);
      gl.uniform1f(this.u(this.progDeblock, "u_amount"), p.deblock / 100);
      gl.uniform1f(this.u(this.progDeblock, "u_preserve"), p.edgePreserve / 100);
      gl.uniform1f(this.u(this.progDeblock, "u_block"), Math.max(1, w / this.srcW));
      this.draw(this.b!, w, h);
      this.lastDeblockSig = deblockSig;
    }

    // Grain.
    gl.useProgram(this.progGrain);
    this.bindTex(this.progGrain, "u_tex", this.b!.tex, 0);
    this.bindTex(this.progGrain, "u_noise", this.noiseTex, 1);
    gl.uniform1f(this.u(this.progGrain, "u_noiseSize"), this.noiseSize);
    gl.uniform1f(this.u(this.progGrain, "u_amount"), p.grainAmount / 100);
    gl.uniform1f(this.u(this.progGrain, "u_grainRadius"), Math.max(0.5, p.grainSize));
    gl.uniform1i(this.u(this.progGrain, "u_octaves"), p.octaves);
    gl.uniform1f(this.u(this.progGrain, "u_rolloff"), p.shadowRolloff);
    gl.uniform1f(this.u(this.progGrain, "u_chroma"), p.chroma / 30);
    gl.uniform1i(this.u(this.progGrain, "u_blend"), p.blend === "additive" ? 0 : p.blend === "softlight" ? 1 : 2);
    gl.uniform1f(this.u(this.progGrain, "u_desaturate"), p.desaturate / 100);
    this.draw(this.c!, w, h);

    // Finish.
    gl.useProgram(this.progFinish);
    this.bindTex(this.progFinish, "u_tex", this.c!.tex, 0);
    gl.uniform2f(this.u(this.progFinish, "u_size"), w, h);
    gl.uniform1f(this.u(this.progFinish, "u_sharpen"), p.sharpen / 100);
    gl.uniform1f(this.u(this.progFinish, "u_halation"), p.halation / 100);
    this.draw(this.d!, w, h);
  }

  /** Aspect-fit factors (image size / canvas size) for a canvas — one axis is 1. */
  fitFactors(canvasW: number, canvasH: number): { x: number; y: number } {
    if (!this.d) return { x: 1, y: 1 };
    const s = Math.min(canvasW / this.d.w, canvasH / this.d.h);
    return { x: (this.d.w * s) / canvasW, y: (this.d.h * s) / canvasH };
  }

  /**
   * Composite the finished result to the canvas, with the split compare + view.
   * `checker` is the transparency checkerboard's cell size in device pixels —
   * the image is composited over it, so anything the source left transparent
   * reads as transparent instead of as whatever colour sat under alpha=0.
   */
  present(
    canvasW: number,
    canvasH: number,
    split: number,
    showSplit: boolean,
    zoom = 1,
    panX = 0,
    panY = 0,
    checker = 10,
  ): void {
    if (!this.d || !this.srcTex) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.progPresent);

    const fit = this.fitFactors(canvasW, canvasH);

    this.bindTex(this.progPresent, "u_result", this.d.tex, 0);
    this.bindTex(this.progPresent, "u_src", this.srcTex, 1);
    gl.uniform2f(this.u(this.progPresent, "u_fit"), fit.x, fit.y);
    gl.uniform1f(this.u(this.progPresent, "u_zoom"), zoom);
    gl.uniform2f(this.u(this.progPresent, "u_pan"), panX, panY);
    gl.uniform1f(this.u(this.progPresent, "u_split"), split);
    gl.uniform1f(this.u(this.progPresent, "u_showSplit"), showSplit ? 1 : 0);
    gl.uniform2f(this.u(this.progPresent, "u_seed"), 17, 31);
    gl.uniform1f(this.u(this.progPresent, "u_checker"), Math.max(1, checker));
    this.draw(null, canvasW, canvasH);
  }

  /**
   * Read the finished full-resolution result back as straight (non-premultiplied)
   * sRGB + alpha, top-down — exactly what ImageData expects.
   */
  readResult(): { data: Uint8ClampedArray; w: number; h: number } {
    if (!this.d) throw new Error("nothing to export");
    const gl = this.gl;
    const w = this.d.w;
    const h = this.d.h;
    // Resolve the linear result to an 8-bit sRGB target at full size, no split.
    const out = createTarget(this.caps, w, h, true);
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.progPresent);
    this.bindTex(this.progPresent, "u_result", this.d.tex, 0);
    this.bindTex(this.progPresent, "u_src", this.srcTex!, 1);
    gl.uniform2f(this.u(this.progPresent, "u_fit"), 1, 1);
    gl.uniform1f(this.u(this.progPresent, "u_zoom"), 1); // export is always full-frame
    gl.uniform2f(this.u(this.progPresent, "u_pan"), 0, 0);
    gl.uniform1f(this.u(this.progPresent, "u_split"), 0);
    gl.uniform1f(this.u(this.progPresent, "u_showSplit"), 0);
    gl.uniform2f(this.u(this.progPresent, "u_seed"), 17, 31);
    gl.uniform1f(this.u(this.progPresent, "u_checker"), 0); // export: no checkerboard, keep real alpha
    this.draw(out, w, h);

    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    gl.deleteTexture(out.tex);
    gl.deleteFramebuffer(out.fbo);

    // Flip rows: GL origin is bottom-left, ImageData wants top-left.
    const flipped = new Uint8ClampedArray(w * h * 4);
    const stride = w * 4;
    for (let y = 0; y < h; y++) {
      flipped.set(buf.subarray(y * stride, y * stride + stride), (h - 1 - y) * stride);
    }
    return { data: flipped, w, h };
  }
}
