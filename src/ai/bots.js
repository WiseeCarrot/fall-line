// Other people on the mountain.
//
// They aren't racing you and they don't know you exist beyond not skiing into
// you. Each one has a skill level that sets how fast they go, how tight they
// turn, how close to the fall line they stay, and whether they take the jumps.
// They ski to the bottom, then respawn up top as if they'd ridden the lift.

import * as THREE from 'three';
import { makeRng, clamp, damp, wrapAngle, angleDelta } from '../core/math.js';

const GRAVITY = 20;

const JACKETS = [
  0xd94f2b, 0x2f6ea8, 0xe8b93c, 0x3fa34d, 0x8e4bb5, 0xe8734a,
  0x24303d, 0xf0f3f6, 0x1f9c9c, 0xc9345f, 0x5b6470, 0xffa62b,
];

const SKILLS = [
  { name: 'beginner',     speed: 8,  turnRate: 1.5, amp: 0.85, period: 3.6, jumps: false, stopChance: 0.35 },
  { name: 'cautious',     speed: 12, turnRate: 1.7, amp: 0.7,  period: 3.0, jumps: false, stopChance: 0.2 },
  { name: 'intermediate', speed: 17, turnRate: 2.0, amp: 0.55, period: 2.6, jumps: false, stopChance: 0.1 },
  { name: 'strong',       speed: 23, turnRate: 2.3, amp: 0.4,  period: 2.2, jumps: true,  stopChance: 0.05 },
  { name: 'expert',       speed: 29, turnRate: 2.6, amp: 0.28, period: 1.9, jumps: true,  stopChance: 0.02 },
];

function buildBotGeometry() {
  // Two meshes: `jacket` gets tinted per instance, `gear` keeps its own colours.
  const jacketParts = [];
  const gearParts = [];

  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const at = (x, y, z, rx = 0, rz = 0) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)),
    new THREE.Vector3(1, 1, 1),
  );

  // jacket: torso + arms + hood
  jacketParts.push({ geo: box(0.44, 0.58, 0.28), matrix: at(0, 1.02, 0), color: 0xffffff });
  jacketParts.push({ geo: box(0.15, 0.5, 0.17), matrix: at(-0.29, 1.0, 0.02, 0.35), color: 0xffffff });
  jacketParts.push({ geo: box(0.15, 0.5, 0.17), matrix: at(0.29, 1.0, 0.02, 0.35), color: 0xffffff });
  jacketParts.push({ geo: box(0.34, 0.16, 0.24), matrix: at(0, 1.3, -0.06), color: 0xffffff });

  // gear: skis, boots, legs, head, helmet, poles, pack
  for (const s of [-1, 1]) {
    gearParts.push({ geo: box(0.1, 0.024, 1.68), matrix: at(s * 0.14, 0.03, -0.06), color: 0x1b1e24 });
    gearParts.push({ geo: box(0.1, 0.02, 0.26), matrix: at(s * 0.14, 0.07, -0.94, 0.45), color: 0x1b1e24 });
    gearParts.push({ geo: box(0.14, 0.19, 0.3), matrix: at(s * 0.14, 0.15, 0), color: 0x2a2e35 });
    gearParts.push({ geo: box(0.17, 0.52, 0.2), matrix: at(s * 0.13, 0.5, 0), color: 0x30363f });
    gearParts.push({ geo: new THREE.CylinderGeometry(0.012, 0.01, 1.15, 5), matrix: at(s * 0.36, 0.72, 0.12, -0.5), color: 0x9aa1a9 });
    gearParts.push({ geo: new THREE.CylinderGeometry(0.05, 0.05, 0.012, 7), matrix: at(s * 0.36, 0.2, 0.42), color: 0x40454d });
  }
  gearParts.push({ geo: box(0.2, 0.2, 0.2), matrix: at(0, 1.44, 0), color: 0xd9a683 });
  gearParts.push({ geo: new THREE.IcosahedronGeometry(0.155, 1), matrix: at(0, 1.5, -0.01), color: 0x22262c });
  gearParts.push({ geo: box(0.19, 0.07, 0.06), matrix: at(0, 1.46, 0.1), color: 0x4aa8d8 });

  return { jacketParts, gearParts };
}

export class BotCrowd {
  constructor(terrain, spec, collisions, quality = 1) {
    this.terrain = terrain;
    this.spec = spec;
    this.collisions = collisions;
    this.rng = makeRng(spec.seed ^ 0x7c33);
    this.group = new THREE.Group();
    this.bots = [];
    // Detail scaling trims the crowd, but some hills are *about* the crowd —
    // `botsMin` is the floor below which the map stops being itself.
    const scaled = Math.round((spec.bots ?? 10) * clamp(quality, 0.4, 1.2));
    this.count = Math.max(0, Math.max(scaled, spec.botsMin ?? 0));
    this._scratch = [];
  }

  build() {
    if (this.count === 0) return this;
    const { jacketParts, gearParts } = buildBotGeometry();
    this.jacketGeo = mergeSimple(jacketParts);
    this.gearGeo = mergeSimple(gearParts);

    this.jacketMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.gearMat = new THREE.MeshLambertMaterial({ vertexColors: true });

    this.jacketMesh = new THREE.InstancedMesh(this.jacketGeo, this.jacketMat, this.count);
    this.gearMesh = new THREE.InstancedMesh(this.gearGeo, this.gearMat, this.count);
    for (const m of [this.jacketMesh, this.gearMesh]) {
      m.castShadow = true;
      m.frustumCulled = false;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }

    const color = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      const bot = this.spawn(true);
      this.bots.push(bot);
      color.setHex(bot.jacket);
      this.jacketMesh.setColorAt(i, color);
    }
    if (this.jacketMesh.instanceColor) this.jacketMesh.instanceColor.needsUpdate = true;

    return this;
  }

  /** Pick a skill weighted by how hard the map is. */
  pickSkill() {
    const d = this.spec.difficulty;
    const weights = {
      green:  [5, 4, 2, 1, 0.4],
      blue:   [1.5, 3, 4, 2.5, 1],
      black:  [0.2, 0.8, 2, 4, 3],
      dblack: [0, 0.2, 1, 3, 5],
      park:   [0.5, 1.5, 3, 3, 2],
      back:   [0, 0.5, 1.5, 3, 4],
    }[d] || [1, 1, 1, 1, 1];

    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.rng() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r <= 0) return SKILLS[i];
    }
    return SKILLS[2];
  }

  spawn(initial = false) {
    const t = this.terrain;
    const rng = this.rng;
    const skill = this.pickSkill();

    // Spread the initial population down the whole hill; respawns come in
    // near the top, like they just unloaded the lift.
    const zFrac = initial ? rng.range(0.03, 0.92) : rng.range(0.01, 0.1);
    const trail = t.trails[rng.int(0, t.trails.length - 1)];
    const si = clamp(Math.round(zFrac * (trail.samples.length - 1)), 0, trail.samples.length - 1);
    const p = trail.samples[si];
    const spread = trail.width * 0.42;
    const x = clamp(p.x + rng.range(-spread, spread), -t.halfW + 20, t.halfW - 20);
    const z = clamp(p.z, 15, t.length - 60);

    return {
      x, z,
      y: t.heightAt(x, z),
      vy: 0,
      airborne: false,
      heading: 0,
      speed: rng.range(3, skill.speed * 0.6),
      skill,
      phase: rng.range(0, 100),
      period: skill.period * rng.range(0.75, 1.35),
      amp: skill.amp * rng.range(0.8, 1.25),
      lean: 0,
      turnRate: 0,
      scale: rng.range(0.92, 1.1),
      jacket: rng.pick(JACKETS),
      stopTimer: 0,
      restTimer: rng.range(8, 40),
      avoid: 0,
    };
  }

  update(dt, playerPos) {
    if (!this.bots.length) return;
    const t = this.terrain;
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const euler = new THREE.Euler(0, 0, 0, 'YXZ');
    const nrm = new THREE.Vector3();

    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i];
      this.step(b, dt, nrm, playerPos);

      pos.set(b.x, b.y, b.z);
      // Sit the skier on the slope, banked into the turn.
      t.normalAt(b.x, b.z, nrm);
      const pitch = -Math.atan2(
        nrm.x * Math.sin(b.heading) + nrm.z * Math.cos(b.heading),
        Math.max(0.2, nrm.y),
      );
      euler.set(b.airborne ? -0.12 : pitch, b.heading, b.lean * 0.45);
      quat.setFromEuler(euler);
      scl.setScalar(b.scale);
      m.compose(pos, quat, scl);
      this.jacketMesh.setMatrixAt(i, m);
      this.gearMesh.setMatrixAt(i, m);
    }

    this.jacketMesh.instanceMatrix.needsUpdate = true;
    this.gearMesh.instanceMatrix.needsUpdate = true;
  }

  step(b, dt, nrm, playerPos) {
    const t = this.terrain;
    const ground = t.heightAt(b.x, b.z);
    t.normalAt(b.x, b.z, nrm);

    // ── airborne arc, entered when the ground drops away ─────────
    if (b.airborne) {
      b.vy -= GRAVITY * dt;
      b.y += b.vy * dt;
      b.x += Math.sin(b.heading) * b.speed * dt;
      b.z += Math.cos(b.heading) * b.speed * dt;
      if (b.y <= ground) {
        b.y = ground;
        b.vy = 0;
        b.airborne = false;
        b.speed *= 0.92;
      }
      b.lean = damp(b.lean, 0, 5, dt);
      return;
    }

    // ── resting ──────────────────────────────────────────────────
    if (b.stopTimer > 0) {
      b.stopTimer -= dt;
      b.speed = damp(b.speed, 0, 4, dt);
      b.y = ground;
      b.lean = damp(b.lean, 0, 4, dt);
      b.x += Math.sin(b.heading) * b.speed * dt;
      b.z += Math.cos(b.heading) * b.speed * dt;
      return;
    }

    b.restTimer -= dt;
    if (b.restTimer <= 0) {
      b.restTimer = 20 + this.rng.range(0, 60);
      if (this.rng() < b.skill.stopChance) b.stopTimer = this.rng.range(1.5, 6);
    }

    // ── choose a heading: fall line, plus a rhythmic S-turn ──────
    const fall = t.fallLineHeading(b.x, b.z);
    b.phase += dt / b.period;
    let desired = fall + Math.sin(b.phase * Math.PI * 2) * b.amp;

    // Steer around trees and rocks that are close and ahead.
    const look = 6 + b.speed * 0.5;
    const ax = b.x + Math.sin(b.heading) * look * 0.5;
    const az = b.z + Math.cos(b.heading) * look * 0.5;
    const hits = this.collisions.query(ax, az, look * 0.6, this._scratch);
    let avoid = 0;
    for (const c of hits) {
      const dx = c.x - b.x, dz = c.z - b.z;
      const dist = Math.hypot(dx, dz);
      if (dist > look || dist < 0.001) continue;
      const bearing = angleDelta(b.heading, Math.atan2(dx, dz));
      if (Math.abs(bearing) > 0.85) continue;
      const urgency = (1 - dist / look) * (1 - Math.abs(bearing) / 0.85);
      avoid -= Math.sign(bearing || 1) * urgency * 1.6;
    }

    // Stay inside the boundary and away from the player.
    const edge = Math.abs(b.x) / (t.halfW - 20);
    if (edge > 0.85) avoid += -Math.sign(b.x) * (edge - 0.85) * 12;
    if (playerPos) {
      const dx = playerPos.x - b.x, dz = playerPos.z - b.z;
      const d = Math.hypot(dx, dz);
      if (d < 12) {
        const bearing = angleDelta(b.heading, Math.atan2(dx, dz));
        if (Math.abs(bearing) < 1.0) avoid -= Math.sign(bearing || 1) * (1 - d / 12) * 2.2;
      }
    }

    b.avoid = damp(b.avoid, avoid, 6, dt);
    desired += b.avoid;

    const delta = angleDelta(b.heading, desired);
    const turn = clamp(delta * 3.0, -b.skill.turnRate, b.skill.turnRate);
    b.heading = wrapAngle(b.heading + turn * dt);
    b.turnRate = damp(b.turnRate, turn, 8, dt);
    b.lean = clamp(b.turnRate / b.skill.turnRate, -1, 1) * clamp(b.speed / 14, 0, 1);

    // ── speed: gravity down the slope, held in check by turning ──
    const steepness = clamp(1 - nrm.y, 0, 1) * 3.2;
    const surface = t.surfaceAt(b.x, b.z);
    const targetSpeed = b.skill.speed * (0.45 + steepness) * (1 - surface.deep * 0.9) * (1 - Math.abs(b.lean) * 0.28);
    b.speed = damp(b.speed, clamp(targetSpeed, 1.5, 42), 1.4, dt);

    const nx = b.x + Math.sin(b.heading) * b.speed * dt;
    const nz = b.z + Math.cos(b.heading) * b.speed * dt;
    const nextGround = t.heightAt(nx, nz);

    // If the ground fell away faster than we can follow it, we're in the air.
    const drop = b.y - nextGround;
    const maxFollow = b.speed * dt * 1.1 + 0.25;
    if (drop > maxFollow && b.skill.jumps && b.speed > 8) {
      b.airborne = true;
      b.vy = Math.max(0.5, b.speed * 0.12);
    }

    b.x = nx;
    b.z = nz;
    b.y = b.airborne ? b.y : nextGround;

    // ── recycle at the bottom ────────────────────────────────────
    if (b.z > t.length - 40 || Math.abs(b.x) > t.halfW - 12) {
      const fresh = this.spawn(false);
      Object.assign(b, fresh, { jacket: b.jacket, scale: b.scale });
    }
  }

  /** The n closest bots to a point, for driving positional audio. */
  nearest(point, n, out = []) {
    out.length = 0;
    for (const b of this.bots) {
      const d = (b.x - point.x) ** 2 + (b.z - point.z) ** 2;
      if (d < 4900) out.push({ bot: b, d });
    }
    out.sort((a, c) => a.d - c.d);
    out.length = Math.min(out.length, n);
    return out;
  }

  dispose() {
    this.jacketGeo?.dispose();
    this.gearGeo?.dispose();
    this.jacketMat?.dispose();
    this.gearMat?.dispose();
    this.jacketMesh?.dispose();
    this.gearMesh?.dispose();
  }
}

/** Minimal merge for the bot parts — same idea as props.mergeParts. */
function mergeSimple(parts) {
  let total = 0;
  const prepared = parts.map(({ geo, matrix, color }) => {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    total += g.attributes.position.count;
    return { g, color: new THREE.Color(color) };
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
      col[oi] = color.r; col[oi + 1] = color.g; col[oi + 2] = color.b;
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
