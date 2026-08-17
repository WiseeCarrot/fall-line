// Procedural terrain. Takes a map spec and produces a heightfield plus the
// queries the rest of the game needs: height, normal, groom, and surface type.
//
// The pipeline, in order:
//   1. integrate the pitch profile into a base elevation per Z row
//   2. lay out trail centrelines as splines down the fall line
//   3. splat those splines into a groom mask + a smoothed trail-height field
//   4. per vertex: base + relief noise, carved toward the trail field
//   5. moguls, cliff bands, crevasses, boundary walls
//   6. slope-derived colouring, then one big BufferGeometry

import * as THREE from 'three';
import { Noise2D, makeRng, clamp, lerp, smoothstep, resampleSpline } from '../core/math.js';
import { gradientAt } from './maps.js';

const VERTEX_BUDGET = 300000;
const MIN_CELL = 3.0;
const MAX_CELL = 8.0;
/**
 * Attach a width lookup to a trail.
 *
 * `widthProfile` is a list of {t, w} down the run, interpolated the same way
 * pitch is. Without it a trail is one width end to end, which is fine for a
 * groomer but can't express a run that necks down — a chute that starts as an
 * open face and pinches to a slot is a different thing to ski at the bottom
 * than it is at the top, and that difference has to exist in the geometry.
 */
function makeTrail(trail) {
  const prof = trail.widthProfile;
  trail.widthAt = prof && prof.length
    ? (t) => {
      if (t <= prof[0].t) return prof[0].w;
      for (let i = 1; i < prof.length; i++) {
        if (t <= prof[i].t) {
          const a = prof[i - 1], b = prof[i];
          return lerp(a.w, b.w, smoothstep((t - a.t) / Math.max(1e-6, b.t - a.t)));
        }
      }
      return prof[prof.length - 1].w;
    }
    : () => trail.width;
  // Widest point, for anything that needs a single conservative number.
  trail.maxWidth = prof && prof.length ? Math.max(...prof.map((p) => p.w)) : trail.width;
  return trail;
}

const _fallNormal = new THREE.Vector3();
const SUMMIT_WALL_Z = 60;   // rollover behind the start
const START_Z = 82;         // clear of the rollover, on the real pitch
const TOP_FADE_Z = 200;     // relief eases in over this distance from the summit
// How steep relief noise may get relative to the pitch it sits on. Above ~1.2
// the noise starts producing genuine uphill sections rather than undulations.
const RELIEF_GRADIENT_RATIO = 1.15;
const TUBE_LANE_W = 6.5;    // width of a single tubing lane
// Metres a run's carve target bows per unit of `steep` above 1. Kept small:
// neighbouring runs sit ~60 m apart, so every metre of bow difference is a
// metre of cross-slope berm between them.
const BOW_SCALE = 13;

export class Terrain {
  constructor(spec, vertexBudget = VERTEX_BUDGET) {
    this.spec = spec;
    this.width = spec.width;
    this.length = spec.length;
    this.halfW = spec.width / 2;

    // The heightfield is by far the largest mesh in the scene, so the detail
    // setting has to reach it — trimming trees alone barely moves the needle.
    const area = spec.width * spec.length;
    this.cell = clamp(Math.sqrt(area / vertexBudget), MIN_CELL, MAX_CELL);
    this.nx = Math.max(2, Math.floor(spec.width / this.cell) + 1);
    this.nz = Math.max(2, Math.floor(spec.length / this.cell) + 1);
    this.cellX = spec.width / (this.nx - 1);
    this.cellZ = spec.length / (this.nz - 1);

    const n = this.nx * this.nz;
    this.height = new Float32Array(n);
    this.groom = new Float32Array(n);   // 0 = untouched, 1 = corduroy
    this.rock = new Float32Array(n);    // 0 = snow, 1 = exposed rock
    this.ice = new Float32Array(n);     // frozen lakes / scoured hardpack
    this.carve = new Float32Array(n);   // how much the ribbon is cut into the hill
    this.paved = new Float32Array(n);   // car parks and plaza hardstanding
    this.trailH = new Float32Array(n);
    this.trailW = new Float32Array(n);

    // Where the resort actually is, as opposed to where the skiing is.
    // Filled in by stampBaseArea(); props.js builds on top of it.
    this.baseArea = null;

    // Built terrain features that other systems need to know about: jumps are
    // baked into the heightfield, rails are separate collidable platforms.
    this.parkFeatures = { jumps: [], rails: [], pipe: null, lakes: [] };

    this.noise = new Noise2D(spec.seed);
    this.detail = new Noise2D(spec.seed ^ 0x9e37);
    this.rng = makeRng(spec.seed ^ 0x5bf0);

    this.trails = [];
    this.mesh = null;
  }

  // ── index helpers ───────────────────────────────────────────────
  xAt(ix) { return -this.halfW + ix * this.cellX; }
  zAt(iz) { return iz * this.cellZ; }
  idx(ix, iz) { return iz * this.nx + ix; }

  /** Build everything. `onProgress(frac, label)` is called between phases. */
  async build(onProgress = () => {}) {
    const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

    onProgress(0.05, 'Carving the fall line');
    this.buildBaseProfile();
    await yieldFrame();

    onProgress(0.15, 'Laying out trails');
    this.buildTrails();
    this.splatTrails();
    await yieldFrame();

    onProgress(0.3, 'Growing the mountain');
    await this.buildHeights(onProgress);

    onProgress(0.74, 'Shaping features');
    this.stampFeatures();
    await yieldFrame();

    onProgress(0.78, 'Settling the snowpack');
    this.smoothPass();
    this.stampMoguls();
    this.computeRock();
    await yieldFrame();

    onProgress(0.88, 'Painting the snow');
    this.buildMesh();
    await yieldFrame();

    onProgress(1, 'Ready');
    return this;
  }

  // ── 1. base elevation ───────────────────────────────────────────
  buildBaseProfile() {
    const { pitch, drop } = this.spec;
    this.gradientAt = (t) => gradientAt(pitch, t);

    this.baseElev = new Float32Array(this.nz);
    let e = 0;
    for (let iz = 0; iz < this.nz; iz++) {
      const t = iz / (this.nz - 1);
      if (iz > 0) e -= this.gradientAt(t) * this.cellZ;
      this.baseElev[iz] = e;
    }
    // Shift so the base sits at y = 0. `drop` is derived from this same pitch
    // profile in maps.js, so the two already agree to within rounding — the
    // scale here just removes that last fraction of a percent.
    const total = -this.baseElev[this.nz - 1];
    const scale = total > 1e-3 ? drop / total : 1;
    for (let iz = 0; iz < this.nz; iz++) {
      this.baseElev[iz] = (this.baseElev[iz] + total) * scale;
    }

    this.buildCrossProfile();
  }

  /**
   * The shape of the hill *across* the fall line.
   *
   * `pitch` describes one line down the mountain and every map applies it at
   * every x, so without this a hill is a ramp: the summit is a level edge the
   * full width of the map and the only lateral variation is isotropic noise.
   * That is fine for a bowl or a chute, where the run is the terrain. It is
   * not fine for a broad face read off a trail map, where the crest is plainly
   * a knoll off to one side and the ground falls away to both ends.
   *
   * `spec.crossProfile` is a list of {x, dy}: x is -1..1 across the face, dy
   * is metres relative to the crest and is therefore never positive — keeping
   * the maximum at zero means the map's stated vertical stays the truth.
   *
   * The offset is strongest at the summit and mostly gone by the base, which
   * is both what the drawing shows and what a hill does: ridges have shape,
   * outruns are flat.
   */
  buildCrossProfile() {
    const prof = this.spec.crossProfile;
    if (!prof || prof.length < 2) { this.crossElev = null; return; }

    const pts = [...prof].sort((a, b) => a.x - b.x);
    const peak = Math.max(...pts.map((p) => p.dy));

    // Sampled per column once; rawHeight is called a few million times and
    // cannot afford to walk the list.
    this.crossElev = new Float32Array(this.nx);
    for (let ix = 0; ix < this.nx; ix++) {
      const u = this.xAt(ix) / this.halfW;
      let dy;
      if (u <= pts[0].x) dy = pts[0].dy;
      else if (u >= pts[pts.length - 1].x) dy = pts[pts.length - 1].dy;
      else {
        let i = 1;
        while (i < pts.length - 1 && u > pts[i].x) i++;
        const a = pts[i - 1], b = pts[i];
        const f = (u - a.x) / Math.max(1e-6, b.x - a.x);
        dy = a.dy + (b.dy - a.dy) * (f * f * (3 - 2 * f));
      }
      this.crossElev[ix] = dy - peak;
    }
  }

  /** Cross-slope offset at an arbitrary x, linearly between columns. */
  crossAt(x) {
    if (!this.crossElev) return 0;
    const f = clamp((x + this.halfW) / this.cellX, 0, this.nx - 1);
    const i = Math.floor(f);
    const j = Math.min(this.nx - 1, i + 1);
    return lerp(this.crossElev[i], this.crossElev[j], f - i);
  }

  // ── 2. trail centrelines ────────────────────────────────────────
  buildTrails() {
    if (this.spec.trails.runs) return this.buildNamedRuns();

    const { trails, wander } = this.spec;
    const count = trails.count;
    const usable = this.halfW - trails.width * 0.5 - 40;
    const rng = this.rng;

    for (let i = 0; i < count; i++) {
      // Trails share a summit and fan out toward the base.
      const spread = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
      const startX = spread * Math.min(usable * 0.22, 140) + rng.range(-18, 18);
      const endX = spread * usable * 0.72 + rng.range(-40, 40);

      const nodes = 6 + Math.floor(this.length / 700);
      const pts = [];
      const phase = rng.range(0, 100);
      // Meander has to stay inside the usable width. Unclamped, a high-wander
      // chute swings past the boundary, gets pinned to the map edge, and the
      // trail ends up carved into the side walls.
      const amp = Math.min(wander * Math.min(usable * 0.3, 150), usable * 0.6);
      // How quickly trails diverge from the shared summit. Above 1 they split
      // higher up the mountain, which leaves wooded islands between the runs
      // instead of one continuous white face.
      const fan = 1 / (this.spec.fan ?? 1);

      for (let k = 0; k <= nodes; k++) {
        const t = k / nodes;
        const z = t * this.length;
        // Blend from the shared summit out to the trail's own base position,
        // then add meander that fades in after the top so trails don't cross.
        const spine = lerp(startX, endX, Math.pow(smoothstep(t), fan));
        const fade = Math.sin(Math.min(1, t * 2.2) * Math.PI * 0.5);
        const meander = this.noise.fbm(phase + t * 2.4, i * 7.7, 2) * amp * fade;
        pts.push({ x: clamp(spine + meander, -usable, usable), z });
      }

      const samples = resampleSpline(pts, Math.max(6, this.cell * 1.5));
      this.trails.push(makeTrail({
        points: pts,
        samples,
        width: trails.width,
        widthProfile: trails.widthProfile,
        groom: trails.groom,
        feather: trails.feather,
        index: i,
      }));
    }
  }

  /**
   * Build trails from an explicit run list rather than generating them.
   *
   * Used where a map is modelled on a real hill: each run has its own name,
   * difficulty, lateral position across the face, where up the mountain it
   * starts, and how steep it is relative to the base pitch. Runs sit roughly
   * parallel and only fan slightly, which is how a broad single-face hill
   * actually reads — nothing like the radial spray the generator produces.
   */
  buildNamedRuns() {
    const { trails, wander } = this.spec;
    const usable = this.halfW - trails.width * 0.5 - 30;
    const rng = this.rng;

    // How much of the usable half-width the run list is allowed to occupy, at
    // the summit and at the base. Runs were kept well inside the boundary rise
    // because the outermost ones were being laid through the side walls, which
    // pinch and stall anyone skiing them — but squeezing every run into the
    // middle two thirds also packs them together, and on a hill with fourteen
    // of them side by side that is the difference between separate ribbons and
    // one white sheet. A map that has flattened its own walls can say so.
    const spreadTop = trails.spread?.top ?? 0.68;
    const spreadBase = trails.spread?.base ?? 0.80;

    trails.runs.forEach((run, i) => {
      const z0 = (run.top ?? 0.04) * this.length;
      const z1 = (run.bottom ?? 0.985) * this.length;
      const topX = run.x * usable * spreadTop;
      const botX = (run.xBase ?? run.x) * usable * spreadBase;

      const nodes = Math.max(5, Math.round((z1 - z0) / 190));
      const pts = [];
      const phase = rng.range(0, 100);
      const amp = Math.min(usable * 0.05, 26) * (wander ?? 1);

      for (let k = 0; k <= nodes; k++) {
        const t = k / nodes;
        const z = lerp(z0, z1, t);
        const spine = lerp(topX, botX, smoothstep(t));
        const meander = this.noise.fbm(phase + t * 1.8, i * 5.3, 2) * amp * Math.sin(t * Math.PI);
        pts.push({ x: clamp(spine + meander, -usable, usable), z });
      }

      this.trails.push(makeTrail({
        points: pts,
        samples: resampleSpline(pts, Math.max(6, this.cell * 1.5)),
        width: run.width ?? trails.width,
        widthProfile: run.widthProfile ?? trails.widthProfile,
        groom: run.groom ?? trails.groom,
        feather: run.feather ?? trails.feather,
        steep: run.steep ?? 1,
        name: run.name,
        difficulty: run.diff ?? this.spec.difficulty,
        index: i,
      }));
    });
  }

  /**
   * Splat trail corridors into three fields:
   *  - `groom`  how skied-out / corduroyed the surface is (full trail width)
   *  - `carve`  how strongly the ribbon is cut flat into the hillside
   *  - `trailH` the smoothed height the carve pulls toward
   *
   * groom and carve are deliberately separate. A 60 m groomer is cut into the
   * slope along its whole width; a 700 m bowl is "groomed" in the surface
   * sense but must keep its natural relief, or the carve averages the entire
   * mountain into one flat plane.
   */
  splatTrails() {
    for (const trail of this.trails) {
      const carveFeather = 45;

      // Runs on one face share a start and a finish elevation, so a steeper
      // run can't simply be tilted — its *average* gradient is fixed. What
      // varies is the distribution: a black is steep up top and flattens out,
      // a green is even. So the carve target bows downward in the middle,
      // which steepens the first half and eases the second.
      //
      // The amplitude is capped against the run's own base gradient. A bow
      // steeper than the hill turns the lower half uphill and digs a crater
      // you can't climb out of, which is exactly what an uncapped version did.
      // The bow is phased on absolute height down the *mountain*, not on each
      // run's own length. Runs start at different points up the hill, so a
      // per-run phase means neighbours bow against each other — which built
      // 44° walls between adjacent corridors. Anchored to altitude, every run
      // bows in step and only the amplitude differs.
      const bowAmp = ((trail.steep ?? 1) - 1) * BOW_SCALE;

      const sampleCount = trail.samples.length - 1;

      trail.samples.forEach((p, si) => {
        // Width is resolved per sample, not per trail, so a run can taper.
        const width = trail.widthAt(sampleCount > 0 ? si / sampleCount : 0);
        const half = width * 0.5;
        // The soft shoulder either side of the corduroy, scaled off the width
        // so a wide groomer gets a wide edge. That is right for a mountain
        // whose runs are a hundred metres apart and wrong for one traced off a
        // trail map: at 34 m wide it still adds 30 m of groomed ground to every
        // corridor, and runs drawn 58 m apart overlap before the first tree is
        // placed — fourteen separate ribbons splatting into six blobs, two of
        // them over 200 m across, which is the white sheet the map exists to
        // avoid. `trails.feather` states the shoulder outright for hills whose
        // runs are cut through timber and have an edge you can point at.
        const feather = trail.feather ?? clamp(width * 0.45, 18, 55);
        const rMask = half + feather;
        // The carve is capped independently of width: past this it isn't a
        // cut trail any more, it's open terrain.
        const carveHalf = Math.min(half, 55);
        const rHeight = carveHalf + carveFeather;

        const shape = Math.sin(Math.PI * clamp(p.z / this.length, 0, 1));
        const hC = this.rawHeight(p.x, p.z, 0.35) - bowAmp * shape;
        const reach = Math.max(rMask, rHeight);

        const ix0 = Math.max(0, Math.floor((p.x + this.halfW - reach) / this.cellX));
        const ix1 = Math.min(this.nx - 1, Math.ceil((p.x + this.halfW + reach) / this.cellX));
        const iz0 = Math.max(0, Math.floor((p.z - reach) / this.cellZ));
        const iz1 = Math.min(this.nz - 1, Math.ceil((p.z + reach) / this.cellZ));

        for (let iz = iz0; iz <= iz1; iz++) {
          const dz = this.zAt(iz) - p.z;
          for (let ix = ix0; ix <= ix1; ix++) {
            const dx = this.xAt(ix) - p.x;
            const d = Math.hypot(dx, dz);
            if (d > reach) continue;
            const i = this.idx(ix, iz);

            if (d < rMask) {
              const m = d <= half ? 1 : 1 - smoothstep((d - half) / feather);
              const g = m * trail.groom;
              if (g > this.groom[i]) this.groom[i] = g;
            }

            if (d < rHeight) {
              const c = d <= carveHalf ? 1 : 1 - smoothstep((d - carveHalf) / carveFeather);
              const cg = c * trail.groom;
              if (cg > this.carve[i]) this.carve[i] = cg;

              // Sharp falloff, not quadratic. With eighteen runs packed across
              // one face the corridors overlap heavily, and a soft kernel
              // averages a black diamond together with the green beside it
              // until every run on the hill has the same pitch. A high power
              // lets the nearest centreline dominate, so adjacent runs keep
              // their own gradients and a rolling divide forms between them.
              const w = 1 - d / rHeight;
              const w2 = w * w * w * w;
              this.trailH[i] += hC * w2;
              this.trailW[i] += w2;
            }
          }
        }
      });
    }
  }

  // ── 3. per-vertex height ────────────────────────────────────────
  /**
   * Relief is damped near the summit. With full-amplitude noise a map with big
   * relief can easily put a flat shelf or a rise exactly where you spawn, and
   * "gravity does nothing for eight seconds" is a bad way to start a run.
   */
  topFade(z) {
    return 0.15 + 0.85 * smoothstep(clamp(z / TOP_FADE_Z, 0, 1));
  }

  /**
   * Relief amplitude allowed at a given point down the run.
   *
   * A sine of amplitude A and wavelength L has a maximum gradient of 2πA/L.
   * If that exceeds the pitch, the noise doesn't just add texture — it tips
   * sections of the hill uphill, and you coast to a halt in a hollow that the
   * map's own gradient can't pull you out of. So the amplitude is capped
   * against the *local* pitch: gentle benches get gentle relief, steep faces
   * keep every bit of their character.
   */
  reliefAmpAt(t) {
    const { relief } = this.spec;
    const cap = (RELIEF_GRADIENT_RATIO * this.gradientAt(t) * relief.scale) / (Math.PI * 2);
    return Math.min(relief.amp, cap);
  }

  /** Terrain before trails, moguls or cliffs — the natural hillside. */
  rawHeight(x, z, reliefScale = 1) {
    const { relief } = this.spec;
    const iz = clamp(Math.round(z / this.cellZ), 0, this.nz - 1);
    // Full crown at the summit, a sixth of it left by the base — the ends of
    // the ridge come down to meet the apron rather than staying banked.
    const cross = this.crossElev
      ? this.crossAt(x) * (1 - 0.84 * smoothstep(clamp(z / this.length, 0, 1)))
      : 0;
    const base = this.baseElev[iz] + cross;
    const s = reliefScale * this.topFade(z);
    const amp = this.reliefAmpAt(iz / Math.max(1, this.nz - 1));
    const n = this.noise.fbm(x / relief.scale, z / relief.scale, relief.octaves);
    const fine = this.detail.fbm(x / 90, z / 90, 3) * 2.2;
    return base + n * amp * s + fine * s;
  }

  async buildHeights(onProgress) {
    const spec = this.spec;
    const { relief, cliffs } = spec;
    const boundStart = this.halfW * 0.72;
    const boundRange = Math.max(1, this.halfW - boundStart);
    // `true` for the whole map, or {t0, t1} for a band of it — a glacier
    // that only breaks up over one section shouldn't be split end to end.
    const crevasses = spec.features.crevasses;

    const rowsPerChunk = Math.max(8, Math.floor(this.nz / 24));
    for (let iz = 0; iz < this.nz; iz++) {
      const z = this.zAt(iz);
      const base = this.baseElev[iz];
      const tz = iz / (this.nz - 1);
      const fade = this.topFade(z);
      const reliefAmp = this.reliefAmpAt(tz);

      for (let ix = 0; ix < this.nx; ix++) {
        const x = this.xAt(ix);
        const i = this.idx(ix, iz);

        // natural hillside
        const n = this.noise.fbm(x / relief.scale, z / relief.scale, relief.octaves);
        let h = base + (n * reliefAmp + this.detail.fbm(x / 90, z / 90, 3) * 2.2) * fade;

        const groom = this.groom[i];

        // cliff bands and rocky ribs, suppressed on-piste
        if (cliffs > 0) {
          const r = this.detail.ridged(x / 150, z / 190, 4);
          if (r > 0.25) {
            const ledge = (r - 0.25) / 0.75;
            h += ledge * ledge * cliffs * 34 * (1 - groom * 0.9);
          }
        }

        // carve the trail ribbon in
        if (this.trailW[i] > 1e-5 && this.carve[i] > 0.001) {
          const th = this.trailH[i] / this.trailW[i];
          const blend = clamp(this.carve[i] * 0.92, 0, 1);
          h = lerp(h, th, blend);
          // slight crown so groomers shed water and read as built
          h += blend * 0.6;
        }

        // Glacier crevasses — rounded slots across the fall line. Shallow on
        // purpose: at eleven metres deep they were one-way, and a hazard you
        // can't ski out of is just a reload button.
        if (crevasses && (crevasses === true || (tz >= crevasses.t0 && tz <= crevasses.t1))) {
          const c = Math.abs(this.detail.fbm(x / 260, z / 90, 2));
          if (c < 0.07) {
            const d = 1 - c / 0.07;
            h -= smoothstep(d) * 5.5;
          }
        }

        // Side walls keep you on the mountain. Quadratic, not cubic — a cubic
        // rise turns the last few metres into a near-vertical face, which then
        // gets classified as rock and reads as a black wall around the map.
        const ax = Math.abs(x);
        if (ax > boundStart) {
          const t = (ax - boundStart) / boundRange;
          const ridge = 0.75 + 0.25 * this.noise.fbm(z / 240, x / 240, 3);
          h += t * t * 88 * spec.boundsRise * ridge;
        }
        // A rollover behind the start so you can't ski off the back of the
        // summit. Kept under ~35° — steeper than this and spawning near it
        // puts you on a cliff.
        if (z < SUMMIT_WALL_Z) {
          const t = (SUMMIT_WALL_Z - z) / SUMMIT_WALL_Z;
          h += t * t * 22;
        }
        // fade relief out at the very bottom so the runout is flat and readable
        if (tz > 0.96) {
          const t = (tz - 0.96) / 0.04;
          h = lerp(h, base, smoothstep(t) * 0.7);
        }

        this.height[i] = h;
      }

      if (iz % rowsPerChunk === 0) {
        onProgress(0.3 + 0.45 * (iz / this.nz), 'Growing the mountain');
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  }

  // ── built features ──────────────────────────────────────────────
  /**
   * Jumps, halfpipes and frozen lakes are stamped straight into the
   * heightfield. That way the existing ski physics handles them for free — a
   * kicker is just terrain that happens to point up.
   */
  stampFeatures() {
    const f = this.spec.features;
    if (f.lodge) this.stampBaseArea();
    // A hill can have more than one park: Perfect North has a proper one on
    // the face and a beginner one down on the learning area, and they are not
    // the same object at different sizes.
    if (f.park) for (const park of [].concat(f.park)) this.stampPark(park);
    if (f.lakes) this.stampLakes();
    if (f.pond) for (const pond of [].concat(f.pond)) this.stampPond(pond);
    if (f.iceField) this.stampIceField(f.iceField);
  }

  /**
   * A placed body of water at the foot of the hill.
   *
   * `lakes` finds its own tarns in flat benches up the mountain, which is no
   * use for the thing every snowmaking hill is built around: a reservoir sat
   * in the corner of the base, in a spot the map names rather than the terrain
   * chooses. So this one is given {x, t0, t1, halfX} outright.
   *
   * It is cut *below* the surrounding ground and iced over rather than merely
   * flattened, so it reads as water and not as one more piece of apron.
   */
  stampPond(pond) {
    const cx = clamp(pond.x * this.halfW, -this.halfW + 20, this.halfW - 20);
    const z0 = pond.t0 * this.length;
    const z1 = pond.t1 * this.length;
    const cz = (z0 + z1) / 2;
    const halfX = pond.halfX ?? 90;
    const halfZ = (z1 - z0) / 2;
    const bank = pond.bank ?? 3.2;      // metres the surface sits below the bank
    const feather = 26;

    // Surface height: the lowest ground around the rim, minus the bank. Taking
    // the lowest rather than the centre stops a pond on sloping ground from
    // standing proud of its own downhill shore.
    let surface = Infinity;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      surface = Math.min(surface, this.heightAt(cx + Math.cos(ang) * halfX, cz + Math.sin(ang) * halfZ));
    }
    surface -= bank;

    const ix0 = Math.max(0, Math.floor((cx - halfX - feather + this.halfW) / this.cellX));
    const ix1 = Math.min(this.nx - 1, Math.ceil((cx + halfX + feather + this.halfW) / this.cellX));
    const iz0 = Math.max(0, Math.floor((cz - halfZ - feather) / this.cellZ));
    const iz1 = Math.min(this.nz - 1, Math.ceil((cz + halfZ + feather) / this.cellZ));

    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = Math.abs(this.zAt(iz) - cz);
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = Math.abs(this.xAt(ix) - cx);
        // Elliptical, so the shore is a curve rather than a rectangle.
        const d = Math.hypot(dx / halfX, dz / halfZ);
        if (d > 1 + feather / Math.min(halfX, halfZ)) continue;
        const w = d <= 1 ? 1 : 1 - smoothstep(clamp((d - 1) / (feather / Math.min(halfX, halfZ)), 0, 1));
        if (w <= 0) continue;
        const i = this.idx(ix, iz);
        this.height[i] = lerp(this.height[i], surface, w);
        if (d < 1) {
          this.ice[i] = Math.max(this.ice[i], 1 - smoothstep(clamp((d - 0.72) / 0.28, 0, 1)));
          this.groom[i] = 0;
        }
      }
    }
    this.parkFeatures.lakes.push({ x: cx, z: cz, r: Math.min(halfX, halfZ), y: surface });
  }

  /**
   * Flatten out a base area: the plaza the trails feed into, a beginner apron
   * beside it, a car park, and (where the map asks for it) tubing lanes.
   *
   * A resort is mostly the bit at the bottom, and none of it can be built on
   * a hillside — lift terminals, buildings and parked cars all need ground
   * that's actually flat. So the terrain gets shaped first and props.js
   * assembles on top of what this leaves behind.
   */
  stampBaseArea() {
    const f = this.spec.features;

    // Skiers arrive wherever the trails end up, so put the plaza there.
    let arriveX = 0;
    for (const trail of this.trails) {
      arriveX += trail.samples[trail.samples.length - 1].x;
    }
    arriveX /= this.trails.length;

    // Lay the whole base out as one block and fit it to the map, rather than
    // hanging each piece off the plaza and hoping. Order across the hill is
    // tubing | beginner apron | plaza | car park.
    //
    // `features.base` overrides any of those positions with an explicit -1..1
    // across the face. A generated resort is happy to be laid out; a real one
    // has its beginner hill at one end and its tubing at the other, and no
    // amount of automatic packing will produce that by accident.
    const place = f.base || {};
    const lotHalfX = Math.min(105, this.halfW * 0.16);
    const learnHalfX = Math.min(95, this.halfW * 0.15);
    const tube = typeof f.tubing === 'number' ? { lanes: f.tubing } : f.tubing;
    const tubeLanes = tube ? clamp(Math.round(tube.lanes), 4, 14) : 0;
    // Tubing only eats into the layout budget when it's packed beside the
    // beginner apron. Placed explicitly, it's somewhere else entirely.
    const tubeW = tubeLanes && place.tubingX === undefined ? tubeLanes * TUBE_LANE_W : 0;

    const margin = 30;
    const fixed = 20 + 2 * learnHalfX + (tubeW ? 26 + tubeW : 0) + 34 + 2 * lotHalfX;
    const plazaHalf = clamp((2 * this.halfW - 2 * margin - fixed) / 2, 70, Math.min(this.halfW * 0.4, 250));

    // Which side the car park goes on: whichever has more room to spare.
    const side = arriveX > 0 ? -1 : 1;   // lot side
    const learnReach = plazaHalf + 20 + 2 * learnHalfX + (tubeW ? 26 + tubeW : 0);
    const lotReach = plazaHalf + 34 + 2 * lotHalfX;
    const cx = place.x !== undefined
      ? clamp(place.x * this.halfW, -this.halfW + margin + plazaHalf, this.halfW - margin - plazaHalf)
      : clamp(
        arriveX,
        -this.halfW + margin + (side > 0 ? learnReach : lotReach),
        this.halfW - margin - (side > 0 ? lotReach : learnReach),
      );

    // Cap the plaza's depth. As a fraction of run length it grew to half a
    // kilometre on the big maps, which is a field, not a base area.
    // Depth is bounded both ways. As a pure fraction it became half a
    // kilometre on the big maps and barely 80 m on a short hill — and a base
    // area has an absolute minimum size, because a lodge and a car park do.
    const z1 = this.length * 0.995;
    const z0 = z1 - clamp(this.length * 0.15, 150, 240);
    // Sit the plaza a little below where the runs come in so they spill onto
    // it rather than running into a step.
    const plazaY = this.heightAt(cx, z0) - 7;
    const drain = 0.022;

    const flatten = (x, z, targetY, halfX, halfZ, feather, mark) => {
      const ix0 = Math.max(0, Math.floor((x - halfX - feather + this.halfW) / this.cellX));
      const ix1 = Math.min(this.nx - 1, Math.ceil((x + halfX + feather + this.halfW) / this.cellX));
      const iz0 = Math.max(0, Math.floor((z - halfZ - feather) / this.cellZ));
      const iz1 = Math.min(this.nz - 1, Math.ceil((z + halfZ + feather) / this.cellZ));

      for (let iz = iz0; iz <= iz1; iz++) {
        const dz = Math.abs(this.zAt(iz) - z);
        const wz = dz <= halfZ ? 1 : 1 - smoothstep(clamp((dz - halfZ) / feather, 0, 1));
        if (wz <= 0) continue;
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = Math.abs(this.xAt(ix) - x);
          const wx = dx <= halfX ? 1 : 1 - smoothstep(clamp((dx - halfX) / feather, 0, 1));
          const w = wx * wz;
          if (w <= 0) continue;
          const i = this.idx(ix, iz);
          const target = typeof targetY === 'function' ? targetY(this.xAt(ix), this.zAt(iz)) : targetY;
          this.height[i] = lerp(this.height[i], target, w);
          if (mark) mark(i, w);
        }
      }
    };

    const plazaZc = (z0 + z1) / 2;
    const plazaHalfZ = (z1 - z0) / 2;
    flatten(cx, plazaZc, (px, pz) => plazaY - (pz - z0) * drain, plazaHalf, plazaHalfZ, 55,
      (i, w) => { this.groom[i] = Math.max(this.groom[i], w); this.carve[i] = Math.max(this.carve[i], w * 0.6); });

    // ── car park, off to one side and a step down from the snow
    const lotSide = side;
    const lotX = place.lotX !== undefined
      ? clamp(place.lotX * this.halfW, -this.halfW + lotHalfX + 10, this.halfW - lotHalfX - 10)
      : cx + lotSide * (plazaHalf + lotHalfX + 34);
    const lotY = plazaY - 3.5;
    const lotZc = plazaZc + plazaHalfZ * 0.12;
    const lotHalfZ = plazaHalfZ * 0.85;
    flatten(lotX, lotZc, lotY, lotHalfX, lotHalfZ, 22,
      (i, w) => { if (w > 0.75) { this.paved[i] = 1; this.groom[i] = 0; } });

    // ── beginner apron on the other side, gentle enough for a first run
    const learnSide = -lotSide;
    const learnX = place.learnX !== undefined
      ? clamp(place.learnX * this.halfW, -this.halfW + learnHalfX + 10, this.halfW - learnHalfX - 10)
      : cx + learnSide * (plazaHalf + learnHalfX + 20);
    const learnZ1 = z0 + 20;
    const learnZ0 = learnZ1 - Math.min(230, this.length * 0.16);
    const learnTop = plazaY + (learnZ1 - learnZ0) * 0.13;
    flatten(
      learnX, (learnZ0 + learnZ1) / 2,
      (px, pz) => lerp(learnTop, plazaY, clamp((pz - learnZ0) / (learnZ1 - learnZ0), 0, 1)),
      learnHalfX, (learnZ1 - learnZ0) / 2, 38,
      (i, w) => { this.groom[i] = Math.max(this.groom[i], w); this.carve[i] = Math.max(this.carve[i], w * 0.7); },
    );

    this.baseArea = {
      x: cx, y: plazaY, z0, z1, halfW: plazaHalf, drain,
      lot: { x: lotX, y: lotY, z: lotZc, halfX: lotHalfX, halfZ: lotHalfZ },
      learn: { x: learnX, z0: learnZ0, z1: learnZ1, halfX: learnHalfX, topY: learnTop, botY: plazaY },
      tubing: null,
    };

    if (tubeLanes) this.stampTubing(learnSide, tubeLanes, place.tubingX);
  }

  /** Parallel tubing lanes with raised dividers, beside the beginner area. */
  stampTubing(side, lanes, atX) {
    const b = this.baseArea;
    const laneW = TUBE_LANE_W;
    const totalW = lanes * laneW;
    const margin = totalW / 2 + 20;
    const cx = atX !== undefined
      ? clamp(atX * this.halfW, -this.halfW + margin, this.halfW - margin)
      : b.learn.x + side * (b.learn.halfX + totalW / 2 + 26);

    const z1 = b.z0 + 10;
    const z0 = z1 - Math.min(200, this.length * 0.14);
    const topY = b.y + (z1 - z0) * 0.17;

    const ix0 = Math.max(0, Math.floor((cx - totalW / 2 - 14 + this.halfW) / this.cellX));
    const ix1 = Math.min(this.nx - 1, Math.ceil((cx + totalW / 2 + 14 + this.halfW) / this.cellX));
    const iz0 = Math.max(0, Math.floor((z0 - 20) / this.cellZ));
    const iz1 = Math.min(this.nz - 1, Math.ceil((z1 + 20) / this.cellZ));

    for (let iz = iz0; iz <= iz1; iz++) {
      const z = this.zAt(iz);
      const tz = clamp((z - z0) / (z1 - z0), 0, 1);
      const ramp = smoothstep(clamp((z - z0 + 20) / 20, 0, 1)) * (1 - smoothstep(clamp((z - z1) / 20, 0, 1)));
      if (ramp <= 0) continue;
      const laneY = lerp(topY, b.y, tz);

      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.xAt(ix);
        const du = x - cx + totalW / 2;
        if (du < -14 || du > totalW + 14) continue;
        const i = this.idx(ix, iz);

        // Sawtooth across the lanes: flat floor, low berm between each pair.
        const inLane = du >= 0 && du <= totalW;
        const phase = inLane ? (du % laneW) / laneW : 0;
        const berm = inLane ? Math.pow(Math.abs(Math.cos(phase * Math.PI)), 3) * 1.5 : 0;
        const edge = inLane ? 1 : 1 - smoothstep(clamp((du < 0 ? -du : du - totalW) / 14, 0, 1));

        this.height[i] = lerp(this.height[i], laneY + berm, ramp * edge);
        this.groom[i] = Math.max(this.groom[i], ramp * edge);
      }
    }

    this.baseArea.tubing = { x: cx, z0, z1, lanes, laneW, totalW, topY, botY: b.y };
  }

  /** Sample the trail-0 centreline at a normalised distance down the run. */
  centerlineAt(t) {
    const s = this.trails[0].samples;
    const i = clamp(Math.round(t * (s.length - 1)), 0, s.length - 1);
    return s[i];
  }

  stampPark(park) {
    const rng = makeRng(this.spec.seed ^ 0x9111 ^ (park.seed ?? 0));
    const huge = !!park.huge;

    // Keep the park clear of where the player drops in. On a short hill the
    // first kicker's landing used to sit right on the spawn, so you'd start
    // the run already at the bottom of a hole with no speed to climb out.
    const t0 = park.t0 ?? clamp((START_Z + 340) / this.length, 0.12, 0.45);
    const t1 = park.t1 ?? 0.88;
    const span = t1 - t0;

    // Where the lane sits across the hill. With no `x` a park follows the
    // first trail's centreline, which is right when the park *is* the run —
    // but a hill with two of them has to say where each one goes.
    const laneAt = park.x === undefined
      ? (t) => this.centerlineAt(t)
      : (t) => ({ x: clamp(park.x * this.halfW, -this.halfW + 60, this.halfW - 60), z: t * this.length });

    // ── kickers, spaced down the fall line
    for (let j = 0; j < park.jumps; j++) {
      const t = t0 + (j / Math.max(1, park.jumps)) * span + rng.range(-0.015, 0.015);
      const c = laneAt(t);
      const size = huge
        ? lerp(0.55, 1.0, j / Math.max(1, park.jumps - 1))
        : rng.range(0.32, 0.9);

      const L = lerp(7, huge ? 26 : 19, size);      // takeoff length
      const H = lerp(1.3, huge ? 5.6 : 3.8, size);  // lip height above grade
      const W = lerp(8, huge ? 20 : 15, size);      // deck width
      const lane = park.jumps > 3 ? ((j % 3) - 1) * (W * 1.5 + 6) : 0;
      const cx = clamp(c.x + lane, -this.halfW + W, this.halfW - W);
      const z0 = c.z;

      this.stampKicker(cx, z0, L, H, W);
      this.parkFeatures.jumps.push({ x: cx, z: z0 + L, h: H, w: W, len: L, size });
    }

    // ── rails, alternating sides of the lane
    for (let r = 0; r < park.rails; r++) {
      const t = t0 + (r / Math.max(1, park.rails)) * span + rng.range(-0.02, 0.02);
      const c = laneAt(t);
      const side = (r % 2 === 0 ? 1 : -1) * rng.range(10, 34);
      const len = rng.range(9, 20);
      const kind = rng.pick(['flat', 'flat', 'down', 'kink', 'box']);
      this.parkFeatures.rails.push({
        x: clamp(c.x + side, -this.halfW + 30, this.halfW - 30),
        z: c.z,
        len,
        kind,
        width: kind === 'box' ? 1.1 : 0.34,
        rise: kind === 'flat' || kind === 'box' ? 0 : rng.range(0.9, 2.0),
        post: rng.range(0.35, 0.95),
        skew: rng.range(-0.1, 0.1),
      });
    }

    if (park.pipe) this.stampPipe();
    for (let h = 0; h < (park.hips || 0); h++) {
      const c = laneAt(Math.min(0.95, t1 - 0.08 + h * 0.07));
      const side = h % 2 === 0 ? 1 : -1;
      this.stampKicker(c.x + side * 26, c.z, 12, 3.2, 16, side * 0.5);
    }
  }

  /**
   * A kicker: a curved takeoff ramp ending in an abrupt knuckle, with the
   * landing steepened just past it so you aren't dropping onto flat.
   */
  stampKicker(cx, z0, L, H, W, tilt = 0) {
    const halfW = W / 2;
    const feather = 3.2;
    const knuckle = 2.6;
    // Landing length scales with lip height so the run-out back to grade is
    // always gentler than the hill itself — see the profile note below.
    const landing = Math.max(24, H * 9);

    const ix0 = Math.max(0, Math.floor((cx - halfW - feather + this.halfW) / this.cellX));
    const ix1 = Math.min(this.nx - 1, Math.ceil((cx + halfW + feather + this.halfW) / this.cellX));
    const iz0 = Math.max(0, Math.floor((z0 - 5) / this.cellZ));
    const iz1 = Math.min(this.nz - 1, Math.ceil((z0 + L + knuckle + landing) / this.cellZ));

    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = this.zAt(iz) - z0;
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.xAt(ix);
        const du = Math.abs(x - cx);
        if (du > halfW + feather) continue;
        const edge = du <= halfW ? 1 : 1 - smoothstep((du - halfW) / feather);
        const i = this.idx(ix, iz);

        let delta = 0;
        if (dz >= -5 && dz <= L) {
          // ease the toe in, then a progressive transition up to the lip
          const t = clamp(dz / L, 0, 1);
          const toe = smoothstep(clamp((dz + 5) / 5, 0, 1));
          delta = H * Math.pow(t, 1.5) * toe;
        } else if (dz > L && dz <= L + knuckle) {
          delta = H * (1 - smoothstep((dz - L) / knuckle));
        } else if (dz > L + knuckle) {
          // Landing: drops away hard at the knuckle, then eases back to grade.
          //
          // It must be *monotonic*. A symmetric dip (down, then back up) digs
          // a bowl whose far wall is steeper than the slope, so anyone who
          // rolls over the lip slowly instead of jumping it coasts in and
          // stops dead. Decaying back to grade means the landing is always
          // downhill, however little speed you carried into it.
          const t = clamp((dz - L - knuckle) / landing, 0, 1);
          delta = -H * 0.8 * (1 - smoothstep(t));
        }

        if (tilt !== 0 && dz >= 0 && dz <= L) {
          delta += (x - cx) * tilt * clamp(dz / L, 0, 1) * 0.35;
        }

        this.height[i] += delta * edge;
        if (dz >= -5 && dz <= L + knuckle) {
          this.groom[i] = Math.max(this.groom[i], edge);
        }
      }
    }
  }

  /** A halfpipe cut into the lower third: flat bottom, circular transitions. */
  stampPipe() {
    const t0 = 0.74, t1 = 0.96;
    const a = this.centerlineAt(t0);
    const cx = a.x;
    const z0 = a.z;
    const z1 = this.centerlineAt(t1).z;
    const flatHalf = 8.5, wallW = 6.0, R = 5.2, deck = 5;
    const reach = flatHalf + wallW + deck;

    const ix0 = Math.max(0, Math.floor((cx - reach + this.halfW) / this.cellX));
    const ix1 = Math.min(this.nx - 1, Math.ceil((cx + reach + this.halfW) / this.cellX));
    const iz0 = Math.max(0, Math.floor(z0 / this.cellZ));
    const iz1 = Math.min(this.nz - 1, Math.ceil(z1 / this.cellZ));

    for (let iz = iz0; iz <= iz1; iz++) {
      const z = this.zAt(iz);
      const tz = (z - z0) / Math.max(1, z1 - z0);
      // ease the pipe in and out so the entry and exit are skiable
      const ramp = smoothstep(clamp(tz / 0.06, 0, 1)) * (1 - smoothstep(clamp((tz - 0.9) / 0.1, 0, 1)));
      const floorH = this.heightAt(cx, z);

      for (let ix = ix0; ix <= ix1; ix++) {
        const x = this.xAt(ix);
        const du = Math.abs(x - cx);
        if (du > reach) continue;
        const i = this.idx(ix, iz);

        let target;
        if (du <= flatHalf) {
          target = floorH;
        } else if (du <= flatHalf + wallW) {
          const u = (du - flatHalf) / wallW;
          target = floorH + R * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
        } else {
          const u = clamp((du - flatHalf - wallW) / deck, 0, 1);
          target = floorH + R + 0.5 + u * 0.4;
        }

        this.height[i] = lerp(this.height[i], target, ramp);
        this.groom[i] = Math.max(this.groom[i], ramp);
      }
    }

    this.parkFeatures.pipe = { cx, z0, z1, flatHalf, wallW, R };
  }

  /**
   * Bare ice across whole altitude bands, rather than the discrete tarns
   * `stampLakes` makes.
   *
   * A face of blue glacial ice is a *surface*, not a feature sitting on the
   * surface — it spans the full width of the mountain between two heights and
   * changes how everything about that section skis. Friction drops to almost
   * nothing, edges stop holding, and the audio goes glassy and chattery,
   * which the existing ice channel already handles once the field is there.
   */
  stampIceField(bands) {
    for (const band of bands) {
      const z0 = band.t0 * this.length;
      const z1 = band.t1 * this.length;
      const feather = Math.max(30, (z1 - z0) * 0.14);
      const amount = band.amount ?? 1;

      const iz0 = Math.max(0, Math.floor((z0 - feather) / this.cellZ));
      const iz1 = Math.min(this.nz - 1, Math.ceil((z1 + feather) / this.cellZ));

      for (let iz = iz0; iz <= iz1; iz++) {
        const z = this.zAt(iz);
        const inBand = smoothstep(clamp((z - z0 + feather) / feather, 0, 1))
                     * (1 - smoothstep(clamp((z - z1) / feather, 0, 1)));
        if (inBand <= 0.01) continue;

        for (let ix = 0; ix < this.nx; ix++) {
          const i = this.idx(ix, iz);
          // Wind scours the open face hardest; sheltered pockets hold snow.
          const patchy = 0.68 + 0.32 * (this.detail.fbm(this.xAt(ix) / 110, z / 150, 3) * 0.5 + 0.5);
          const v = amount * inBand * patchy;
          if (v > this.ice[i]) this.ice[i] = v;
        }
      }
    }
  }

  /** Frozen tarns in the flat benches between pitches. */
  stampLakes() {
    const rng = makeRng(this.spec.seed ^ 0x1a4e);
    const candidates = [];
    for (let t = 0.15; t < 0.92; t += 0.02) {
      if (this.gradientAt(t) < 0.16) candidates.push(t);
    }
    if (!candidates.length) return;

    const picks = [];
    for (const t of candidates) {
      if (picks.length && Math.abs(picks[picks.length - 1] - t) < 0.1) continue;
      picks.push(t);
    }

    for (const t of picks.slice(0, 4)) {
      const c = this.centerlineAt(t);
      const radius = rng.range(55, 115);
      const cx = clamp(c.x + rng.range(-1, 1) * radius * 1.4, -this.halfW + radius, this.halfW - radius);
      const cz = c.z;

      // Lake surface sits at the lowest point in the basin.
      let lowest = Infinity;
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        lowest = Math.min(lowest, this.heightAt(cx + Math.cos(ang) * radius * 0.6, cz + Math.sin(ang) * radius * 0.6));
      }
      lowest = Math.min(lowest, this.heightAt(cx, cz)) - 0.6;

      const ix0 = Math.max(0, Math.floor((cx - radius * 1.3 + this.halfW) / this.cellX));
      const ix1 = Math.min(this.nx - 1, Math.ceil((cx + radius * 1.3 + this.halfW) / this.cellX));
      const iz0 = Math.max(0, Math.floor((cz - radius * 1.3) / this.cellZ));
      const iz1 = Math.min(this.nz - 1, Math.ceil((cz + radius * 1.3) / this.cellZ));

      for (let iz = iz0; iz <= iz1; iz++) {
        const dz = this.zAt(iz) - cz;
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = this.xAt(ix) - cx;
          const d = Math.hypot(dx, dz) / radius;
          if (d > 1.3) continue;
          const i = this.idx(ix, iz);
          const w = 1 - smoothstep(clamp((d - 0.7) / 0.6, 0, 1));
          this.height[i] = lerp(this.height[i], lowest, w);
          if (d < 0.85) this.ice[i] = Math.max(this.ice[i], 1 - smoothstep(clamp((d - 0.6) / 0.25, 0, 1)));
        }
      }
      this.parkFeatures.lakes.push({ x: cx, z: cz, r: radius, y: lowest });
    }
  }

  /** One light box blur on groomed areas only — corduroy is smooth. */
  smoothPass() {
    const src = this.height.slice();
    for (let iz = 1; iz < this.nz - 1; iz++) {
      for (let ix = 1; ix < this.nx - 1; ix++) {
        const i = this.idx(ix, iz);
        const g = this.groom[i];
        if (g < 0.05) continue;
        const avg =
          (src[i] * 4 +
            src[i - 1] + src[i + 1] +
            src[i - this.nx] + src[i + this.nx]) / 8;
        this.height[i] = lerp(src[i], avg, g * 0.55);
      }
    }
  }

  /**
   * Moguls, applied *after* the smoothing pass — smoothing groomed terrain is
   * what makes corduroy look groomed, but it also flattens bumps, and a mogul
   * field that's been blurred out is just a hill.
   *
   * The wavelength is floored at four grid cells. Below that the heightfield
   * can't represent a bump at all: you get aliasing instead of moguls.
   */
  stampMoguls() {
    const { moguls } = this.spec;
    if (!moguls.amount) return;

    const wavelength = Math.max(moguls.wavelength, this.cell * 4);
    const amp = moguls.amount * wavelength * 0.2;
    const k = (Math.PI * 2) / wavelength;

    // The base area is machine-flat by definition — nobody moguls up a plaza.
    const baseZ = this.baseArea ? this.baseArea.z0 - 60 : Infinity;

    for (let iz = 0; iz < this.nz; iz++) {
      const z = this.zAt(iz);
      const nearBase = z > baseZ ? 1 - smoothstep(clamp((z - baseZ) / 60, 0, 1)) : 1;
      if (nearBase <= 0.01) continue;
      for (let ix = 0; ix < this.nx; ix++) {
        const i = this.idx(ix, iz);
        if (this.paved[i] > 0.05) continue;
        const x = this.xAt(ix);
        // Bumps build up where people turn, so they follow the skied surface.
        const field = (0.3 + 0.7 * this.groom[i]) * nearBase;
        if (field < 0.05) continue;

        const jitter = this.detail.sample(x / 60, z / 60) * 1.4;
        const bump =
          Math.sin(x * k + jitter) * Math.sin(z * k * 0.86 + jitter * 1.7) +
          0.45 * Math.sin((x + z) * k * 0.63 - jitter);
        this.height[i] += bump * amp * field * this.topFade(z);
      }
    }
  }

  /** Anything steeper than ~48° sheds snow and shows rock. */
  computeRock() {
    const nrm = new THREE.Vector3();
    // Strata outcrop across the whole face, not just where it happens to be
    // steep enough to shed snow. Recolouring slope-derived rock wasn't enough
    // — on a carved corridor there is no rock to recolour, so the band simply
    // vanished exactly where you ski through it.
    const bands = this.spec.features.rockBands;

    for (let iz = 0; iz < this.nz; iz++) {
      const tz = iz / Math.max(1, this.nz - 1);
      let bandAmt = 0;
      if (bands) {
        for (const b of bands) {
          if (tz < b.t0 || tz > b.t1) continue;
          const span = Math.max(1e-4, b.t1 - b.t0);
          // Fade in and out so the seam has edges rather than borders.
          const u = (tz - b.t0) / span;
          bandAmt = Math.max(bandAmt, (b.amount ?? 0.75) * Math.sin(u * Math.PI) ** 0.6);
        }
      }

      for (let ix = 0; ix < this.nx; ix++) {
        const i = this.idx(ix, iz);
        this.normalAtIndex(ix, iz, nrm);
        const steep = 1 - nrm.y;
        const t = smoothstep(clamp((steep - 0.24) / 0.22, 0, 1));
        const grit = this.detail.sample(this.xAt(ix) / 40, this.zAt(iz) / 40) * 0.18;
        let rockV = clamp(t + grit * t, 0, 1) * (1 - this.groom[i] * 0.85);
        if (bandAmt > 0) {
          const broken = 0.55 + 0.45 * (this.detail.sample(this.xAt(ix) / 55, this.zAt(iz) / 34) * 0.5 + 0.5);
          rockV = Math.max(rockV, bandAmt * broken);
        }
        this.rock[i] = rockV;
        // Exposed rock isn't iced over — whichever wins, wins.
        if (this.ice[i] > 0) this.ice[i] *= 1 - this.rock[i];
      }
    }
  }

  // ── sampling API ────────────────────────────────────────────────
  normalAtIndex(ix, iz, out) {
    const x0 = Math.max(0, ix - 1), x1 = Math.min(this.nx - 1, ix + 1);
    const z0 = Math.max(0, iz - 1), z1 = Math.min(this.nz - 1, iz + 1);
    const dhx = (this.height[this.idx(x1, iz)] - this.height[this.idx(x0, iz)]) /
                ((x1 - x0) * this.cellX);
    const dhz = (this.height[this.idx(ix, z1)] - this.height[this.idx(ix, z0)]) /
                ((z1 - z0) * this.cellZ);
    return out.set(-dhx, 1, -dhz).normalize();
  }

  /** Bilinear height. Matches the rendered mesh closely enough for physics. */
  heightAt(x, z) {
    const fx = clamp((x + this.halfW) / this.cellX, 0, this.nx - 1.001);
    const fz = clamp(z / this.cellZ, 0, this.nz - 1.001);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const h = this.height;
    const i00 = this.idx(ix, iz);
    const h00 = h[i00], h10 = h[i00 + 1];
    const h01 = h[i00 + this.nx], h11 = h[i00 + this.nx + 1];
    return lerp(lerp(h00, h10, tx), lerp(h01, h11, tx), tz);
  }

  /**
   * Where you start your day at a resort: out on the plaza, a short skate
   * from the lifts. Deliberately not right on top of a terminal — arriving
   * somewhere and setting off is half of what a base area is for.
   */
  basePoint() {
    const b = this.baseArea;
    return { x: b.x - b.halfW * 0.28, z: b.z0 + (b.z1 - b.z0) * 0.44 };
  }

  /**
   * Heading that points straight down the hill at (x, z).
   *
   * `normalAt` returns (-dh/dx, 1, -dh/dz), so the direction of steepest
   * descent is (+n.x, +n.z) — *not* the negated pair, which is the natural
   * thing to reach for and points you straight back up the mountain. Both the
   * bot AI and crash recovery got this wrong independently, so it lives here
   * once now instead of being rederived at each call site.
   */
  fallLineHeading(x, z) {
    const n = this.normalAt(x, z, _fallNormal);
    if (Math.abs(n.x) + Math.abs(n.z) < 1e-4) return 0;
    return Math.atan2(n.x, n.z);
  }

  normalAt(x, z, out = new THREE.Vector3()) {
    const e = Math.max(1.5, this.cell * 0.6);
    const hL = this.heightAt(x - e, z), hR = this.heightAt(x + e, z);
    const hD = this.heightAt(x, z - e), hU = this.heightAt(x, z + e);
    return out.set((hL - hR) / (2 * e), 1, (hD - hU) / (2 * e)).normalize();
  }

  sampleField(field, x, z) {
    const fx = clamp((x + this.halfW) / this.cellX, 0, this.nx - 1.001);
    const fz = clamp(z / this.cellZ, 0, this.nz - 1.001);
    const ix = fx | 0, iz = fz | 0;
    const tx = fx - ix, tz = fz - iz;
    const i00 = this.idx(ix, iz);
    return lerp(
      lerp(field[i00], field[i00 + 1], tx),
      lerp(field[i00 + this.nx], field[i00 + this.nx + 1], tx),
      tz,
    );
  }

  groomAt(x, z) { return this.sampleField(this.groom, x, z); }
  rockAt(x, z) { return this.sampleField(this.rock, x, z); }
  iceAt(x, z) { return this.sampleField(this.ice, x, z); }
  pavedAt(x, z) { return this.sampleField(this.paved, x, z); }

  /**
   * What you're standing on, in the terms the physics and audio care about.
   * `deep` is how far the skis sink; `hard` is scoured ice or rock.
   */
  surfaceAt(x, z) {
    const groom = this.groomAt(x, z);
    const ice = this.iceAt(x, z);
    const paved = this.pavedAt(x, z);
    const rock = Math.max(this.rockAt(x, z), paved);
    const deepBase = this.spec.features.deep ?? 0.34;
    const deep = clamp((1 - groom) * deepBase * (1 - ice) * (1 - rock * 0.8), 0, 0.85);
    return { groom, ice, rock, deep, paved };
  }

  /**
   * Is this inside the developed base area? Used to keep trees and boulders
   * out of the car park and the tubing lanes — the groom mask alone doesn't
   * cover it, because paved ground is deliberately *not* groomed snow.
   */
  inBaseArea(x, z, margin = 12) {
    const b = this.baseArea;
    if (!b) return false;
    const inRect = (cx, cz, hx, hz) =>
      Math.abs(x - cx) < hx + margin && Math.abs(z - cz) < hz + margin;

    if (inRect(b.x, (b.z0 + b.z1) / 2, b.halfW, (b.z1 - b.z0) / 2)) return true;
    if (inRect(b.lot.x, b.lot.z, b.lot.halfX, b.lot.halfZ)) return true;
    if (inRect(b.learn.x, (b.learn.z0 + b.learn.z1) / 2, b.learn.halfX, (b.learn.z1 - b.learn.z0) / 2)) return true;
    if (b.tubing && inRect(b.tubing.x, (b.tubing.z0 + b.tubing.z1) / 2, b.tubing.totalW / 2, (b.tubing.z1 - b.tubing.z0) / 2)) return true;
    return false;
  }

  insideBounds(x, z) {
    return Math.abs(x) < this.halfW - 8 && z > -20 && z < this.length - 4;
  }

  /**
   * Where the player drops in: on the trail, past the summit rollover, and on
   * ground that actually falls away. On the big open maps the relief noise can
   * easily leave a flat shelf right where you'd otherwise spawn, and standing
   * still on a flat waiting for gravity is a poor first impression.
   */
  startPoint() {
    // Props resolve the exact spot once the lifts exist; without this, R would
    // drop you back on the plaza a long skate from where you actually began.
    if (this.spawnOverride) return this.spawnOverride;

    // At a resort you arrive at the bottom and ride up, like anyone would.
    if (this.baseArea) return this.basePoint();

    // Start on whichever run begins highest — on a map with named runs the
    // first in the list is wherever the trail map put it, not the summit.
    let route = this.trails[0];
    for (const t of this.trails) {
      if (t.samples[0].z < route.samples[0].z) route = t;
    }
    const samples = route.samples;

    // Search window scales with the mountain. A fixed 320 m is a fifth of a
    // big resort but more than half of a short hill, and on the short one it
    // will happily spawn you two thirds of the way down.
    const window = Math.min(320, this.length * 0.22);
    const n = new THREE.Vector3();
    let best = null, bestSteep = -1;

    for (const p of samples) {
      if (p.z < START_Z) continue;
      if (p.z > START_Z + window) break;
      this.normalAt(p.x, p.z, n);
      // Prefer the steepest candidate that isn't a cliff, and weight toward
      // the top so you don't get dropped in a third of the way down.
      const steep = (1 - n.y) * (n.y > 0.72 ? 1 : 0.15) - (p.z - START_Z) * 0.00004;
      if (steep > bestSteep) { bestSteep = steep; best = p; }
    }

    const p = best || samples[0];
    return { x: p.x, z: Math.max(START_Z, p.z) };
  }

  // ── 4. mesh ─────────────────────────────────────────────────────
  buildMesh() {
    const { nx, nz } = this;
    const vcount = nx * nz;
    const pos = new Float32Array(vcount * 3);
    const nor = new Float32Array(vcount * 3);
    const col = new Float32Array(vcount * 3);
    const gro = new Float32Array(vcount);

    // Snow albedo is deliberately well under 1. Real snow is ~0.85, and
    // painting it at 0.97 under a 2+ intensity sun pushes every lit pixel into
    // the tone mapper's shoulder, where shading differences vanish and the
    // whole mountain reads as a flat white sheet. The shadow colour is a
    // genuine blue rather than off-white for the same reason.
    const rockCol = new THREE.Color(this.spec.weather === 'ashfall' ? 0x35302f : 0x6b645c);
    const rockCol2 = new THREE.Color(this.spec.weather === 'ashfall' ? 0x211e1f : 0x4a443e);
    const snow = new THREE.Color(0xdae5f4);
    const snowShade = new THREE.Color(0x8ba5c8);
    const groomed = new THREE.Color(0xe6edf8);
    const iceCol = new THREE.Color(0x8fb6d4);
    const asphalt = new THREE.Color(0x33363c);
    const tmp = new THREE.Color();
    const nrm = new THREE.Vector3();

    // Leaf litter and scrub showing through the snow off-piste.
    //
    // A snowmaking hill only makes snow where it grooms. Between the cut runs
    // the ground is whatever the weather left on last autumn's leaves, and on a
    // hardwood hill that is brown — which is exactly how a trail map draws the
    // woods, and the reason the islands between the runs are legible on one at
    // all. Without this the timber is bare trunks standing on white, the ground
    // under them is the same colour as the corduroy beside them, and a face cut
    // into fourteen separate runs still reads as one open snowfield.
    const under = this.spec.features.undergrowth;
    const underCol = under ? new THREE.Color(under.color ?? 0x7d6b4f) : null;
    const underAmt = under ? (under.amount ?? 0.55) : 0;
    const litterShade = new THREE.Color(0x413826);
    const shadeCol = new THREE.Color();

    // Strata: some mountains have rock of a different colour at a particular
    // height. Everest's Yellow Band is a seam of pale limestone at ~7,600 m
    // that you can pick out from kilometres away.
    const bands = this.spec.features.rockBands;
    const bandCols = bands ? bands.map((b) => new THREE.Color(b.color)) : null;
    const bandAt = (tz) => {
      if (!bands) return null;
      for (let i = 0; i < bands.length; i++) {
        if (tz >= bands[i].t0 && tz <= bands[i].t1) return bandCols[i];
      }
      return null;
    };

    for (let iz = 0; iz < nz; iz++) {
      const bandCol = bandAt(iz / Math.max(1, nz - 1));
      for (let ix = 0; ix < nx; ix++) {
        const i = this.idx(ix, iz);
        const o = i * 3;
        pos[o] = this.xAt(ix);
        pos[o + 1] = this.height[i];
        pos[o + 2] = this.zAt(iz);

        this.normalAtIndex(ix, iz, nrm);
        nor[o] = nrm.x; nor[o + 1] = nrm.y; nor[o + 2] = nrm.z;

        const g = this.groom[i];
        const r = this.rock[i];
        const ice = this.ice[i];
        gro[i] = g * (1 - ice);

        // Snow reads bluer where it is shaded or wind-scoured. The curvature
        // term is the important one: on a near-white surface under a low sun,
        // diffuse lighting alone barely distinguishes a mogul from a flat, so
        // hollows get tinted blue and crests get lifted. Without it the whole
        // mountain reads as a featureless sheet.
        const mottle = this.detail.sample(pos[o] / 26, pos[o + 2] / 26) * 0.5 + 0.5;
        let curv = 0;
        if (ix > 0 && ix < nx - 1 && iz > 0 && iz < nz - 1) {
          const avg = (this.height[i - 1] + this.height[i + 1] +
                       this.height[i - nx] + this.height[i + nx]) * 0.25;
          curv = clamp((this.height[i] - avg) / (this.cell * 0.28), -1, 1);
        }
        const shade = clamp((1 - nrm.y) * 2.2, 0, 1) * 0.42
                    + mottle * 0.14
                    + clamp(-curv, 0, 1) * 0.5;
        // How much bare ground shows here. Patchy on the same clumping field
        // the trees are scattered with, so the brown lands where the woods are
        // rather than evenly over every metre the groomer missed.
        let litter = 0;
        if (underCol && g < 0.5) {
          const clump = clamp(this.noise.fbm(pos[o] / 220, pos[o + 2] / 220, 3) * 0.5 + 0.5, 0, 1);
          // The clump only modulates the tint, it doesn't gate it: bare ground
          // between the runs is bare everywhere, thicker where the woods are
          // thicker. Letting it run down to a third turned the average mix into
          // a light wash that read as blue-grey snow.
          litter = clamp((1 - g * 2) * underAmt * (0.62 + clump * 0.5) * (1 - this.paved[i]), 0, 1);
        }
        tmp.copy(g > 0.02 ? groomed : snow);
        if (litter > 0.01) tmp.lerp(underCol, litter);
        // Snow in shadow goes blue, because it is lit by the sky rather than
        // the sun. Leaf litter in shadow just goes dark — running it through
        // the same blue put the woods at a flat grey barely distinguishable
        // from the corduroy, which defeats the point of colouring them at all.
        //
        // Most of `shade` is backed off under litter as well, and the curvature
        // term is the reason. That term exists because a near-white surface
        // shows no shape under diffuse light, so hollows have to be tinted by
        // hand — brown ground has its own albedo variation and needs none of
        // it. Left at full strength it swamped the tint: off-piste averaged a
        // flat grey whatever colour it was mixed from.
        tmp.lerp(litter > 0.01 ? shadeCol.copy(snowShade).lerp(litterShade, litter) : snowShade,
                 clamp(shade, 0, 1) * (1 - litter * 0.82));
        if (curv > 0) tmp.offsetHSL(0, 0, curv * 0.07);
        if (r > 0.01) {
          const base = bandCol || (mottle > 0.5 ? rockCol : rockCol2);
          tmp.lerp(base, smoothstep(r));
        }
        if (ice > 0.01) tmp.lerp(iceCol, ice * (0.55 + mottle * 0.35));
        const pv = this.paved[i];
        if (pv > 0.01) tmp.lerp(asphalt, pv * (0.85 + mottle * 0.15));

        col[o] = tmp.r; col[o + 1] = tmp.g; col[o + 2] = tmp.b;
      }
    }

    const IndexArray = vcount > 65535 ? Uint32Array : Uint16Array;
    const idxArr = new IndexArray((nx - 1) * (nz - 1) * 6);
    let p = 0;
    for (let iz = 0; iz < nz - 1; iz++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = this.idx(ix, iz);
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        idxArr[p++] = a; idxArr[p++] = c; idxArr[p++] = b;
        idxArr[p++] = b; idxArr[p++] = c; idxArr[p++] = d;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aGroom', new THREE.BufferAttribute(gro, 1));
    geo.setIndex(new THREE.BufferAttribute(idxArr, 1));
    geo.computeBoundingSphere();

    this.geometry = geo;
    return geo;
  }

  dispose() {
    this.geometry?.dispose();
  }
}
