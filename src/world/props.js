// Everything on the mountain that isn't the mountain: trees, rocks, chairlifts,
// lodges, signage, park rails, seracs and lights.
//
// Trees and rocks are instanced *per spatial tile* rather than as one giant
// InstancedMesh. Instancing alone gives you one draw call but zero culling —
// tiling gets both, at the cost of a few dozen draw calls.

import * as THREE from 'three';
import { makeRng, clamp, lerp, smoothstep } from '../core/math.js';
import { DIFFICULTY } from './maps.js';
import { BaseArea } from './basearea.js';
import {
  makeFoliageMaterial, makeRockMaterial,
  makeMetalMaterial, makePaintMaterial, updateFoliage,
} from './materials.js';

// Spatial tiling for instanced props. Instancing alone gives one draw call and
// zero culling; tiling gets both. The size is a trade: small tiles cull well
// when you're close, but standing at the summit looking down the fall line
// puts nearly every tile in frustum at once, and then the tile count *is* the
// draw call count. These are sized for that view. Rocks are sparser and
// smaller than trees, so they tile coarser still.
const TILE = 460;
const ROCK_TILE = 920;

// Roughly how tall each species stands, at scale 1. Used for collision: an
// obstacle you've cleared shouldn't still knock you over.
const TREE_HEIGHT = { pine: 11.7, fir: 12.6, cedar: 9.2, bare: 7.4, larch: 10.4 };

/** Pick from `items` with the relative weights in `weights`. */
function pickWeighted(rng, items, weights) {
  let total = 0;
  for (let i = 0; i < items.length; i++) total += weights[i] ?? 1;
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i] ?? 1;
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

// ── geometry merge helper ─────────────────────────────────────────
/** Merge simple geometries into one non-indexed, vertex-coloured buffer. */
function mergeParts(parts) {
  let total = 0;
  const prepared = parts.map(({ geo, matrix, color, snowTint = 0 }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    return { g, color: new THREE.Color(color), snowTint };
  });

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  const white = new THREE.Color(0xf4f8ff);
  const tmp = new THREE.Color();

  for (const { g, color, snowTint } of prepared) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const c = g.attributes.position.count;
    let maxY = -Infinity, minY = Infinity;
    if (snowTint > 0) {
      for (let i = 0; i < c; i++) {
        const y = p[i * 3 + 1];
        if (y > maxY) maxY = y;
        if (y < minY) minY = y;
      }
    }
    for (let i = 0; i < c; i++) {
      const oi = (o + i) * 3;
      pos[oi] = p[i * 3]; pos[oi + 1] = p[i * 3 + 1]; pos[oi + 2] = p[i * 3 + 2];
      nor[oi] = n[i * 3]; nor[oi + 1] = n[i * 3 + 1]; nor[oi + 2] = n[i * 3 + 2];
      tmp.copy(color);
      if (snowTint > 0) {
        // Snow settles on the upper, up-facing parts of a branch.
        const t = (p[i * 3 + 1] - minY) / Math.max(1e-3, maxY - minY);
        const facing = clamp(n[i * 3 + 1], 0, 1);
        tmp.lerp(white, clamp(t * 0.8 + 0.2, 0, 1) * facing * snowTint);
      }
      col[oi] = tmp.r; col[oi + 1] = tmp.g; col[oi + 2] = tmp.b;
    }
    o += c;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  return out;
}

const mat4 = (px, py, pz, sx = 1, sy = 1, sz = 1, ry = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry),
    new THREE.Vector3(sx, sy, sz),
  );

/** Place a limb: a cylinder built along +Y, tilted out and around. */
const limb = (len, r0, r1, x, y, z, tilt, around, color, snowTint = 0) => ({
  geo: new THREE.CylinderGeometry(r1, r0, len, 4),
  matrix: new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, around, tilt, 'YZX')),
    new THREE.Vector3(1, 1, 1),
  ).multiply(new THREE.Matrix4().makeTranslation(0, len / 2, 0)),
  color,
  snowTint,
});

// ── tree species ──────────────────────────────────────────────────
const SPECIES = {
  pine: {
    build: () => {
      const parts = [];
      parts.push({ geo: new THREE.CylinderGeometry(0.22, 0.4, 4.2, 6), matrix: mat4(0, 2.1, 0), color: 0x4a3524 });
      const tiers = [
        { y: 3.4, r: 2.9, h: 4.2 },
        { y: 5.9, r: 2.2, h: 4.0 },
        { y: 8.1, r: 1.4, h: 3.6 },
      ];
      for (const t of tiers) {
        parts.push({
          geo: new THREE.ConeGeometry(t.r, t.h, 7),
          matrix: mat4(0, t.y + t.h / 2, 0),
          color: 0x2f5f3e, snowTint: 0.4,
        });
      }
      return parts;
    },
  },
  fir: {
    build: () => {
      const parts = [];
      parts.push({ geo: new THREE.CylinderGeometry(0.18, 0.34, 5.0, 6), matrix: mat4(0, 2.5, 0), color: 0x3d2c1e });
      const tiers = [
        { y: 2.6, r: 2.3, h: 4.4 },
        { y: 5.0, r: 1.85, h: 4.2 },
        { y: 7.3, r: 1.35, h: 3.9 },
        { y: 9.4, r: 0.85, h: 3.2 },
      ];
      for (const t of tiers) {
        parts.push({
          geo: new THREE.ConeGeometry(t.r, t.h, 7),
          matrix: mat4(0, t.y + t.h / 2, 0),
          color: 0x22432f, snowTint: 0.5,
        });
      }
      return parts;
    },
  },
  cedar: {
    build: () => {
      const parts = [];
      parts.push({ geo: new THREE.CylinderGeometry(0.35, 0.62, 3.2, 6), matrix: mat4(0, 1.6, 0), color: 0x533a28 });
      const tiers = [
        { y: 2.2, r: 3.6, h: 3.4 },
        { y: 4.3, r: 2.7, h: 3.2 },
        { y: 6.2, r: 1.6, h: 3.0 },
      ];
      for (const t of tiers) {
        parts.push({
          geo: new THREE.ConeGeometry(t.r, t.h, 8),
          matrix: mat4(0, t.y + t.h / 2, 0),
          color: 0x35604a, snowTint: 0.32,
        });
      }
      return parts;
    },
  },
  /**
   * Bare winter hardwood. Midwest ski hills are cut through deciduous woods,
   * not conifers — planting firs on an Indiana hill reads as the wrong
   * continent. No canopy, just a trunk and a spray of branches with snow
   * sitting on the upper sides.
   */
  bare: {
    build: () => {
      // Bark, at the value it reads from across a valley rather than the value
      // it reads from arm's length. Wet oak bark really is near-black, but a
      // hillside of it at six-metre spacing aggregates to a black mass, and the
      // woods on this hill are the lightest thing on it after the snow.
      const wood = 0x6d5f52;
      const parts = [
        {
          geo: new THREE.CylinderGeometry(0.16, 0.42, 7.2, 5),
          matrix: mat4(0, 3.6, 0), color: wood, snowTint: 0.22,
        },
      ];
      const boughs = 7;
      for (let i = 0; i < boughs; i++) {
        const around = (i / boughs) * Math.PI * 2 + (i % 2) * 0.4;
        const y = 3.2 + (i % 4) * 0.95;
        const tilt = 0.55 + (i % 3) * 0.18;
        const len = 3.4 - (i % 4) * 0.45;
        // Snow on the upper sides of the branches, which is the whole reason a
        // leafless wood reads pale in winter and not as a stand of dark sticks.
        // The docstring above has always claimed this; until now nothing set it.
        parts.push(limb(len, 0.11, 0.045, 0, y, 0, tilt, around, wood, 0.62));
        // a second-order twig off the end of every other bough
        if (i % 2 === 0) {
          const r = Math.sin(tilt) * len;
          parts.push(limb(
            len * 0.6, 0.05, 0.02,
            Math.cos(around) * r, y + Math.cos(tilt) * len, -Math.sin(around) * r,
            tilt * 0.6, around + 0.5, 0xb9c4d4, 0.5,
          ));
        }
      }
      return parts;
    },
  },
  larch: {
    build: () => {
      const parts = [];
      parts.push({ geo: new THREE.CylinderGeometry(0.16, 0.3, 6.5, 6), matrix: mat4(0, 3.25, 0), color: 0x6a5138 });
      const tiers = [
        { y: 3.6, r: 1.9, h: 4.6 },
        { y: 6.4, r: 1.2, h: 4.0 },
      ];
      for (const t of tiers) {
        parts.push({
          geo: new THREE.ConeGeometry(t.r, t.h, 6),
          matrix: mat4(0, t.y + t.h / 2, 0),
          color: 0xc9a13f, snowTint: 0.18,
        });
      }
      return parts;
    },
  },
};

// ── canvas-drawn signage ──────────────────────────────────────────
function signTexture(name, symbol, color, chip) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f3f4f2';
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = '#2b2f33';
  g.lineWidth = 10;
  g.strokeRect(8, 8, 496, 240);

  // A rating with a field colour is a shape *on* a square, so the square goes
  // down first and the shape is drawn over it.
  if (chip) {
    g.fillStyle = chip;
    g.fillRect(36, 84, 90, 90);
  }

  g.fillStyle = color;
  if (symbol.includes('●')) {
    g.beginPath(); g.arc(80, 128, 46, 0, Math.PI * 2); g.fill();
  } else if (symbol.includes('■')) {
    g.fillRect(36, 84, 90, 90);
  } else if (symbol.includes('▲')) {
    g.beginPath(); g.moveTo(80, 76); g.lineTo(130, 174); g.lineTo(30, 174); g.closePath(); g.fill();
  } else if (symbol.includes('◈')) {
    // Inset so the blue field still reads as a square around it.
    const r = 30;
    g.beginPath();
    g.moveTo(81, 128 - r); g.lineTo(81 + r * 0.78, 128);
    g.lineTo(81, 128 + r); g.lineTo(81 - r * 0.78, 128);
    g.closePath(); g.fill();
  } else {
    // Count the diamonds rather than testing for a specific string, so triple
    // black doesn't silently render as a single.
    const diamonds = (symbol.match(/◆/g) || ['◆']).length;
    for (let i = 0; i < diamonds; i++) {
      const r = 48 / Math.sqrt(diamonds);
      const step = r * 2.1;
      const cx = 80 + (i - (diamonds - 1) / 2) * step;
      g.beginPath();
      g.moveTo(cx, 128 - r); g.lineTo(cx + r * 0.72, 128);
      g.lineTo(cx, 128 + r); g.lineTo(cx - r * 0.72, 128);
      g.closePath(); g.fill();
    }
  }

  g.fillStyle = '#1c2024';
  g.font = 'bold 44px Georgia, serif';
  g.textBaseline = 'middle';
  const label = name.length > 15 ? name.slice(0, 14) + '…' : name;
  g.fillText(label, 150, 130);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ── main props builder ────────────────────────────────────────────
export class Props {
  constructor(terrain, spec, quality = 1) {
    this.terrain = terrain;
    this.spec = spec;
    this.quality = quality;
    this.group = new THREE.Group();
    this.rng = makeRng(spec.seed ^ 0x3c17);
    this.materials = [];
    this.foliageMats = [];
    this.lifts = [];
    this.disposables = [];
    this.collidables = [];  // trees / rocks / posts you can hit
    this.lights = [];
  }

  async build(onProgress = () => {}) {
    const step = async (frac, label, fn) => {
      onProgress(frac, label);
      await new Promise((r) => setTimeout(r, 0));
      fn();
    };

    await step(0.02, 'Planting trees', () => this.buildTrees());
    await step(0.42, 'Scattering rocks', () => this.buildRocks());
    await step(0.56, 'Marking the trails', () => this.buildTrailMarkers());
    await step(0.66, 'Raising the lifts', () => this.buildLifts());
    await step(0.78, 'Building the base area', () => this.buildBuildings());
    await step(0.86, 'Setting the park', () => this.buildPark());
    await step(0.91, 'Setting the race lane', () => this.buildRace());
    await step(0.94, 'Final touches', () => this.buildExtras());
    onProgress(1, 'Ready');
    return this;
  }

  // ── trees ───────────────────────────────────────────────────────
  buildTrees() {
    const t = this.terrain;
    const cfg = this.spec.trees;
    if (!cfg.density || cfg.kinds.length === 0) return;

    const area = t.width * t.length;
    const target = Math.min(32000, Math.floor(area * cfg.density * 0.011 * this.quality));
    if (target < 10) return;

    const spacing = Math.sqrt(area / target);
    // `line` is the fraction of the drop at which the trees give out, so
    // line >= 1 means they never do — the whole hill is below treeline and
    // there is no line to fade toward. Taking it literally instead put the
    // cutoff at exactly the summit and then thinned the 90 m below it, which
    // on a 122 m hill is most of the mountain: Perfect North came out bare
    // from the midstation up, when in life it is wooded to the top.
    const treelineY = cfg.line >= 1 ? Infinity : this.spec.drop * cfg.line;
    const rng = this.rng;

    // tileKey -> kind -> matrices
    const tiles = new Map();
    const cols = Math.ceil(t.width / spacing);
    const rows = Math.ceil(t.length / spacing);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = -t.halfW + (c + 0.5 + rng.range(-0.42, 0.42)) * spacing;
        const z = (r + 0.5 + rng.range(-0.42, 0.42)) * spacing;
        if (Math.abs(x) > t.halfW - 6 || z < 20 || z > t.length - 20) continue;

        const h = t.heightAt(x, z);
        if (h > treelineY) continue;
        // fade the treeline out rather than cutting a hard line
        if (Number.isFinite(treelineY) && h > treelineY - 90
            && rng() < (h - (treelineY - 90)) / 90) continue;

        const groom = t.groomAt(x, z);
        const accept = clamp(1 - groom + cfg.glade * groom, 0, 1);
        if (rng() > accept * accept) continue;

        if (t.rockAt(x, z) > 0.42) continue;
        t.normalAt(x, z, nrm);
        if (nrm.y < 0.62) continue;
        if (t.iceAt(x, z) > 0.15) continue;
        // Nothing grows through tarmac, and the resort keeps its plaza clear.
        if (t.pavedAt(x, z) > 0.05 || t.inBaseArea(x, z)) continue;

        // clumping — forests aren't uniform
        const clump = t.noise.fbm(x / 220, z / 220, 3) * 0.5 + 0.5;
        if (rng() > 0.35 + clump * 0.8) continue;

        // `mix` weights the species list. Without it every kind is equally
        // likely, which is fine for "fir and pine" and wrong for a hardwood
        // hill with conifers through it: an even split reads as a conifer
        // forest, because a fir is an opaque cone and a leafless hardwood is a
        // handful of sticks. The proportion has to be stated to be seen.
        const kind = cfg.kinds.length === 1 ? cfg.kinds[0]
          : cfg.mix ? pickWeighted(rng, cfg.kinds, cfg.mix)
          : rng.pick(cfg.kinds);
        const scale = rng.range(0.62, 1.35) * (kind === 'cedar' ? 1.1 : 1);
        // Trees grow toward vertical, but lean slightly with the slope.
        q.setFromUnitVectors(up, nrm.clone().lerp(up, 0.72).normalize());
        const spin = new THREE.Quaternion().setFromAxisAngle(up, rng.range(0, Math.PI * 2));
        q.multiply(spin);
        m.compose(
          new THREE.Vector3(x, h - 0.4 * scale, z),
          q,
          new THREE.Vector3(scale * rng.range(0.85, 1.15), scale, scale * rng.range(0.85, 1.15)),
        );

        const key = `${Math.floor(x / TILE)}_${Math.floor(z / TILE)}`;
        let tile = tiles.get(key);
        if (!tile) { tile = {}; tiles.set(key, tile); }
        (tile[kind] ||= []).push(m.clone());

        // Trunk collision — the canopy is passable, the trunk is not.
        this.collidables.push({
          x, z, r: 0.55 * scale + 0.35, kind: 'tree',
          y: h, h: (TREE_HEIGHT[kind] ?? 11) * scale,
        });
      }
    }

    const geos = {};
    for (const kind of cfg.kinds) geos[kind] = mergeParts(SPECIES[kind].build());

    const mat = makeFoliageMaterial(0xffffff, 1);
    mat.vertexColors = true;
    this.foliageMats.push(mat);
    this.materials.push(mat);

    for (const [, byKind] of tiles) {
      for (const kind in byKind) {
        const list = byKind[kind];
        const inst = new THREE.InstancedMesh(geos[kind], mat, list.length);
        for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
        inst.instanceMatrix.needsUpdate = true;
        inst.castShadow = true;
        inst.receiveShadow = false;
        inst.computeBoundingSphere();
        this.group.add(inst);
      }
    }
    for (const k in geos) this.disposables.push(geos[k]);
    this.treeCount = this.collidables.length;
  }

  // ── rocks ───────────────────────────────────────────────────────
  buildRocks() {
    const t = this.terrain;
    const density = this.spec.rocks;
    if (density <= 0.001) return;

    const area = t.width * t.length;
    const target = Math.min(9000, Math.floor(area * density * 0.0016 * this.quality));
    if (target < 5) return;

    const rng = this.rng;
    const variants = [];
    for (let v = 0; v < 4; v++) {
      const g = new THREE.IcosahedronGeometry(1, 0);
      const p = g.attributes.position;
      const vr = makeRng(this.spec.seed ^ (0x400 + v));
      for (let i = 0; i < p.count; i++) {
        p.setXYZ(i,
          p.getX(i) * vr.range(0.6, 1.4),
          p.getY(i) * vr.range(0.45, 1.0),
          p.getZ(i) * vr.range(0.6, 1.4));
      }
      g.computeVertexNormals();
      // snow caps on up-facing faces
      const n = g.attributes.normal;
      const col = new Float32Array(p.count * 3);
      const base = new THREE.Color(this.spec.weather === 'ashfall' ? 0x2b2726 : 0x585049);
      const snow = new THREE.Color(0xeef4ff);
      const tmp = new THREE.Color();
      for (let i = 0; i < p.count; i++) {
        tmp.copy(base).lerp(snow, smoothstep(clamp((n.getY(i) - 0.35) / 0.45, 0, 1)) * 0.85);
        col[i * 3] = tmp.r; col[i * 3 + 1] = tmp.g; col[i * 3 + 2] = tmp.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      variants.push(g);
      this.disposables.push(g);
    }

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    this.materials.push(mat);

    const tiles = new Map();
    const m = new THREE.Matrix4();
    for (let i = 0; i < target * 3; i++) {
      const x = rng.range(-t.halfW + 10, t.halfW - 10);
      const z = rng.range(30, t.length - 30);
      const rockness = t.rockAt(x, z);
      const groom = t.groomAt(x, z);
      if (rng() > (0.12 + rockness * 1.4) * (1 - groom * 0.95)) continue;
      if (t.pavedAt(x, z) > 0.05 || t.inBaseArea(x, z)) continue;

      const h = t.heightAt(x, z);
      const s = rng.range(0.7, 4.2) * (rockness > 0.5 ? 1.6 : 1);
      m.compose(
        new THREE.Vector3(x, h - s * 0.32, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rng.range(-0.3, 0.3), rng.range(0, 6.28), rng.range(-0.3, 0.3))),
        new THREE.Vector3(s, s * rng.range(0.6, 1.1), s),
      );
      const vi = rng.int(0, 3);
      const key = `${Math.floor(x / ROCK_TILE)}_${Math.floor(z / ROCK_TILE)}_${vi}`;
      let list = tiles.get(key);
      if (!list) { list = []; tiles.set(key, list); }
      list.push(m.clone());
      if (s > 1.6) this.collidables.push({ x, z, r: s * 0.75, kind: 'rock', y: h, h: s * 0.8 });
    }

    for (const [key, list] of tiles) {
      const vi = parseInt(key.split('_')[2], 10);
      const inst = new THREE.InstancedMesh(variants[vi], mat, list.length);
      for (let i = 0; i < list.length; i++) inst.setMatrixAt(i, list[i]);
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.computeBoundingSphere();
      this.group.add(inst);
    }
  }

  // ── trail markers, signs, fencing ───────────────────────────────
  buildTrailMarkers() {
    const t = this.terrain;
    const rng = this.rng;
    const poles = [];
    const flags = [];
    const m = new THREE.Matrix4();

    for (const trail of t.trails) {
      const every = Math.max(2, Math.round(46 / (t.cell * 1.5)));
      const last = trail.samples.length - 1;
      for (let i = 2; i < trail.samples.length - 2; i += every) {
        const p = trail.samples[i];
        // Follow the taper, so markers line a narrowing chute properly.
        const w = trail.widthAt(i / last);
        for (const side of [-1, 1]) {
          const x = p.x + side * (w * 0.5 + 2.5);
          if (Math.abs(x) > t.halfW - 4) continue;
          const y = t.heightAt(x, p.z);
          poles.push(mat4(x, y + 1.1, p.z, 1, 1, 1, rng.range(0, 3)));
          if (i % (every * 3) === 0) flags.push(mat4(x, y + 2.0, p.z, 1, 1, 1, rng.range(0, 3)));
          this.collidables.push({ x, z: p.z, r: 0.3, kind: 'pole', soft: true, y, h: 2.2 });
        }
      }
    }

    if (poles.length) {
      const poleGeo = mergeParts([
        { geo: new THREE.CylinderGeometry(0.05, 0.05, 2.2, 5), matrix: mat4(0, 0, 0), color: 0xd9d2b8 },
      ]);
      const poleMat = new THREE.MeshLambertMaterial({ vertexColors: true });
      this.materials.push(poleMat);
      this.disposables.push(poleGeo);
      const inst = new THREE.InstancedMesh(poleGeo, poleMat, poles.length);
      poles.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      this.group.add(inst);
    }

    if (flags.length) {
      const flagGeo = mergeParts([
        { geo: new THREE.PlaneGeometry(0.55, 0.4), matrix: mat4(0.28, 0, 0), color: 0xff6b1a },
      ]);
      const fm = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
      this.materials.push(fm);
      this.disposables.push(flagGeo);
      const inst = new THREE.InstancedMesh(flagGeo, fm, flags.length);
      flags.forEach((mm, i) => inst.setMatrixAt(i, mm));
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
    }

    // A named sign at the head of each trail.
    if (this.spec.features.gates || this.spec.category === 'resort') {
      t.trails.forEach((trail, i) => {
        const p = trail.samples[Math.min(4, trail.samples.length - 1)];
        const x = p.x + trail.widthAt(0) * 0.5 + 5;
        if (Math.abs(x) > t.halfW - 6) return;
        const y = t.heightAt(x, p.z);
        // Named runs sign themselves; generated ones borrow the map's name.
        const name = trail.name || (i === 0 ? this.spec.name : `${this.spec.name} ${i + 1}`);
        const key = trail.difficulty || this.spec.difficulty;
        const d = DIFFICULTY[key];
        this.group.add(this.makeSign(name, d.symbol, d.color, x, y, p.z, d.chip));
      });
    }
  }

  makeSign(name, symbol, color, x, y, z, chip) {
    const g = new THREE.Group();
    const postMat = makePaintMaterial(0x6b5b45);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.0, 6), postMat);
    post.position.y = 1.5;
    post.castShadow = true;
    g.add(post);

    const tex = signTexture(name, symbol, color, chip);
    const boardMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.2), boardMat);
    board.position.y = 2.75;
    board.castShadow = true;
    g.add(board);

    this.materials.push(postMat, boardMat);
    this.disposables.push(tex);
    g.position.set(x, y, z);
    g.rotation.y = Math.PI;
    return g;
  }

  // ── chairlifts ──────────────────────────────────────────────────
  /**
   * Lift lines, either spread evenly from a count or placed one by one.
   *
   * A made-up mountain only needs "put five lifts on it". A real one doesn't
   * work that way: its lifts are where the terrain and the base area put them,
   * they're different lengths, and they have names people give directions by.
   * So `features.lifts` takes either a number or a list of
   * {name, x, xBase, top, bottom, kind}, x being -1..1 across the face.
   *
   * `xBase` is optional and works exactly as it does on a named run: a lift
   * line is not obliged to hold one lateral position from top to bottom. Real
   * ones often don't — they're built where the terrain lets you put towers,
   * and a long chair off a broad face can finish a long way across from where
   * it started.
   */
  buildLifts() {
    const f = this.spec.features;
    const lines = Array.isArray(f.lifts)
      ? f.lifts.map((line) => this.placedLiftLine(line))
      : this.spreadLiftLines(f.lifts || 0);
    if (!lines.length) return;

    lines.forEach((line, l) => {
      const towers = this.liftTowers(line);

      // Ropetows and carpets are scenery: they're two metres tall, they serve
      // the beginner hill, and nothing about the chair-riding animation makes
      // sense on one. They get built and they don't get boarded.
      if (line.kind === 'tow' || line.kind === 'carpet') {
        this.group.add(this.makeLiftStructure(towers, { gauge: 0, postR: 0.09, baseR: 0.13 }));
        return;
      }

      this.group.add(this.makeLiftStructure(towers));
      const lift = this.makeChairs(towers, l);
      lift.name = line.name || null;
      this.lifts.push(lift);
      this.group.add(lift.group);

      // terminals
      this.group.add(this.makeTerminal(towers[0], true));
      this.group.add(this.makeTerminal(towers[towers.length - 1], false));
    });
  }

  /**
   * Spread lift lines evenly across the hill rather than stacking them in
   * pairs — a five-lift resort otherwise ends up with towers 50 m apart.
   * The 0.24 floor keeps the innermost line off the main trail.
   */
  spreadLiftLines(count) {
    const t = this.terrain;
    const lines = [];
    for (let l = 0; l < count; l++) {
      const u = count === 1 ? -0.62 : ((l + 0.5) / count) * 2 - 1;
      const side = u < 0 ? -1 : 1;
      lines.push({
        laneX: side * t.halfW * (0.24 + 0.58 * Math.abs(u)),
        top: 0.05,
        bottom: this.spec.features.midstation && l === 1 ? 0.52 : 0.95,
      });
    }
    return lines;
  }

  placedLiftLine(line) {
    const t = this.terrain;
    const lane = (x) => clamp(x * t.halfW, -t.halfW + 40, t.halfW - 40);
    return {
      ...line,
      laneX: lane(line.x),
      laneBotX: lane(line.xBase ?? line.x),
      top: line.top ?? 0.05,
      bottom: line.bottom ?? 0.95,
    };
  }

  liftTowers(line) {
    const t = this.terrain;
    const tow = line.kind === 'tow' || line.kind === 'carpet';
    const zTop = t.length * line.top;
    const zBot = t.length * line.bottom;
    const towerCount = Math.max(tow ? 3 : 5, Math.round((zBot - zTop) / (tow ? 55 : 130)));

    const towers = [];
    for (let i = 0; i <= towerCount; i++) {
      const f = i / towerCount;
      const z = lerp(zBot, zTop, f);
      // f runs 0 at the bottom terminal to 1 at the top, so the traverse is
      // read from the base end up.
      const lane = lerp(line.laneBotX ?? line.laneX, line.laneX, f);
      // A chair line bows slightly; a tow is pulled dead straight.
      const x = lane + (tow ? 0 : Math.sin(f * 2.2) * 12);
      const ground = t.heightAt(x, z);
      const height = tow ? 2.4 : 9 + Math.sin(f * 5.1) * 2.5;
      towers.push({ x, z, ground, top: ground + height });
    }
    return towers;
  }

  /**
   * Towers and cable for a lift line.
   *
   * `gauge` is the half-distance between the up and down cables. A chair hangs
   * two of them off a crossarm; a ropetow is one line straight down the middle,
   * so gauge 0 drops the crossarm and the sheaves along with the second cable.
   */
  makeLiftStructure(towers, { gauge = 2.3, postR = 0.32, baseR = 0.5 } = {}) {
    const parts = [];
    for (const tw of towers) {
      const h = tw.top - tw.ground;
      parts.push({
        geo: new THREE.CylinderGeometry(postR, baseR, h, 8),
        matrix: mat4(tw.x, tw.ground + h / 2, tw.z),
        color: 0x9aa3ad,
      });
      if (gauge <= 0) continue;
      parts.push({
        geo: new THREE.BoxGeometry(gauge * 2.26, 0.35, 0.5),
        matrix: mat4(tw.x, tw.top, tw.z),
        color: 0x8a929c,
      });
      for (const s of [-1, 1]) {
        parts.push({
          geo: new THREE.BoxGeometry(0.7, 0.5, 0.7),
          matrix: mat4(tw.x + s * gauge, tw.top - 0.35, tw.z),
          color: 0x4b525a,
        });
      }
    }
    // cables: thin boxes stretched between towers, both directions
    for (let i = 0; i < towers.length - 1; i++) {
      const a = towers[i], b = towers[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      const dy = b.top - a.top;
      for (const s of gauge > 0 ? [-1, 1] : [0]) {
        const geo = new THREE.BoxGeometry(0.09, 0.09, len);
        const mm = new THREE.Matrix4();
        const mid = new THREE.Vector3(
          (a.x + b.x) / 2 + s * gauge,
          (a.top + b.top) / 2 - (gauge > 0 ? 0.45 : 0.1),
          (a.z + b.z) / 2,
        );
        const quat = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(-Math.atan2(dy, len), Math.atan2(dx, dz), 0, 'YXZ'),
        );
        mm.compose(mid, quat, new THREE.Vector3(1, 1, 1));
        parts.push({ geo, matrix: mm, color: 0x2e3238 });
      }
    }

    const geo = mergeParts(parts);
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40 });
    this.materials.push(mat);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    return mesh;
  }

  makeTerminal(tower, isBase) {
    const g = new THREE.Group();
    const mat = makePaintMaterial(isBase ? 0x9c3f2e : 0x3f5a7c);
    const roofMat = makePaintMaterial(0x33383f);
    const body = new THREE.Mesh(new THREE.BoxGeometry(11, 5.5, 15), mat);
    body.position.y = 2.75;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(12.5, 0.6, 17), roofMat);
    roof.position.y = 5.8;
    roof.castShadow = true;
    g.add(roof);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(2.4, 2.4, 0.5, 16), makeMetalMaterial(0x6d747d));
    wheel.rotation.x = Math.PI / 2;
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(0, tower.top - tower.ground - 1.2, isBase ? -5 : 5);
    g.add(wheel);
    this.materials.push(mat, roofMat, wheel.material);
    g.position.set(tower.x, tower.ground - 1.2, tower.z);
    return g;
  }

  makeChairs(towers, liftIndex) {
    // Arc-length parametrise the tower line so chairs move at constant speed.
    const pts = [];
    let dist = 0;
    for (let i = 0; i < towers.length; i++) {
      if (i > 0) dist += Math.hypot(towers[i].x - towers[i - 1].x, towers[i].z - towers[i - 1].z);
      pts.push({ x: towers[i].x, y: towers[i].top - 0.6, z: towers[i].z, d: dist });
    }
    const total = dist;
    const spacing = 46;
    const perSide = Math.max(2, Math.floor(total / spacing));

    const chairGeo = mergeParts([
      { geo: new THREE.CylinderGeometry(0.06, 0.06, 2.6, 5), matrix: mat4(0, -1.3, 0), color: 0x3a3f46 },
      { geo: new THREE.BoxGeometry(2.2, 0.18, 0.85), matrix: mat4(0, -2.6, 0.1), color: 0x2f6ea8 },
      { geo: new THREE.BoxGeometry(2.2, 1.0, 0.16), matrix: mat4(0, -2.1, -0.35), color: 0x2f6ea8 },
      { geo: new THREE.BoxGeometry(2.2, 0.12, 0.6), matrix: mat4(0, -1.55, 0.35), color: 0x5b6470 },
    ]);
    this.disposables.push(chairGeo);
    const mat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 30 });
    this.materials.push(mat);

    const group = new THREE.Group();
    const inst = new THREE.InstancedMesh(chairGeo, mat, perSide * 2);
    inst.castShadow = true;
    inst.frustumCulled = false;
    group.add(inst);

    return {
      group, inst, pts, total, perSide,
      offset: liftIndex * 13,
      speed: 5.5,
      sample(d) {
        const dd = ((d % this.total) + this.total) % this.total;
        let i = 0;
        while (i < this.pts.length - 2 && this.pts[i + 1].d < dd) i++;
        const a = this.pts[i], b = this.pts[i + 1];
        const f = (dd - a.d) / Math.max(1e-3, b.d - a.d);
        // a little cable sag between towers
        const sag = Math.sin(f * Math.PI) * 1.6;
        return {
          x: lerp(a.x, b.x, f),
          y: lerp(a.y, b.y, f) - sag,
          z: lerp(a.z, b.z, f),
        };
      },
    };
  }

  // ── lodge / village ─────────────────────────────────────────────
  buildBuildings() {
    const f = this.spec.features;
    const t = this.terrain;
    if (!f.lodge && !f.village) return;

    // A resort is mostly the bit at the bottom: plaza, lodge, rentals, lift
    // mazes, car park, beginner carpet, tubing. terrain.js has already
    // flattened ground for all of it.
    if (t.baseArea) {
      const base = new BaseArea(t, this.spec, this, this.rng).build();
      this.group.add(base.group);
      this.baseArea = base;
      this.lodgePos = base.lodgePos;
    }

    const baseZ = t.length * 0.965;
    const centre = t.trails[t.trails.length - 1].samples;
    const cx = clamp(centre[centre.length - 1].x + 80, -t.halfW + 90, t.halfW - 90);

    if (!t.baseArea && f.lodge) {
      this.group.add(this.makeLodge(cx, baseZ, 30, 20, 9, 0x7a4b32));
      this.lodgePos = { x: cx, z: baseZ };
    }

    if (f.village) {
      const rng = this.rng;
      for (let i = 0; i < 9; i++) {
        const x = cx + rng.range(-160, 160);
        const z = baseZ + rng.range(-90, 40);
        if (Math.abs(x) > t.halfW - 40) continue;
        this.group.add(this.makeLodge(
          x, z, rng.range(9, 16), rng.range(8, 13), rng.range(5, 7.5),
          rng.pick([0x8a5a3c, 0x6d4a35, 0x9a7048, 0x5c4a3a]),
        ));
      }
    }
  }

  makeLodge(x, z, w, d, h, wallColor) {
    const t = this.terrain;
    const g = new THREE.Group();
    // Sit the building on the highest corner and skirt down to grade.
    let ground = -Infinity;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      ground = Math.max(ground, t.heightAt(x + sx * w / 2, z + sz * d / 2));
    }

    const wallMat = makePaintMaterial(wallColor, false);
    const roofMat = makePaintMaterial(0x39404a, false);
    const glassMat = new THREE.MeshBasicMaterial({ color: 0xffd88a });
    const trimMat = makePaintMaterial(0xe8e4dc, false);
    this.materials.push(wallMat, roofMat, glassMat, trimMat);

    const skirt = new THREE.Mesh(new THREE.BoxGeometry(w, 14, d), makePaintMaterial(0x4a443e, false));
    skirt.position.y = -7 + 0.4;
    g.add(skirt);
    this.materials.push(skirt.material);

    const body = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), wallMat);
    body.position.y = h / 2;
    body.castShadow = true; body.receiveShadow = true;
    g.add(body);

    // Gable roof: two slanted slabs meeting at a ridge running along X.
    const pitchAngle = Math.atan2(d * 0.42, d / 2);
    const slabLen = Math.hypot(d / 2, d * 0.42) + 0.9;
    for (const s of [-1, 1]) {
      const slab = new THREE.Mesh(new THREE.BoxGeometry(w * 1.12, 0.35, slabLen), roofMat);
      slab.position.set(0, h + d * 0.21, (s * d) / 4);
      slab.rotation.x = -s * pitchAngle;
      slab.castShadow = true;
      g.add(slab);
    }
    for (const s of [-1, 1]) {
      const gable = new THREE.Mesh(new THREE.BoxGeometry(0.3, d * 0.42, d * 0.7), wallMat);
      gable.position.set((s * w) / 2, h + d * 0.21, 0);
      g.add(gable);
    }
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3.4, 1.2), makePaintMaterial(0x4d4642, false));
    chimney.position.set(w * 0.28, h + d * 0.36, -d * 0.12);
    chimney.castShadow = true;
    this.materials.push(chimney.material);
    g.add(chimney);

    // windows on the downhill face
    const cols = Math.max(2, Math.floor(w / 4));
    for (let i = 0; i < cols; i++) {
      const wx = -w / 2 + (i + 0.5) * (w / cols);
      for (let row = 0; row < (h > 7 ? 2 : 1); row++) {
        const win = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.5), glassMat);
        win.position.set(wx, 1.6 + row * 3.2, d / 2 + 0.02);
        g.add(win);
      }
    }

    const deck = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.3, 6), trimMat);
    deck.position.set(0, 0.3, d / 2 + 3);
    deck.receiveShadow = true;
    g.add(deck);

    g.position.set(x, ground, z);
    return g;
  }

  // ── terrain park hardware ───────────────────────────────────────
  buildPark() {
    const pf = this.terrain.parkFeatures;
    const t = this.terrain;
    if (!pf.rails.length && !pf.jumps.length) return;

    const railMat = makeMetalMaterial(0xb9c0c8);
    const boxMat = makePaintMaterial(0x2b3d5c, false);
    const postMat = makeMetalMaterial(0x555c66);
    this.materials.push(railMat, boxMat, postMat);

    const resolved = [];
    for (const r of pf.rails) {
      const g = new THREE.Group();
      const yA = t.heightAt(r.x, r.z) + r.post + r.rise;
      const yB = t.heightAt(r.x + r.skew * r.len, r.z + r.len) + r.post;
      const a = new THREE.Vector3(r.x, yA, r.z);
      const b = new THREE.Vector3(r.x + r.skew * r.len, yB, r.z + r.len);

      const mid = a.clone().add(b).multiplyScalar(0.5);
      const dir = b.clone().sub(a);
      const len = dir.length();
      const isBox = r.kind === 'box';
      // Both primitives are built along local +Y, so a single minimal rotation
      // from up to the rail direction orients them (and keeps a box's top flat).
      const geo = isBox
        ? new THREE.BoxGeometry(r.width, len, 0.32)
        : new THREE.CylinderGeometry(r.width / 2, r.width / 2, len, 8);
      const mesh = new THREE.Mesh(geo, isBox ? boxMat : railMat);
      mesh.position.copy(mid);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      mesh.castShadow = true;
      g.add(mesh);

      const posts = Math.max(2, Math.round(len / 3));
      for (let i = 0; i <= posts; i++) {
        const f = i / posts;
        const p = a.clone().lerp(b, f);
        const ground = t.heightAt(p.x, p.z);
        const ph = Math.max(0.2, p.y - ground);
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, ph, 5), postMat);
        post.position.set(p.x, ground + ph / 2, p.z);
        post.castShadow = true;
        g.add(post);
      }
      this.group.add(g);
      resolved.push({ a, b, width: Math.max(r.width, 0.5), kind: r.kind });
    }
    pf.rails = resolved;

    // Padded lips and takeoff markers on the bigger kickers.
    const padMat = makePaintMaterial(0xd94f2b, false);
    this.materials.push(padMat);
    for (const j of pf.jumps) {
      if (j.h < 2.2) continue;
      const y = t.heightAt(j.x, j.z);
      for (const s of [-1, 1]) {
        const pad = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 2.5), padMat);
        pad.position.set(j.x + s * (j.w / 2 + 0.4), y + 0.3, j.z - 1);
        pad.castShadow = true;
        this.group.add(pad);
      }
    }
  }

  // ── race lane ───────────────────────────────────────────────────
  /**
   * A gated race lane: pairs of poles zig-zagging down a corridor, alternating
   * red and blue, panel strung between each pair.
   *
   * Scenery, deliberately. Nothing times you and nothing checks which side of
   * a gate you went. A hill that runs race training has a lane fenced off for
   * it whether or not anyone is training, and the lane is the part you see.
   */
  buildRace() {
    const race = this.spec.features.race;
    if (!race) return;
    const t = this.terrain;
    const count = race.gates ?? 18;
    const laneX = clamp(race.x * t.halfW, -t.halfW + 40, t.halfW - 40);
    const offset = race.offset ?? 11;

    const parts = [];
    for (let i = 0; i < count; i++) {
      const f = count === 1 ? 0 : i / (count - 1);
      const z = lerp(race.t0 * t.length, race.t1 * t.length, f);
      const side = i % 2 === 0 ? -1 : 1;
      const cx = laneX + side * offset;
      const colour = i % 2 === 0 ? 0xc4342b : 0x2f6ea8;

      // A gate is two poles with the panel hung between them.
      for (const s of [-1, 1]) {
        const x = cx + s * 3.2;
        parts.push({
          geo: new THREE.CylinderGeometry(0.045, 0.055, 1.9, 5),
          matrix: mat4(x, t.heightAt(x, z) + 0.95, z),
          color: colour,
        });
      }
      parts.push({
        geo: new THREE.BoxGeometry(6.4, 0.5, 0.05),
        matrix: mat4(cx, t.heightAt(cx, z) + 1.45, z),
        color: colour,
      });
    }

    const geo = mergeParts(parts);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.materials.push(mat);
    this.disposables.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  // ── seracs, floodlights, lake ice, misc ─────────────────────────
  buildExtras() {
    const f = this.spec.features;
    const t = this.terrain;
    const rng = this.rng;

    if (f.seracs) {
      // Rounded, opaque ice mounds. These used to be transparent boxes, which
      // read as flat rectangles you could see straight through — a slab has no
      // silhouette from the side and nothing to catch the light. A deformed
      // sphere with normals taken from the local position instead of the faces
      // gives a smooth, solid mound that still shades like ice.
      const parts = [];
      for (let i = 0; i < f.seracs; i++) {
        const x = rng.range(-t.halfW + 40, t.halfW - 40);
        const z = rng.range(t.length * 0.15, t.length * 0.9);
        const y = t.heightAt(x, z);
        const h = rng.range(4, 13);
        const w = rng.range(4, 10);

        const g = new THREE.IcosahedronGeometry(1, 2);
        const p = g.attributes.position;
        const nAttr = g.attributes.normal;
        const lump = makeRng(this.spec.seed ^ (0x5e0 + i));
        const a1 = lump.range(0, 6.28), a2 = lump.range(0, 6.28);
        for (let v = 0; v < p.count; v++) {
          const vx = p.getX(v), vy = p.getY(v), vz = p.getZ(v);
          // Low-frequency swell so each block is lumpy but never spiky.
          // Several octaves, or it comes out as a perfectly smooth egg.
          const k = 1
            + 0.30 * Math.sin(vx * 2.1 + a1) * Math.cos(vz * 1.7 + a2)
            + 0.20 * Math.sin(vy * 2.6 + a2)
            + 0.13 * Math.cos(vx * 4.3 - a2) * Math.sin(vy * 3.7 + a1)
            + 0.08 * Math.sin(vz * 6.1 + a1)
            // Ice shears off flat-ish on top where it calves.
            - 0.16 * Math.max(0, vy) ** 2;
          p.setXYZ(v, vx * k, vy * k, vz * k);
          // Smooth normals: on a blob, outward-from-centre is the right answer,
          // and computeVertexNormals() on non-indexed geometry only gives flat.
          const inv = 1 / Math.hypot(vx, vy, vz);
          nAttr.setXYZ(v, vx * inv, vy * inv, vz * inv);
        }
        p.needsUpdate = true;
        nAttr.needsUpdate = true;

        const d = w * rng.range(0.7, 1.3);
        parts.push({
          geo: g,
          matrix: mat4(x, y + h * 0.30, z, w * 0.5, h * 0.5, d * 0.5, rng.range(0, 3.14)),
          color: 0x9ec6e2,
          snowTint: 0.55,
        });
        this.collidables.push({ x, z, r: w * 0.42, kind: 'serac', y, h: h * 0.8 });
      }
      const geo = mergeParts(parts);
      this.disposables.push(geo);
      const mesh = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
        vertexColors: true, shininess: 64, specular: 0x8fbcd8,
      }));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.materials.push(mesh.material);
      this.group.add(mesh);
    }

    // A high camp: tents on ledges chopped into the face. Small, bright, and
    // the only man-made thing for a vertical kilometre in any direction.
    if (f.camp) {
      const trail = t.trails[0];
      const last = trail.samples.length - 1;
      const i0 = Math.round(f.camp.at * last);
      const tentCols = [0xe8c23a, 0xd94f2b, 0xf0f3f6, 0x3fa34d];
      const parts = [];

      for (let k = 0; k < (f.camp.tents ?? 6); k++) {
        const p = trail.samples[clamp(i0 + rng.int(-3, 3), 2, last - 2)];
        const w = trail.widthAt(clamp((i0 + k) / last, 0, 1));
        const x = p.x + rng.range(-1, 1) * Math.min(w * 0.42, 60);
        const z = p.z + rng.range(-18, 18);
        if (Math.abs(x) > t.halfW - 12) continue;
        const y = t.heightAt(x, z);
        const ry = rng.range(0, Math.PI);
        const col = rng.pick(tentCols);

        // Dome tent: a squat box with a pitched top, on a levelled platform.
        parts.push({ geo: new THREE.BoxGeometry(3.4, 0.35, 3.0), matrix: mat4(x, y + 0.1, z, 1, 1, 1, ry), color: 0xc8d6e4 });
        parts.push({ geo: new THREE.BoxGeometry(2.6, 0.95, 2.2), matrix: mat4(x, y + 0.72, z, 1, 1, 1, ry), color: col });
        parts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 1.5, 4), matrix: mat4(x + 1.5, y + 0.75, z + 1.2, 1, 1, 1, ry), color: 0x2b3038 });
        this.collidables.push({ x, z, r: 1.9, kind: 'rock', y, h: 1.3 });
      }

      if (parts.length) {
        const geo = mergeParts(parts);
        this.disposables.push(geo);
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
        this.materials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true; mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }

    // Rock teeth flanking a chute — jagged spires standing out of the snow
    // where the walls close in, rather than the rounded boulders used
    // everywhere else.
    if (f.spires) {
      const trail = t.trails[0];
      const last = trail.samples.length - 1;
      const parts = [];
      const dark = this.spec.weather === 'ashfall' ? 0x2a2624 : 0x4c4640;

      for (let i = 4; i < last - 3; i++) {
        const tt = i / last;
        // Densest where the run is at its narrowest.
        const tightness = 1 - clamp((trail.widthAt(tt) - trail.widthAt(0.62)) / Math.max(1, trail.maxWidth), 0, 1);
        if (rng() > 0.16 + tightness * 0.6) continue;

        const p = trail.samples[i];
        const w = trail.widthAt(tt);
        for (const side of [-1, 1]) {
          if (rng() < 0.35) continue;
          const x = p.x + side * (w * 0.5 + rng.range(2, 16));
          const z = p.z + rng.range(-8, 8);
          if (Math.abs(x) > t.halfW - 8) continue;
          const h = rng.range(5, 17) * (0.6 + tightness);
          const r = h * rng.range(0.13, 0.26);
          const y = t.heightAt(x, z);
          parts.push({
            geo: new THREE.ConeGeometry(r, h, rng.int(4, 5)),
            matrix: mat4(x, y + h * 0.34, z, 1, 1, 1, rng.range(0, 3.14)),
            color: rng() < 0.5 ? dark : 0x6b645c,
          });
          this.collidables.push({ x, z, r: r * 0.8, kind: 'rock', y, h: h * 0.84 });
        }
      }

      if (parts.length) {
        const geo = mergeParts(parts);
        this.disposables.push(geo);
        const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
        this.materials.push(mat);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }

    if (f.floodlights) {
      const poleMat = makeMetalMaterial(0x3a4048);
      const headMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0 });
      this.materials.push(poleMat, headMat);

      // Light every trail, not just the first: on a resort that runs at night
      // an unlit trail is unskiable, not atmospheric.
      const lit = t.trails.slice(0, 4);
      // The base area claims its lights first (it's built earlier), so this is
      // a shared ceiling rather than a fresh allowance.
      const budget = 9;
      for (const trail of lit) {
        const step = Math.max(4, Math.floor(trail.samples.length / 7));
        for (let i = 3; i < trail.samples.length - 3; i += step) {
          const p = trail.samples[i];
          const side = i % 2 === 0 ? 1 : -1;
          const x = clamp(p.x + side * (trail.width * 0.5 + 6), -t.halfW + 8, t.halfW - 8);
          const y = t.heightAt(x, p.z);
          const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 14, 6), poleMat);
          pole.position.set(x, y + 7, p.z);
          pole.castShadow = true;
          this.group.add(pole);

          const head = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.5, 0.9), headMat);
          head.position.set(x - side * 0.8, y + 13.6, p.z);
          this.group.add(head);

          // Real lights are expensive per-fragment, so only a handful are
          // actual lights — the rest are lamp housings that read as lit.
          if (this.lights.length < budget) {
            const light = new THREE.PointLight(0xffe9bd, 320, 150, 2);
            light.position.set(x, y + 13, p.z);
            this.group.add(light);
            this.lights.push(light);
          }
        }
      }
    }

    // Glassy overlay on frozen lakes so they read as ice, not pale snow.
    for (const lake of t.parkFeatures.lakes) {
      const geo = new THREE.CircleGeometry(lake.r * 0.82, 32);
      const mat = new THREE.MeshPhongMaterial({
        color: 0x8fbdd8, shininess: 120, specular: 0xcce8ff,
        transparent: true, opacity: 0.5,
      });
      const disc = new THREE.Mesh(geo, mat);
      disc.rotation.x = -Math.PI / 2;
      disc.position.set(lake.x, lake.y + 0.12, lake.z);
      this.materials.push(mat);
      this.disposables.push(geo);
      this.group.add(disc);
    }
  }

  update(dt, time) {
    for (const m of this.foliageMats) updateFoliage(m, time);

    const mm = new THREE.Matrix4();
    const scale = new THREE.Vector3(1, 1, 1);
    const quat = new THREE.Quaternion();
    for (const lift of this.lifts) {
      lift.offset += lift.speed * dt;
      const spacing = lift.total / lift.perSide;
      for (let s = 0; s < 2; s++) {
        const lateral = s === 0 ? -2.3 : 2.3;
        for (let i = 0; i < lift.perSide; i++) {
          const d = s === 0
            ? lift.offset + i * spacing
            : lift.total - (lift.offset + i * spacing);
          const p = lift.sample(d);
          mm.compose(new THREE.Vector3(p.x + lateral, p.y, p.z), quat, scale);
          lift.inst.setMatrixAt(s * lift.perSide + i, mm);
        }
      }
      lift.inst.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const d of this.disposables) d.dispose?.();
    for (const m of this.materials) m.dispose?.();
    this.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose?.();
      if (o.isMesh && o.geometry) o.geometry.dispose();
    });
  }
}
