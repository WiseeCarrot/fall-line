// The resort, as opposed to the mountain.
//
// terrain.js flattens the ground for all of this (see stampBaseArea); this
// module puts the buildings, the car park, the lift mazes, the tubing hill and
// the people on top of it. It's deliberately a separate module because a base
// area is a different kind of object from a tree: dozens of one-off pieces
// arranged relative to each other, rather than thousands of scattered copies.

import * as THREE from 'three';
import { clamp, lerp } from '../core/math.js';

const CAR_COLOURS = [
  0x9aa3ad, 0x2c3138, 0x8e2f2a, 0x27405e, 0xb8bcc0, 0x1d2226,
  0x3f5d43, 0x6e7278, 0xc9c2b4, 0x24313f, 0x7a3d2e, 0xd9dcdf,
];

const JACKETS = [
  0xd94f2b, 0x2f6ea8, 0xe8b93c, 0x3fa34d, 0x8e4bb5, 0xe8734a,
  0x24303d, 0xf0f3f6, 0x1f9c9c, 0xc9345f, 0x5b6470, 0xffa62b,
];

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (r0, r1, h, s = 6) => new THREE.CylinderGeometry(r0, r1, h, s);

/** Canvas-drawn board: trail map, resort name, lift sign. */
function boardTexture(title, lines, accent) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 320;
  const g = c.getContext('2d');
  g.fillStyle = '#f2f1ec';
  g.fillRect(0, 0, 512, 320);
  g.fillStyle = accent;
  g.fillRect(0, 0, 512, 58);
  g.fillStyle = '#ffffff';
  g.font = 'bold 34px Georgia, serif';
  g.textBaseline = 'middle';
  g.fillText(title.slice(0, 22), 20, 30);

  g.strokeStyle = '#c9c6bd';
  g.lineWidth = 2;
  g.strokeRect(6, 6, 500, 308);

  g.fillStyle = '#2a2e33';
  g.font = '22px Georgia, serif';
  lines.forEach((l, i) => g.fillText(l.slice(0, 34), 22, 96 + i * 34));

  // a little abstract trail diagram down the right
  g.strokeStyle = '#b9c4d2';
  g.lineWidth = 4;
  for (let i = 0; i < 4; i++) {
    g.beginPath();
    g.moveTo(360 + i * 30, 82);
    g.bezierCurveTo(340 + i * 30, 160, 400 + i * 30, 220, 356 + i * 34, 300);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class BaseArea {
  /**
   * @param host  the Props instance — shares its material/geometry bookkeeping
   *              so everything built here is disposed with the rest of the map.
   */
  constructor(terrain, spec, host, rng) {
    this.t = terrain;
    this.spec = spec;
    this.host = host;
    this.rng = rng;
    this.group = new THREE.Group();
    this.area = terrain.baseArea;
    this.people = null;
    this.emitters = [];
    this.batch = [];
  }

  mat(color, flat = false, shiny = 0) {
    const m = shiny
      ? new THREE.MeshPhongMaterial({ color, shininess: shiny, flatShading: flat })
      : new THREE.MeshLambertMaterial({ color, flatShading: flat });
    this.host.materials.push(m);
    return m;
  }

  /**
   * Queue a static piece instead of adding a mesh immediately.
   *
   * A base area is a few hundred small props — posts, rails, benches, flags,
   * lamp standards. As individual meshes that was 370 draw calls just to stand
   * in the plaza. They never move, so they're merged per material in flush()
   * and go out as a handful of calls instead.
   *
   * Returns a lightweight handle; set `.rotation.x` on it before flush if the
   * piece needs tilting (used by the magic carpet and the snowcat blade).
   */
  add(geo, material, x, y, z, ry = 0, shadow = true) {
    const item = {
      geo, material, shadow,
      position: new THREE.Vector3(x, y, z),
      rotation: new THREE.Euler(0, ry, 0),
    };
    this.batch.push(item);
    return item;
  }

  /** Merge every queued piece into one mesh per (material, shadow) pair. */
  flush() {
    const groups = new Map();
    for (const it of this.batch) {
      const key = `${it.material.uuid}|${it.shadow ? 1 : 0}`;
      let g = groups.get(key);
      if (!g) { g = { material: it.material, shadow: it.shadow, items: [] }; groups.set(key, g); }
      g.items.push(it);
    }

    const m = new THREE.Matrix4();
    for (const { material, shadow, items } of groups.values()) {
      const geos = items.map((it) => {
        const g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone();
        m.compose(it.position, new THREE.Quaternion().setFromEuler(it.rotation), UNIT);
        g.applyMatrix4(m);
        if (!g.attributes.normal) g.computeVertexNormals();
        return g;
      });
      const merged = mergePlain(geos);
      this.host.disposables.push(merged);
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = shadow;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
    this.batch.length = 0;
  }

  build() {
    if (!this.area) return this;
    this.materials = {
      timber: this.mat(0x6d4a33),
      timberDark: this.mat(0x50372a),
      plaster: this.mat(0xd8cfbe),
      roof: this.mat(0x333941, true),
      glass: this.mat(0xffd88a),
      metal: this.mat(0x8f959d, false, 60),
      metalDark: this.mat(0x4b525a, false, 40),
      accent: this.mat(0xd94f2b),
      rope: this.mat(0x2b3038),
      rubber: this.mat(0x22262b),
      snowPack: this.mat(0xdfe8f4),
      trim: this.mat(0xe8e4dc),
      lamp: this.mat(0xfff1cf),
      cat: this.mat(0xc4472c),
    };
    // Pooled so a plaza full of skis and flags doesn't compile a shader each.
    this.bright = JACKETS.map((c) => this.mat(c));

    this.buildLodge();
    this.buildOutbuildings();
    this.buildCarPark();
    this.buildLiftMazes();
    this.buildBeginnerArea();
    this.buildTubing();
    this.buildPlazaDressing();
    this.buildPeople();
    this.flush();
    return this;
  }

  // ── main lodge ──────────────────────────────────────────────────
  /**
   * The base lodge. Not one box: a run of connected wings with their own
   * gable roofs and ridge heights, which is what a day lodge that's been
   * extended four times over thirty years actually looks like — and what the
   * Perfect North trail map shows sitting across the bottom of the hill.
   *
   * The whole footprint is registered as one solid box, so you can ski up to
   * it and along it but never into it.
   */
  buildLodge() {
    const a = this.area;
    const M = this.materials;
    const wings = this.spec.features.hub ?? 4;
    const d = 22, h = 8.6;
    const wingW = 21;
    const w = wings * wingW;
    const x = clamp(a.x + a.halfW * 0.34, -this.t.halfW + w * 0.6, this.t.halfW - w * 0.6);
    const z = a.z0 + (a.z1 - a.z0) * 0.74;
    const y = this.groundY(x, z);
    this.lodgePos = { x, z, y };

    const g = new THREE.Group();
    g.position.set(x, y, z);
    this.group.add(g);

    const put0 = (geo, mat, px, py, pz, ry = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.rotation.y = ry;
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      return m;
    };

    for (let i = 0; i < wings; i++) {
      const wx = -w / 2 + wingW / 2 + i * wingW;
      // Middle wings run taller; the outer ones are the later, lower additions.
      const mid = 1 - Math.abs((i + 0.5) / wings - 0.5) * 2;
      const wh = h * (0.78 + mid * 0.34);
      const wd = d * (0.82 + mid * 0.22);
      const body = i % 2 === 0 ? M.timber : M.timberDark;

      put0(box(wingW + 0.4, 20, wd), M.timberDark, wx, -10 + 0.3, 0);
      put0(box(wingW + 0.4, wh, wd), body, wx, wh / 2, 0);

      const pitch = Math.atan2(wd * 0.34, wd / 2);
      const slab = Math.hypot(wd / 2, wd * 0.34) + 1.3;
      for (const s of [-1, 1]) {
        const r = put0(box(wingW + 2.2, 0.42, slab), M.roof, wx, wh + wd * 0.17, (s * wd) / 4);
        r.rotation.x = -s * pitch;
      }
      for (const s of [-1, 1]) {
        put0(box(0.35, wd * 0.34, wd * 0.72), body, wx + s * (wingW + 0.4) / 2, wh + wd * 0.17, 0);
      }

      // Glazing faces uphill, toward the runs.
      for (let k = 0; k < 4; k++) {
        const gx = wx - wingW / 2 + 3 + k * ((wingW - 6) / 3);
        put0(box(3.1, 2.5, 0.2), M.glass, gx, 3.9, -wd / 2 - 0.06);
        if (wh > 9) put0(box(3.1, 1.9, 0.2), M.glass, gx, 7.1, -wd / 2 - 0.06);
      }
      if (i === Math.floor(wings / 2)) {
        put0(box(2.0, 5.0, 2.0), M.timberDark, wx + wingW * 0.3, wh + 2.2, wd * 0.2);
      }
    }

    // Covered entry canopy across the uphill face.
    put0(box(w * 0.5, 0.35, 6), M.roof, 0, 4.4, -d * 0.62);
    for (let i = 0; i <= 5; i++) {
      put0(cyl(0.14, 0.14, 4.3, 6), M.timber, -w * 0.24 + i * (w * 0.48 / 5), 2.15, -d * 0.62 - 2.6);
    }

    this.host.collidables.push({
      kind: 'solid', x, z, hx: w / 2 + 0.6, hz: d * 0.62, ry: 0,
      r: Math.hypot(w / 2, d * 0.62) + 2,
    });

    const put = put0;

    // Sun deck on the uphill side, with a rail and a scatter of tables.
    const deck = put(box(w * 0.7, 0.4, 9), M.trim, 0, 0.7, -d * 0.62 - 6.5);
    deck.castShadow = false;
    for (let i = 0; i <= 10; i++) {
      put(cyl(0.07, 0.07, 1.1, 5), M.timber, -w * 0.35 + i * (w * 0.7 / 10), 1.45, -d * 0.62 - 10.9);
    }
    put(box(w * 0.7, 0.1, 0.1), M.timber, 0, 1.95, -d * 0.62 - 10.9);
    for (let i = 0; i < 5; i++) {
      const tx = -w * 0.26 + i * (w * 0.13);
      put(cyl(1.5, 1.5, 0.12, 8), M.trim, tx, 1.65, -d * 0.62 - 8.5);
      put(cyl(0.09, 0.09, 0.85, 5), M.metalDark, tx, 1.3, -d * 0.62 - 8.5);
    }

    put(box(7, 2.6, 0.4), M.accent, 0, h + 2.6, -d * 0.5);      // sign band

    const tex = boardTexture(this.spec.name, [
      `${this.spec.drop} m vertical`,
      `${this.t.trails.length} marked trails`,
      `${this.spec.features.lifts || 0} lifts running`,
      'Please ski in control.',
    ], '#1e4f7a');
    this.host.disposables.push(tex);
    const boardMat = new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
    this.host.materials.push(boardMat);
    const board = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.8), boardMat);
    board.position.set(-w * 0.36, 3.2, -d * 0.62 - 11.4);
    board.castShadow = true;
    g.add(board);
    for (const s of [-1, 1]) {
      put(cyl(0.1, 0.1, 3.4, 6), M.timber, -w * 0.36 + s * 2.1, 1.7, -d * 0.62 - 11.4);
    }
  }

  // ── rental shop, ticket office, patrol ──────────────────────────
  buildOutbuildings() {
    const a = this.area;
    const M = this.materials;
    const defs = [
      { name: 'RENTALS',  w: 22, d: 14, h: 6.5, dx: -0.12, dz: 0.78, col: M.timber },
      { name: 'TICKETS',  w: 13, d: 9,  h: 5.2, dx: -0.52, dz: 0.62, col: M.plaster },
      { name: 'PATROL',   w: 10, d: 8,  h: 5.0, dx: 0.78,  dz: 0.44, col: M.accent },
      { name: 'SCHOOL',   w: 15, d: 10, h: 5.4, dx: -0.78, dz: 0.86, col: M.timber },
    ];

    for (const b of defs) {
      const x = a.x + a.halfW * b.dx;
      const z = a.z0 + (a.z1 - a.z0) * b.dz;
      if (Math.abs(x) > this.t.halfW - 30) continue;
      const y = this.groundY(x, z);
      const g = new THREE.Group();
      g.position.set(x, y, z);
      this.group.add(g);

      const put = (geo, mat, px, py, pz) => {
        const m = new THREE.Mesh(geo, mat);
        m.position.set(px, py, pz);
        m.castShadow = true; m.receiveShadow = true;
        g.add(m);
        return m;
      };
      put(box(b.w, 14, b.d), M.timberDark, 0, -7 + 0.3, 0);
      put(box(b.w, b.h, b.d), b.col, 0, b.h / 2, 0);
      const pitch = Math.atan2(b.d * 0.28, b.d / 2);
      const slab = Math.hypot(b.d / 2, b.d * 0.28) + 1.2;
      for (const s of [-1, 1]) {
        const r = put(box(b.w * 1.12, 0.4, slab), M.roof, 0, b.h + b.d * 0.14, (s * b.d) / 4);
        r.rotation.x = -s * pitch;
      }
      const cols = Math.max(2, Math.floor(b.w / 5));
      for (let i = 0; i < cols; i++) {
        put(box(2.2, 1.8, 0.18), M.glass, -b.w / 2 + 2.2 + i * ((b.w - 4.4) / Math.max(1, cols - 1)), 2.9, -b.d / 2 - 0.04);
      }
      put(box(b.w * 0.55, 1.0, 0.3), M.accent, 0, b.h + 0.2, -b.d / 2 - 0.2);
      this.host.collidables.push({
        kind: 'solid', x, z, hx: b.w / 2, hz: b.d / 2, ry: 0,
        r: Math.hypot(b.w / 2, b.d / 2) + 2,
      });
    }
  }

  // ── car park ────────────────────────────────────────────────────
  buildCarPark() {
    const lot = this.area.lot;
    const rng = this.rng;
    const M = this.materials;

    // Two instanced meshes per car park: a body tinted per instance, and the
    // dark trim (glazing and wheels) that must *not* pick up the paint colour.
    const bodyGeo = carBody();
    const trimGeo = carTrim();
    this.host.disposables.push(bodyGeo, trimGeo);

    const bodyMat = new THREE.MeshPhongMaterial({ shininess: 55, specular: 0x333a44 });
    const trimMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 70 });
    this.host.materials.push(bodyMat, trimMat);

    // Bounded: a lot sized purely off the plaza dimensions produced a
    // thousand cars on the larger resorts.
    const rows = clamp(Math.floor((lot.halfZ * 2 - 12) / 15), 2, 14);
    const perRow = clamp(Math.floor((lot.halfX * 2 - 8) / 3.1), 3, 26);
    const spots = [];
    for (let r = 0; r < rows; r++) {
      const z = lot.z - lot.halfZ + 10 + r * 15;
      for (let c = 0; c < perRow; c++) {
        const x = lot.x - lot.halfX + 5 + c * 3.1;
        if (rng() < 0.28) continue;              // gaps, it's never full
        spots.push({ x, z: z + (r % 2 ? 3.4 : 0), ry: r % 2 ? Math.PI : 0 });
      }
    }

    const bodies = new THREE.InstancedMesh(bodyGeo, bodyMat, spots.length);
    const trim = new THREE.InstancedMesh(trimGeo, trimMat, spots.length);
    bodies.castShadow = true; bodies.receiveShadow = true;
    trim.castShadow = false;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);

    spots.forEach((s, i) => {
      const y = this.groundY(s.x, s.z);
      const scale = rng.range(0.92, 1.12);
      q.setFromAxisAngle(up, s.ry + rng.range(-0.03, 0.03));
      m.compose(new THREE.Vector3(s.x, y, s.z), q, new THREE.Vector3(scale, scale, scale));
      bodies.setMatrixAt(i, m);
      trim.setMatrixAt(i, m);
      col.setHex(rng.pick(CAR_COLOURS));
      bodies.setColorAt(i, col);
    });
    bodies.instanceMatrix.needsUpdate = true;
    trim.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    this.group.add(bodies, trim);
    this.carCount = spots.length;

    // Lamp standards down the middle of the lot.
    const night = /night|moon/.test(this.spec.weather);
    for (let r = 0; r <= rows; r += 2) {
      const z = lot.z - lot.halfZ + 6 + r * 15;
      const x = lot.x;
      const y = this.groundY(x, z);
      this.add(cyl(0.14, 0.2, 9, 6), M.metalDark, x, y + 4.5, z);
      this.add(box(1.1, 0.3, 0.6), M.lamp, x, y + 9.1, z, 0, false);
      if (night && this.host.lights.length < 2) {
        const light = new THREE.PointLight(0xffe6b4, 380, 165, 2);
        light.position.set(x, y + 8.7, z);
        this.group.add(light);
        this.host.lights.push(light);
      }
    }
  }

  // ── lift mazes at the base terminals ────────────────────────────
  buildLiftMazes() {
    const M = this.materials;
    for (const lift of this.host.lifts) {
      const base = lift.pts[0];
      if (base.z < this.area.z0 - 60) continue;    // only the ones down here

      const rows = 5, laneW = 2.2, laneLen = 15;
      const ox = base.x - (rows * laneW) / 2;
      const oz = base.z - laneLen - 12;
      for (let r = 0; r <= rows; r++) {
        const x = ox + r * laneW;
        for (let p = 0; p <= 4; p++) {
          const z = oz + (p * laneLen) / 4;
          const y = this.groundY(x, z);
          this.add(cyl(0.05, 0.05, 1.15, 5), M.metal, x, y + 0.58, z);
        }
        // the webbing between posts
        const y0 = this.groundY(x, oz);
        const y1 = this.groundY(x, oz + laneLen);
        const rail = this.add(box(0.06, 0.05, laneLen), M.rope, x, (y0 + y1) / 2 + 1.05, oz + laneLen / 2, 0, false);
        rail.receiveShadow = false;
      }
      const sy = this.groundY(base.x, oz - 3);
      this.add(box(3.6, 0.7, 0.2), M.accent, base.x, sy + 2.6, oz - 3, 0);
      for (const s of [-1, 1]) {
        this.add(cyl(0.08, 0.08, 2.6, 5), M.metal, base.x + s * 1.6, sy + 1.3, oz - 3);
      }
    }
  }

  // ── beginner slope: magic carpet ────────────────────────────────
  buildBeginnerArea() {
    const l = this.area.learn;
    const M = this.materials;
    const x = l.x - l.halfX * 0.62;
    const len = l.z1 - l.z0;

    // Conveyor belt, following the ground up the apron.
    const segs = 12;
    for (let i = 0; i < segs; i++) {
      const z0 = l.z0 + (i * len) / segs;
      const z1 = l.z0 + ((i + 1) * len) / segs;
      const y0 = this.groundY(x, z0), y1 = this.groundY(x, z1);
      const dz = z1 - z0, dy = y1 - y0;
      const seg = this.add(box(1.5, 0.34, Math.hypot(dz, dy) + 0.1), M.rubber, x, (y0 + y1) / 2 + 0.42, (z0 + z1) / 2);
      seg.rotation.x = -Math.atan2(dy, dz);
      for (const s of [-1, 1]) {
        const side = this.add(box(0.18, 0.55, Math.hypot(dz, dy) + 0.1), M.metal, x + s * 0.86, (y0 + y1) / 2 + 0.5, (z0 + z1) / 2);
        side.rotation.x = -Math.atan2(dy, dz);
      }
    }
    const topY = this.groundY(x, l.z0);
    this.add(box(2.6, 1.6, 1.6), M.metalDark, x, topY + 0.8, l.z0 - 1.4);
    const botY = this.groundY(x, l.z1);
    this.add(box(2.6, 1.6, 1.6), M.metalDark, x, botY + 0.8, l.z1 + 1.4);
    this.add(box(3.2, 0.6, 0.18), M.accent, x, botY + 2.4, l.z1 + 2.2);

    // Slow-zone fencing and little slalom markers for lessons.
    const rng = this.rng;
    for (let i = 0; i < 14; i++) {
      const mx = l.x + rng.range(-l.halfX * 0.5, l.halfX * 0.75);
      const mz = lerp(l.z0 + 20, l.z1 - 15, i / 13);
      const my = this.groundY(mx, mz);
      this.add(cyl(0.05, 0.05, 1.3, 5), i % 2 ? M.accent : this.materials.metal, mx, my + 0.65, mz);
    }
  }

  // ── tubing lanes ────────────────────────────────────────────────
  buildTubing() {
    const tb = this.area.tubing;
    if (!tb) return;
    const M = this.materials;
    const rng = this.rng;

    // Padded lane dividers at the very bottom, plus a run-out barrier.
    for (let i = 0; i <= tb.lanes; i++) {
      const x = tb.x - tb.totalW / 2 + i * tb.laneW;
      for (let k = 0; k < 4; k++) {
        const z = lerp(tb.z0 + 20, tb.z1 - 6, k / 3);
        const y = this.groundY(x, z);
        this.add(cyl(0.09, 0.09, 1.5, 5), i % 2 ? M.accent : M.metal, x, y + 0.75, z);
      }
    }
    const barrierY = this.groundY(tb.x, tb.z1 + 6);
    this.add(box(tb.totalW + 4, 1.5, 1.0), M.accent, tb.x, barrierY + 0.75, tb.z1 + 6);

    // Tubes stacked at the bottom and scattered on the lanes.
    const tubeGeo = new THREE.TorusGeometry(0.62, 0.26, 6, 12);
    this.host.disposables.push(tubeGeo);
    const tubeMat = new THREE.MeshLambertMaterial({ color: 0x1c1f24 });
    this.host.materials.push(tubeMat);
    const count = 26;
    const inst = new THREE.InstancedMesh(tubeGeo, tubeMat, count);
    inst.castShadow = true;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    for (let i = 0; i < count; i++) {
      const stacked = i < 10;
      const x = stacked ? tb.x + tb.totalW / 2 + 3 : tb.x + rng.range(-tb.totalW / 2, tb.totalW / 2);
      const z = stacked ? tb.z1 + 3 : rng.range(tb.z0 + 25, tb.z1 - 8);
      const y = this.groundY(x, z) + (stacked ? 0.26 + (i % 10) * 0.5 : 0.26);
      q.copy(flat);
      m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i, m);
    }
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);

    // A ticket hut at the bottom of the lanes.
    const hy = this.groundY(tb.x - tb.totalW / 2 - 6, tb.z1 + 2);
    this.add(box(6, 4.2, 5), M.timber, tb.x - tb.totalW / 2 - 6, hy + 2.1, tb.z1 + 2);
    this.add(box(6.8, 0.4, 5.8), M.roof, tb.x - tb.totalW / 2 - 6, hy + 4.4, tb.z1 + 2);
  }

  // ── plaza dressing ──────────────────────────────────────────────
  buildPlazaDressing() {
    const a = this.area;
    const M = this.materials;
    const rng = this.rng;

    // Ski racks along the approach to the lodge.
    for (let r = 0; r < 6; r++) {
      const x = a.x - a.halfW * 0.1 + r * 6;
      const z = a.z0 + (a.z1 - a.z0) * 0.6;
      if (Math.abs(x) > this.t.halfW - 20) continue;
      const y = this.groundY(x, z);
      this.add(box(4.6, 0.12, 0.12), M.metal, x, y + 1.15, z);
      for (const s of [-1, 1]) this.add(cyl(0.06, 0.06, 1.2, 5), M.metal, x + s * 2.2, y + 0.6, z);
      // a few pairs of skis leaning on it
      for (let k = 0; k < rng.int(0, 4); k++) {
        const sx = x - 2 + k * 1.1;
        const ski = this.add(box(0.11, 1.75, 0.03), rng.pick(this.bright), sx, y + 0.9, z + 0.18);
        ski.rotation.x = 0.16;
      }
    }

    // Benches and bins scattered across the plaza.
    for (let i = 0; i < 10; i++) {
      const x = a.x + rng.range(-a.halfW * 0.7, a.halfW * 0.7);
      const z = lerp(a.z0 + 30, a.z1 - 20, rng());
      if (Math.abs(x) > this.t.halfW - 20) continue;
      const y = this.groundY(x, z);
      const ry = rng.range(0, Math.PI);
      this.add(box(2.4, 0.14, 0.55), M.timber, x, y + 0.5, z, ry);
      this.add(box(2.4, 0.5, 0.12), M.timber, x, y + 0.78, z + 0.24, ry);
      for (const s of [-1, 1]) {
        this.add(box(0.12, 0.5, 0.5), M.metalDark, x + Math.cos(ry) * s * 1.05, y + 0.25, z - Math.sin(ry) * s * 1.05, ry);
      }
    }

    // Flags on the plaza edge.
    for (let i = 0; i < 7; i++) {
      const x = a.x - a.halfW * 0.85 + (i * a.halfW * 1.7) / 6;
      const z = a.z0 + 14;
      if (Math.abs(x) > this.t.halfW - 14) continue;
      const y = this.groundY(x, z);
      this.add(cyl(0.09, 0.11, 7.5, 6), M.metal, x, y + 3.75, z);
      const flag = this.add(box(0.06, 1.1, 1.9), rng.pick(this.bright), x + 0.1, y + 6.6, z + 0.95, 0, false);
      flag.receiveShadow = false;
    }

    // A snowcat parked at the edge of the plaza.
    this.buildSnowcat(a.x + a.halfW * 0.82, a.z0 + (a.z1 - a.z0) * 0.28);

    // Plaza standards. On a night map these get real lights — a base area is
    // the brightest place on the hill, and it looked abandoned without them.
    const night = /night|moon/.test(this.spec.weather);
    for (let i = 0; i < 5; i++) {
      const x = a.x - a.halfW * 0.7 + (i * a.halfW * 1.4) / 4;
      const z = a.z0 + (a.z1 - a.z0) * (i % 2 ? 0.34 : 0.6);
      if (Math.abs(x) > this.t.halfW - 14) continue;
      const y = this.groundY(x, z);
      this.add(cyl(0.13, 0.19, 8.5, 6), M.metalDark, x, y + 4.25, z);
      this.add(box(1.3, 0.32, 0.7), M.lamp, x, y + 8.6, z, 0, false);
      if (night && this.host.lights.length < 6) {
        const light = new THREE.PointLight(0xffeecb, 420, 175, 2);
        light.position.set(x, y + 8.2, z);
        this.group.add(light);
        this.host.lights.push(light);
      }
    }
  }

  buildSnowcat(x, z) {
    if (Math.abs(x) > this.t.halfW - 20) return;
    const M = this.materials;
    const y = this.groundY(x, z);
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.y = 0.5;
    this.group.add(g);

    const put = (geo, mat, px, py, pz) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(px, py, pz);
      m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      return m;
    };
    for (const s of [-1, 1]) put(box(1.3, 1.0, 6.4), M.rubber, s * 1.7, 0.5, 0);
    put(box(3.4, 1.3, 5.0), M.cat, 0, 1.5, -0.2);
    put(box(2.6, 1.5, 2.4), M.glass, 0, 2.9, -1.2);
    put(box(2.7, 0.2, 2.5), M.metalDark, 0, 3.7, -1.2);
    const blade = put(box(5.6, 1.4, 0.4), M.metal, 0, 1.0, -3.6);
    blade.rotation.x = 0.2;
    put(box(4.4, 0.9, 0.3), M.metal, 0, 1.1, 3.5);      // tiller housing
    put(cyl(0.06, 0.06, 2.4, 5), M.metalDark, 1.4, 4.6, -0.6);
    this.host.collidables.push({ x, z, r: 3.6, kind: 'rock' });
  }

  // ── people standing around ──────────────────────────────────────
  buildPeople() {
    const a = this.area;
    const rng = this.rng;
    const spots = [];

    const push = (x, z, facing) => {
      if (Math.abs(x) > this.t.halfW - 12) return;
      spots.push({ x, z, y: this.groundY(x, z), ry: facing ?? rng.range(0, Math.PI * 2) });
    };

    // Queuing at each base lift.
    for (const lift of this.host.lifts) {
      const base = lift.pts[0];
      if (base.z < a.z0 - 60) continue;
      for (let i = 0; i < 16; i++) {
        push(base.x + rng.range(-5, 5), base.z - 14 - rng() * 14, rng.range(-0.4, 0.4));
      }
    }
    // Milling about the plaza and the lodge deck.
    for (let i = 0; i < 34; i++) {
      push(a.x + rng.range(-a.halfW * 0.85, a.halfW * 0.85), lerp(a.z0 + 20, a.z1 - 18, rng()));
    }
    // On the beginner slope.
    for (let i = 0; i < 12; i++) {
      push(a.learn.x + rng.range(-a.learn.halfX, a.learn.halfX), lerp(a.learn.z0, a.learn.z1, rng()));
    }
    if (a.tubing) {
      for (let i = 0; i < 14; i++) {
        push(a.tubing.x + rng.range(-a.tubing.totalW / 2, a.tubing.totalW / 2), a.tubing.z1 + rng.range(2, 16));
      }
    }
    if (!spots.length) return;

    const { jacketGeo, gearGeo } = standingPerson();
    this.host.disposables.push(jacketGeo, gearGeo);
    const jacketMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    const gearMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.host.materials.push(jacketMat, gearMat);

    const jackets = new THREE.InstancedMesh(jacketGeo, jacketMat, spots.length);
    const gear = new THREE.InstancedMesh(gearGeo, gearMat, spots.length);
    for (const inst of [jackets, gear]) { inst.castShadow = true; inst.receiveShadow = false; }

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    spots.forEach((s, i) => {
      const scale = rng.range(0.9, 1.08);
      q.setFromAxisAngle(up, s.ry);
      m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(scale, scale, scale));
      jackets.setMatrixAt(i, m);
      gear.setMatrixAt(i, m);
      col.setHex(rng.pick(JACKETS));
      jackets.setColorAt(i, col);
    });
    jackets.instanceMatrix.needsUpdate = true;
    gear.instanceMatrix.needsUpdate = true;
    if (jackets.instanceColor) jackets.instanceColor.needsUpdate = true;
    this.group.add(jackets, gear);
    this.peopleCount = spots.length;
  }

  /** Terrain height, but never below the plaza's drained surface. */
  groundY(x, z) {
    return this.t.heightAt(x, z);
  }
}

// ── shared geometry builders ──────────────────────────────────────
function mergeParts(parts) {
  let total = 0;
  const prepared = parts.map(({ geo, matrix, color }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    return { g, color: color === undefined ? null : new THREE.Color(color) };
  });

  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const { g, color } of prepared) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const c = g.attributes.position.count;
    for (let i = 0; i < c; i++) {
      const oi = (o + i) * 3;
      pos[oi] = p[i * 3]; pos[oi + 1] = p[i * 3 + 1]; pos[oi + 2] = p[i * 3 + 2];
      nor[oi] = n[i * 3]; nor[oi + 1] = n[i * 3 + 1]; nor[oi + 2] = n[i * 3 + 2];
      if (color) { col[oi] = color.r; col[oi + 1] = color.g; col[oi + 2] = color.b; }
      else { col[oi] = 1; col[oi + 1] = 1; col[oi + 2] = 1; }
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

const UNIT = new THREE.Vector3(1, 1, 1);

/** Concatenate already-transformed geometries. Position and normal only. */
function mergePlain(geos) {
  let total = 0;
  for (const g of geos) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.computeBoundingSphere();
  return out;
}

const at = (x, y, z, ry = 0) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z),
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), ry),
  new THREE.Vector3(1, 1, 1),
);

/** Car paintwork. Carries no vertex colour so instanceColor can tint it. */
function carBody() {
  return mergeParts([
    { geo: box(1.8, 0.72, 4.3), matrix: at(0, 0.72, 0) },
    { geo: box(1.66, 0.52, 2.4), matrix: at(0, 1.32, -0.1) },
    { geo: box(1.84, 0.16, 4.34), matrix: at(0, 0.44, 0) },
  ]);
}

/** Glazing and wheels — dark, and deliberately immune to the paint tint. */
function carTrim() {
  const parts = [
    { geo: box(1.7, 0.4, 2.2), matrix: at(0, 1.36, -0.1), color: 0x1b2026 },
  ];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const w = new THREE.CylinderGeometry(0.34, 0.34, 0.22, 8);
      w.rotateZ(Math.PI / 2);
      parts.push({ geo: w, matrix: at(sx * 0.86, 0.34, sz * 1.42), color: 0x16181c });
    }
  }
  return mergeParts(parts);
}

/** Someone standing in ski gear, boots planted, skis over the shoulder. */
function standingPerson() {
  const jacket = [
    { geo: box(0.44, 0.6, 0.28), matrix: at(0, 1.14, 0), color: 0xffffff },
    { geo: box(0.16, 0.52, 0.18), matrix: at(-0.3, 1.1, 0), color: 0xffffff },
    { geo: box(0.16, 0.52, 0.18), matrix: at(0.3, 1.1, 0), color: 0xffffff },
    { geo: box(0.34, 0.16, 0.24), matrix: at(0, 1.44, -0.05), color: 0xffffff },
  ];
  const gear = [
    { geo: box(0.19, 0.56, 0.2), matrix: at(-0.13, 0.55, 0), color: 0x30363f },
    { geo: box(0.19, 0.56, 0.2), matrix: at(0.13, 0.55, 0), color: 0x30363f },
    { geo: box(0.16, 0.24, 0.32), matrix: at(-0.13, 0.16, 0.03), color: 0x22262c },
    { geo: box(0.16, 0.24, 0.32), matrix: at(0.13, 0.16, 0.03), color: 0x22262c },
    { geo: box(0.2, 0.2, 0.2), matrix: at(0, 1.58, 0), color: 0xd9a683 },
    { geo: new THREE.IcosahedronGeometry(0.155, 1), matrix: at(0, 1.64, -0.01), color: 0x22262c },
    { geo: box(0.19, 0.07, 0.06), matrix: at(0, 1.6, 0.1), color: 0x4aa8d8 },
    // skis shouldered
    { geo: box(0.1, 1.9, 0.03), matrix: at(0.34, 1.35, 0.12, 0.2), color: 0x1f6fb2 },
  ];
  return { jacketGeo: mergeParts(jacket), gearGeo: mergeParts(gear) };
}
