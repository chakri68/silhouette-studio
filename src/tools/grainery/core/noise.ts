/**
 * Blue-noise tile via void-and-cluster (Ulichney).
 *
 * Why not `fract(sin(dot(...)))` hash noise: hash noise is white — its energy is
 * flat across all frequencies including the low ones, so it clumps into visible
 * blotches and reads as cheap digital sensor noise. Blue noise pushes its energy
 * into the high frequencies with minimal low-frequency clumping, which is exactly
 * what film grain does and exactly what breaks the residual block grid.
 *
 * The tile is small (64²) and tiled with per-channel / per-octave offsets in the
 * shader, so the repeat never becomes visible. Generation is deterministic (a
 * seeded LCG, no Math.random) so every session gets the identical tile.
 */

export function generateBlueNoise(size = 64): { data: Uint8Array; size: number } {
  const N = size * size;
  const energy = new Float32Array(N);
  const sigma = 1.9;

  // Truncated Gaussian kernel, applied incrementally: toggling one pixel adds or
  // subtracts its kernel footprint from the energy field, so we never re-convolve
  // the whole tile.
  const R = Math.ceil(sigma * 3);
  const kernel: { dx: number; dy: number; w: number }[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      kernel.push({ dx, dy, w: Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) });
    }
  }
  const wrap = (v: number): number => (v + size) % size;
  const idx = (x: number, y: number): number => wrap(y) * size + wrap(x);
  const stamp = (p: number, sign: number, e: Float32Array): void => {
    const x = p % size;
    const y = (p / size) | 0;
    for (const k of kernel) e[idx(x + k.dx, y + k.dy)] += sign * k.w;
  };

  // Seeded LCG — reproducible tiles.
  let seed = 0x9e3779b9;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  const tightestCluster = (pat: Uint8Array, e: Float32Array): number => {
    let best = -1;
    let max = -Infinity;
    for (let p = 0; p < N; p++) if (pat[p] && e[p] > max) ((max = e[p]), (best = p));
    return best;
  };
  const largestVoid = (pat: Uint8Array, e: Float32Array): number => {
    let best = -1;
    let min = Infinity;
    for (let p = 0; p < N; p++) if (!pat[p] && e[p] < min) ((min = e[p]), (best = p));
    return best;
  };

  // Seed ~10% ones at random, then relax: repeatedly move a 1 from the tightest
  // cluster into the largest void until the two coincide (the pattern is stable).
  const pattern = new Uint8Array(N);
  const target = Math.floor(N * 0.1);
  for (let ones = 0; ones < target; ) {
    const p = (rand() * N) | 0;
    if (!pattern[p]) ((pattern[p] = 1), stamp(p, 1, energy), ones++);
  }
  for (;;) {
    const cp = tightestCluster(pattern, energy);
    pattern[cp] = 0;
    stamp(cp, -1, energy);
    const vp = largestVoid(pattern, energy);
    pattern[vp] = 1;
    stamp(vp, 1, energy);
    if (vp === cp) break;
  }

  const proto = pattern.slice();
  let onesCount = 0;
  for (let p = 0; p < N; p++) if (proto[p]) onesCount++;

  const rank = new Int32Array(N).fill(-1);

  // Phase 2 — remove ones one at a time from the tightest cluster, handing out
  // ranks (onesCount-1) down to 0.
  energy.fill(0);
  const work = proto.slice();
  for (let p = 0; p < N; p++) if (work[p]) stamp(p, 1, energy);
  for (let r = onesCount - 1; r >= 0; r--) {
    const cp = tightestCluster(work, energy);
    rank[cp] = r;
    work[cp] = 0;
    stamp(cp, -1, energy);
  }

  // Phase 3 — add ones into the largest voids, handing out ranks onesCount up to N-1.
  energy.fill(0);
  const work2 = proto.slice();
  for (let p = 0; p < N; p++) if (work2[p]) stamp(p, 1, energy);
  for (let r = onesCount; r < N; r++) {
    const vp = largestVoid(work2, energy);
    rank[vp] = r;
    work2[vp] = 1;
    stamp(vp, 1, energy);
  }

  const data = new Uint8Array(N);
  for (let p = 0; p < N; p++) data[p] = Math.min(255, Math.floor((rank[p] * 256) / N));
  return { data, size };
}
