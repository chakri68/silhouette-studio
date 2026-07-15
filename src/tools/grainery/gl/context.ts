/**
 * WebGL2 context creation, capability probing, and program/texture helpers.
 *
 * The whole pipeline runs in linear light, so intermediate targets want more than
 * 8 bits. We prefer RGBA16F (via EXT_color_buffer_half_float); if it's absent we
 * fall back to RGBA8 — the math is unchanged, gradients just band a little more,
 * and the finish-stage dither hides most of it.
 */

export interface Caps {
  gl: WebGL2RenderingContext;
  halfFloat: boolean; // RGBA16F render targets available
  maxTexture: number;
}

export function createContext(canvas: HTMLCanvasElement): Caps {
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true, // export path reads the drawing buffer back
    antialias: false,
  });
  if (!gl) throw new Error("WebGL2 is not available in this browser.");

  const halfFloat = !!gl.getExtension("EXT_color_buffer_half_float");
  gl.getExtension("OES_texture_float_linear"); // linear filtering of float textures

  return { gl, halfFloat, maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number };
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile failed: ${log}`);
  }
  return sh;
}

export function program(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const p = gl.createProgram()!;
  const vs = compile(gl, gl.VERTEX_SHADER, vert);
  const fs = compile(gl, gl.FRAGMENT_SHADER, frag);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`program link failed: ${log}`);
  }
  return p;
}

/** A color texture + its framebuffer, at a given size and internal format. */
export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export function createTarget(caps: Caps, w: number, h: number, forceRGBA8 = false): Target {
  const { gl, halfFloat } = caps;
  const float = halfFloat && !forceRGBA8;
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const internal = float ? gl.RGBA16F : gl.RGBA8;
  const type = float ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}
