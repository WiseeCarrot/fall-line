// Deterministic math helpers. Every map is generated from a seed, so anything
// random in here has to be reproducible across reloads.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const smootherstep = (t) => t * t * t * (t * (t * 6 - 15) + 10);
export const invLerp = (a, b, v) => (b === a ? 0 : (v - a) / (b - a));
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const TAU = Math.PI * 2;

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest signed angular delta from a to b. */
export const angleDelta = (a, b) => wrapAngle(b - a);

/** mulberry32 — small, fast, well-distributed seeded PRNG. */
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.int = (lo, hi) => Math.floor(lo + rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  // Box-Muller, cached second sample.
  let spare = null;
  rng.normal = () => {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u = 0, v = 0, s = 0;
    do {
      u = rng() * 2 - 1;
      v = rng() * 2 - 1;
      s = u * u + v * v;
    } while (s === 0 || s >= 1);
    const m = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * m;
    return u * m;
  };
  return rng;
}

/**
 * Seeded 2D value-noise with cubic interpolation. Cheaper than simplex and the
 * artifacts don't matter once we stack four octaves of it into terrain.
 */
export class Noise2D {
  constructor(seed) {
    const rng = makeRng(seed);
    this.perm = new Uint16Array(1024);
    for (let i = 0; i < 512; i++) this.perm[i] = i;
    for (let i = 511; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = this.perm[i];
      this.perm[i] = this.perm[j];
      this.perm[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[512 + i] = this.perm[i];
    this.grad = new Float32Array(512);
    for (let i = 0; i < 512; i++) this.grad[i] = rng() * 2 - 1;
  }

  hash(ix, iy) {
    return this.grad[this.perm[(this.perm[ix & 511] + (iy & 511)) & 511]];
  }

  sample(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const u = smootherstep(fx), v = smootherstep(fy);
    const a = this.hash(ix, iy);
    const b = this.hash(ix + 1, iy);
    const c = this.hash(ix, iy + 1);
    const d = this.hash(ix + 1, iy + 1);
    return lerp(lerp(a, b, u), lerp(c, d, u), v);
  }

  /** Fractal Brownian motion. Returns roughly [-1, 1]. */
  fbm(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.sample(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged noise — sharp crests, good for rocky spines and distant peaks. */
  ridged(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.sample(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return (sum / norm) * 2 - 1;
  }
}

/**
 * Catmull-Rom through a list of {x, z} control points. Used for trail
 * centrelines, so it needs a resample-to-even-spacing pass for the mask splat.
 */
export function catmullRom(points, t) {
  const n = points.length;
  if (n === 0) return { x: 0, z: 0 };
  if (n === 1) return { ...points[0] };
  const scaled = clamp(t, 0, 1) * (n - 1);
  const i = Math.min(Math.floor(scaled), n - 2);
  const f = scaled - i;
  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n - 1, i + 2)];
  const f2 = f * f, f3 = f2 * f;
  const c = (a, b, cc, d) =>
    0.5 * ((2 * b) + (-a + cc) * f + (2 * a - 5 * b + 4 * cc - d) * f2 + (-a + 3 * b - 3 * cc + d) * f3);
  return { x: c(p0.x, p1.x, p2.x, p3.x), z: c(p0.z, p1.z, p2.z, p3.z) };
}

/** Resample a spline into evenly spaced points, ~`spacing` world units apart. */
export function resampleSpline(points, spacing) {
  const rough = [];
  const steps = Math.max(64, points.length * 24);
  for (let i = 0; i <= steps; i++) rough.push(catmullRom(points, i / steps));

  let total = 0;
  const cum = [0];
  for (let i = 1; i < rough.length; i++) {
    total += Math.hypot(rough[i].x - rough[i - 1].x, rough[i].z - rough[i - 1].z);
    cum.push(total);
  }

  const out = [];
  const count = Math.max(2, Math.ceil(total / spacing));
  let cursor = 0;
  for (let i = 0; i <= count; i++) {
    const target = (i / count) * total;
    while (cursor < cum.length - 2 && cum[cursor + 1] < target) cursor++;
    const seg = cum[cursor + 1] - cum[cursor];
    const f = seg > 1e-6 ? (target - cum[cursor]) / seg : 0;
    out.push({
      x: lerp(rough[cursor].x, rough[cursor + 1].x, f),
      z: lerp(rough[cursor].z, rough[cursor + 1].z, f),
    });
  }
  return out;
}
