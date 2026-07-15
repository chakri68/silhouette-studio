/**
 * GLSL ES 3.00 sources for the Grainery pipeline. Kept as TS strings so no glsl
 * build plugin is needed. Every fragment shader gets PRELUDE prepended (color
 * space conversions) — the whole chain works in linear light and OKLab, sRGB
 * only at ingest and the final present.
 */

// Full-screen triangle. No vertex buffer — positions come from gl_VertexID.
export const VERT = /* glsl */ `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  v_uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PRELUDE = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 o_col;

vec3 srgb2lin(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}
vec3 lin2srgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// linear sRGB <-> OKLab (Björn Ottosson).
vec3 lin2oklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  float l_ = pow(max(l, 0.0), 1.0 / 3.0);
  float m_ = pow(max(m, 0.0), 1.0 / 3.0);
  float s_ = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}
vec3 oklab2lin(vec3 lab) {
  float l_ = lab.x + 0.3963377774 * lab.y + 0.2158037573 * lab.z;
  float m_ = lab.x - 0.1055613458 * lab.y - 0.0638541728 * lab.z;
  float s_ = lab.x - 0.0894841775 * lab.y - 1.2914855480 * lab.z;
  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}
`;

// Stage 1 — upscale. Samples the sRGB source with a bicubic kernel, converting
// every tap to linear light *before* weighting (a gamma-space blend of black and
// white lands at ~22% grey, not 50% — that's why naive upscales look dirty in the
// transitions). Outputs linear.
export const UPSCALE = PRELUDE + /* glsl */ `
uniform sampler2D u_src;
uniform vec2 u_srcSize;
uniform int u_kernel; // 0 nearest, 1 mitchell(B=C=1/3), 2 catmull(B=0,C=1/2)

vec3 tap(vec2 px) {
  return srgb2lin(texture(u_src, (px + 0.5) / u_srcSize).rgb);
}
float cubic(float x, float B, float C) {
  x = abs(x);
  float x2 = x * x, x3 = x2 * x;
  if (x < 1.0) return ((12.0 - 9.0*B - 6.0*C)*x3 + (-18.0 + 12.0*B + 6.0*C)*x2 + (6.0 - 2.0*B)) / 6.0;
  if (x < 2.0) return ((-B - 6.0*C)*x3 + (6.0*B + 30.0*C)*x2 + (-12.0*B - 48.0*C)*x + (8.0*B + 24.0*C)) / 6.0;
  return 0.0;
}
void main() {
  if (u_kernel == 0) {
    o_col = vec4(tap(floor(v_uv * u_srcSize)), 1.0);
    return;
  }
  float B = u_kernel == 1 ? 1.0/3.0 : 0.0;
  float C = u_kernel == 1 ? 1.0/3.0 : 0.5;
  vec2 coord = v_uv * u_srcSize - 0.5;
  vec2 f = fract(coord);
  vec2 base = floor(coord);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = -1; j <= 2; j++) {
    float wy = cubic(float(j) - f.y, B, C);
    for (int i = -1; i <= 2; i++) {
      float wx = cubic(float(i) - f.x, B, C);
      float w = wx * wy;
      acc += w * tap(base + vec2(float(i), float(j)));
      wsum += w;
    }
  }
  o_col = vec4(acc / wsum, 1.0);
}`;

// Stage 2 — deblock. Bicubic on a blocky source gives *soft* blocks: the steps
// are still there, just ramped. This kills them with structure-tensor-guided
// anisotropic smoothing — smooth *along* the edge direction (straightens the
// staircase the pixel grid was trying to draw), barely across it (preserves the
// edge). A bilateral range weight stops it bleeding over high-contrast borders.
// Isotropic blur can only trade blockiness for mush; this reconstructs the line.
export const DEBLOCK = PRELUDE + /* glsl */ `
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform float u_amount;   // deblock 0..1
uniform float u_preserve; // edge preservation 0..1
uniform float u_block;    // output px per source pixel (staircase step size)

float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float lumAt(vec2 uv) { return lum(texture(u_tex, uv).rgb); }

void main() {
  vec2 px = 1.0 / u_size;
  vec3 c0 = texture(u_tex, v_uv).rgb;
  if (u_amount <= 0.001) { o_col = vec4(c0, 1.0); return; }

  // Structure tensor J = [[Ix², IxIy],[IxIy, Iy²]], Gaussian-smoothed (σ≈1.5px).
  float Jxx = 0.0, Jxy = 0.0, Jyy = 0.0, ws = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 uv = v_uv + vec2(float(i), float(j)) * px;
      float gx = (lumAt(uv + vec2(px.x, 0.0)) - lumAt(uv - vec2(px.x, 0.0))) * 0.5;
      float gy = (lumAt(uv + vec2(0.0, px.y)) - lumAt(uv - vec2(0.0, px.y))) * 0.5;
      float w = exp(-(float(i * i) + float(j * j)) / (2.0 * 1.5 * 1.5));
      Jxx += w * gx * gx;
      Jxy += w * gx * gy;
      Jyy += w * gy * gy;
      ws += w;
    }
  }
  Jxx /= ws; Jxy /= ws; Jyy /= ws;

  // 2×2 eigendecomposition, closed form. l1 ≥ l2; anisotropy A.
  float tr = Jxx + Jyy;
  float disc = sqrt(max(0.25 * tr * tr - (Jxx * Jyy - Jxy * Jxy), 0.0));
  float l1 = 0.5 * tr + disc;
  float l2 = 0.5 * tr - disc;
  float A = (l1 + l2 > 1e-7) ? (l1 - l2) / (l1 + l2) : 0.0;

  // Gradient (across-edge) direction is the eigenvector of l1; the edge runs ⟂.
  vec2 grad = (abs(Jxy) > 1e-7) ? normalize(vec2(l1 - Jyy, Jxy))
            : (Jxx >= Jyy ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  vec2 edge = vec2(-grad.y, grad.x);

  // Elliptical kernel: long along the edge (grows with anisotropy + block size),
  // short across it (shrinks as edge-preservation rises).
  float along = mix(0.6, u_block, A) * u_amount;
  float across = mix(0.9, 0.3, u_preserve) * u_amount;
  float sigmaR = mix(0.30, 0.03, u_preserve); // bilateral range — tight = preserve

  const int R = 3;
  float l0 = lum(c0);
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = -R; j <= R; j++) {
    for (int i = -R; i <= R; i++) {
      vec2 off = (edge * (float(i) / float(R)) * along + grad * (float(j) / float(R)) * across) * px;
      vec3 s = texture(u_tex, v_uv + off).rgb;
      float wsg = exp(-0.5 * (float(i * i) + float(j * j)) / (float(R * R) / 9.0));
      float dl = lum(s) - l0;
      float wr = exp(-0.5 * dl * dl / (sigmaR * sigmaR));
      float w = wsg * wr;
      acc += w * s;
      wsum += w;
    }
  }
  o_col = vec4(mix(c0, acc / max(wsum, 1e-5), u_amount), 1.0);
}`;

// Stage 3 — grain. Works in OKLab: grain rides the L channel so it's perceptually
// uniform and hue-stable (grain on RGB independently makes chroma noise; grain on
// RGB uniformly is stronger in shadows than it looks). Blue-noise field, luma
// response so grain vanishes in blacks and blown highlights and peaks in the
// mids, optional second octave, a little independent chroma grain.
export const GRAIN = PRELUDE + /* glsl */ `
uniform sampler2D u_tex;
uniform sampler2D u_noise;
uniform float u_noiseSize;
uniform float u_amount;      // 0..1
uniform float u_grainRadius; // px
uniform int u_octaves;       // 1 or 2
uniform float u_rolloff;     // shadow rolloff gamma
uniform float u_chroma;      // 0..1
uniform int u_blend;         // 0 additive, 1 softlight, 2 multiply
uniform float u_desaturate;  // 0..1

float nz(vec2 p, vec2 off) { return texture(u_noise, (p + off) / u_noiseSize).r; }
float grain(vec2 px, vec2 off) {
  float n1 = nz(px / u_grainRadius, off);
  if (u_octaves > 1) {
    float n2 = nz(px / (u_grainRadius * 2.3), off + vec2(37.0, 91.0));
    return ((n1 - 0.5) + (n2 - 0.5) * 0.4) / 0.7;
  }
  return (n1 - 0.5) * 2.0;
}
float response(float L, float g) { return pow(clamp(4.0 * L * (1.0 - L), 0.0, 1.0), g); }
float softLight(float a, float b) { return (1.0 - 2.0 * b) * a * a + 2.0 * b * a; }

void main() {
  vec3 lin = texture(u_tex, v_uv).rgb;
  vec3 lab = lin2oklab(lin);
  lab.yz *= (1.0 - u_desaturate);

  float g = grain(gl_FragCoord.xy, vec2(0.0));
  float strength = u_amount * response(lab.x, u_rolloff);
  if (u_blend == 0) {
    lab.x += strength * 0.28 * g;
  } else if (u_blend == 1) {
    lab.x = mix(lab.x, softLight(lab.x, 0.5 + 0.5 * g), strength);
  } else {
    lab.x *= 1.0 + strength * 0.5 * g;
  }

  if (u_chroma > 0.0) {
    lab.y += u_chroma * 0.03 * grain(gl_FragCoord.xy, vec2(11.0, 23.0));
    lab.z += u_chroma * 0.03 * grain(gl_FragCoord.xy, vec2(101.0, 53.0));
  }
  o_col = vec4(oklab2lin(lab), 1.0);
}`;

// Stage 4 — finish. Small-radius unsharp for micro-contrast (large radii find the
// residual block edges and resurrect them — keep it tight), a cheap thresholded
// highlight bloom for halation, output stays linear. Present handles the final
// linear→sRGB + dither.
export const FINISH = PRELUDE + /* glsl */ `
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform float u_sharpen;  // 0..1
uniform float u_halation; // 0..1

void main() {
  vec2 px = 1.0 / u_size;
  vec3 c = texture(u_tex, v_uv).rgb;

  // Unsharp: blur = 4-neighbour average at 1px, sharpen = c + amt*(c - blur).
  vec3 blur = (
    texture(u_tex, v_uv + vec2(px.x, 0.0)).rgb +
    texture(u_tex, v_uv - vec2(px.x, 0.0)).rgb +
    texture(u_tex, v_uv + vec2(0.0, px.y)).rgb +
    texture(u_tex, v_uv - vec2(0.0, px.y)).rgb) * 0.25;
  c += u_sharpen * (c - blur);

  // Halation: ring-sample the thresholded highlights wide, screen back low.
  if (u_halation > 0.0) {
    vec3 bloom = vec3(0.0);
    float r = 6.0;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.7853981634; // 2pi/8
      vec3 s = texture(u_tex, v_uv + vec2(cos(a), sin(a)) * px * r).rgb;
      bloom += max(s - 0.75, 0.0);
    }
    bloom /= 8.0;
    vec3 tint = bloom * vec3(1.0, 0.6, 0.4); // warm halo
    c = 1.0 - (1.0 - c) * (1.0 - tint * u_halation * 2.0); // screen
  }
  o_col = vec4(max(c, 0.0), 1.0);
}`;

// Present — composite to the canvas. Left of the split shows the source at output
// scale sampled NEAREST (the honest "before": still blocky); right shows the
// processed result, linear→sRGB with a TPDF dither on the 8-bit quantization to
// kill gradient banding. Aspect-fit letterboxing, amber divider.
export const PRESENT = PRELUDE + /* glsl */ `
uniform sampler2D u_result; // linear processed
uniform sampler2D u_src;    // sRGB source, NEAREST
uniform vec2 u_fit;         // image size / canvas size (<=1 on the fitted axis)
uniform float u_zoom;       // view zoom (1 = fit); pans/zooms are canvas-space only
uniform vec2 u_pan;         // view pan in canvas (v_uv) units
uniform float u_split;      // 0..1 in canvas x
uniform float u_showSplit;  // 1 to draw divider + before/after, 0 = all processed
uniform vec2 u_seed;

float rnd(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 bg = vec3(0.0);
  // View transform first (zoom toward / pan across the fitted image), then the
  // aspect-fit. u_zoom=1, u_pan=0 collapses this back to plain fit (export path).
  vec2 uv = (v_uv - 0.5 - u_pan) / (u_fit * u_zoom) + 0.5;
  // Textures are stored image-top at v=0, but the canvas' v_uv origin is
  // bottom-left — flip so the image top lands at the top of the frame. This is
  // the single place orientation is corrected (display + export both go through
  // present), so it stays consistent everywhere.
  uv.y = 1.0 - uv.y;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    o_col = vec4(bg, 1.0);
    return;
  }

  bool before = u_showSplit > 0.5 && v_uv.x < u_split;
  vec3 col;
  if (before) {
    col = texture(u_src, uv).rgb; // already sRGB
  } else {
    // TPDF dither: sum of two independent uniforms, ±0.5 LSB.
    float d = (rnd(gl_FragCoord.xy + u_seed) + rnd(gl_FragCoord.xy + u_seed + 7.0) - 1.0) / 255.0;
    col = lin2srgb(texture(u_result, uv).rgb) + d;
  }

  if (u_showSplit > 0.5 && abs(v_uv.x - u_split) < 0.0012) {
    col = vec3(1.0, 0.69, 0.0); // amber divider
  }
  o_col = vec4(col, 1.0);
}`;
