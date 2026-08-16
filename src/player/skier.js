// Ski physics.
//
// The model is deliberately simple but behaves like skiing because of one
// idea: the skis have a *heading*, and the snow resists any velocity that
// isn't along that heading. Tip them on edge and that resistance goes way up,
// so rotating the heading drags the velocity around with it — that's a carve.
// Flatten them and the lateral resistance drops, so you skid.
//
// Everything else (gravity along the slope, drag, powder, ice, air time) hangs
// off that.

import * as THREE from 'three';
import { clamp, lerp, damp, wrapAngle } from '../core/math.js';

const GRAVITY = 20.0;
// How far the ground may drop below the skis before we count it as airborne.
// Small enough that rollovers and lips launch you, large enough that ordinary
// chatter doesn't flicker in and out of flight.
const GROUND_TOLERANCE = 0.14;
// Skis hang below the eye line, so you need a little more than nothing to
// actually pass over something.
const SKI_CLEARANCE = 0.35;
const LIFT_LOAD_RADIUS = 26;   // how close to a base terminal counts as loading
const LIFT_SEAT_DROP = 2.6;    // seat height below the cable
const LIFT_SEAT_SIDE = -2.3;   // chairs hang on the uphill side of the line

const TUNING = {
  dragUpright: 0.0125,   // v² air drag
  dragTuck: 0.0062,
  frictionGroomed: 0.055,
  frictionPowder: 0.22,
  frictionIce: 0.022,
  frictionRock: 0.42,
  brakeFriction: 0.85,
  turnRate: 2.15,        // rad/s at walking pace
  turnSpeedFalloff: 0.034,
  gripBase: 2.6,
  gripEdge: 15.0,
  skidGrip: 0.9,
  jumpImpulse: 6.2,
  // Skating. Holding W pushes you along under your own power, strongest from
  // a standstill and fading out as you pick up speed — you cannot skate your
  // way to 60 km/h, but you can always get moving on a flat.
  skateThrust: 7.0,
  skateMax: 9.5,
  maxSpeed: 58,
  crashImpact: 13.5,     // normal-velocity that ends a landing badly
  crashSpeed: 12.0,      // speed above which hitting a tree is a crash
  eyeHeight: 1.62,
};

export class Skier {
  constructor(terrain, spec) {
    this.terrain = terrain;
    this.spec = spec;

    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.heading = 0;
    this.grounded = true;
    this.airTime = 0;
    this.groundNormal = new THREE.Vector3(0, 1, 0);

    // presentation / feedback state
    this.edge = 0;          // signed lean, -1 left .. +1 right
    this.edgeLoad = 0;      // 0..1 how hard the edge is working
    this.slip = 0;          // 0..1 sideways slide
    this.lean = 0;          // smoothed body lean for the camera
    this.crouch = 0;
    this.bob = 0;
    this.rough = 0;
    this.gForce = 1;
    this.grinding = 0;
    this.skating = 0;
    this.skateBeat = 0;
    this.exposure = 0;   // 0 = on the line, 1 = about to go over the edge
    this.currentRail = null;

    this.crashed = false;
    this.crashTimer = 0;
    this.crashSpin = 0;
    this.airborneJustNow = false;

    this.surface = { groom: 1, ice: 0, rock: 0, deep: 0, paved: 0 };
    this.events = [];       // drained by the game each frame

    this.stats = { distance: 0, descent: 0, airTimeTotal: 0, topSpeed: 0, biggestAir: 0, runTime: 0 };
    this._lastAirStart = 0;
    this._peakAir = 0;

    this.reset();
  }

  reset(point) {
    const p = point || this.terrain.startPoint();
    this.pos.set(p.x, this.terrain.heightAt(p.x, p.z) + 0.12, p.z);
    this.vel.set(0, 0, 1.5);
    this.heading = 0;
    this.grounded = true;
    this.crashed = false;
    this.crashTimer = 0;
    this.airTime = 0;
    this.edge = 0;
    this.grinding = 0;
    this.currentRail = null;
    this.riding = null;
    this.nearLift = null;
    this.reachedBase = false;
    this.stats = { distance: 0, descent: 0, airTimeTotal: 0, topSpeed: 0, biggestAir: 0, runTime: 0 };
    this._startY = this.pos.y;
  }

  get speed() { return Math.hypot(this.vel.x, this.vel.z); }
  get airSpeed() { return this.vel.length(); }

  emit(type, data) { this.events.push({ type, ...data }); }

  /** Forward direction of the skis, flattened to the world plane. */
  headingVec(out = new THREE.Vector3()) {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  update(dt, input, world) {
    dt = Math.min(dt, 1 / 30);
    this.stats.runTime += dt;

    if (this.riding) {
      this.updateRide(dt, input, world);
      return;
    }

    if (this.crashed) {
      this.updateCrashed(dt, input);
      return;
    }

    this.nearLift = this.findLift(world);
    if (this.nearLift && input.boardPressed) this.board(this.nearLift, world);

    const terrain = this.terrain;
    const groundY = terrain.heightAt(this.pos.x, this.pos.z);
    terrain.normalAt(this.pos.x, this.pos.z, this.groundNormal);
    this.surface = terrain.surfaceAt(this.pos.x, this.pos.z);

    // How bumpy it is right here — drives camera shake and the audio chatter.
    const hs = terrain.heightAt.bind(terrain);
    const around =
      (hs(this.pos.x + 3, this.pos.z) + hs(this.pos.x - 3, this.pos.z) +
       hs(this.pos.x, this.pos.z + 3) + hs(this.pos.x, this.pos.z - 3)) * 0.25;
    this.rough = clamp(Math.abs(groundY - around) / 1.1, 0, 1);

    const wasGrounded = this.grounded;
    const skiY = groundY + 0.12;
    this.grounded = this.pos.y <= skiY + 0.06;

    // ── rails ────────────────────────────────────────────────────
    this.updateRail(dt, input, world);
    this.grinding = this.currentRail ? 1 : damp(this.grinding, 0, 9, dt);

    if (this.currentRail) {
      this.integrateRail(dt, input);
    } else if (this.grounded) {
      this.integrateGround(dt, input, skiY);
    } else {
      this.integrateAir(dt, input);
    }

    // ── collisions with trees, rocks, poles ──────────────────────
    if (world?.collisions) this.resolveCollisions(dt, world);

    // ── keep the skier on the mountain ───────────────────────────
    this.checkExposure();
    this.enforceBounds();

    // ── presentation smoothing ───────────────────────────────────
    const targetLean = clamp(this.edge, -1, 1) * clamp(this.speed / 18, 0, 1);
    this.lean = damp(this.lean, targetLean, 7, dt);
    const targetCrouch = input.tuck ? 1 : input.brake ? 0.45 : 0;
    this.crouch = damp(this.crouch, this.grounded ? targetCrouch : 0.25, 6, dt);

    if (this.grounded && this.speed > 0.7) {
      // Bob rate follows how fast the terrain is passing under you.
      this.bob += dt * (2.2 + this.speed * 0.32);
    }

    // Skating has a rhythm to it — one push per stride, quickening as you go.
    if (this.skating > 0.15 && this.grounded) {
      this.skateBeat -= dt * (1.5 + this.speed * 0.22);
      if (this.skateBeat <= 0) {
        this.skateBeat = 1;
        this.emit('polePush');
      }
    } else {
      this.skateBeat = 0;
    }

    this.stats.topSpeed = Math.max(this.stats.topSpeed, this.speed);
    this.stats.distance += this.speed * dt;
    this.stats.descent = Math.max(0, this._startY - this.pos.y);
  }

  // ── on the snow ────────────────────────────────────────────────
  integrateGround(dt, input, skiY) {
    const n = this.groundNormal;
    const s = this.surface;

    // Basis on the slope plane.
    const fwd = this.headingVec(_v1);
    fwd.addScaledVector(n, -fwd.dot(n));
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1);
    fwd.normalize();
    const right = _v2.crossVectors(fwd, n).normalize();

    // Steering. Turn rate falls off with speed so high-speed lines stay long.
    const steer = clamp(input.steer, -1, 1);
    const rate = TUNING.turnRate / (1 + this.speed * TUNING.turnSpeedFalloff);
    const skidBonus = input.brake ? 1.9 : 1;
    this.heading = wrapAngle(this.heading + steer * rate * skidBonus * dt);
    this.edge = damp(this.edge, steer, 9, dt);

    // Full gravity, then a one-sided ground reaction.
    //
    // This is the part that makes kickers work. Projecting the velocity onto
    // the slope plane every frame lets the ground *pull* as well as push: when
    // the surface tilts away under you the projection rotates your velocity
    // downward, so you obediently follow the lip down the back of the jump
    // instead of launching off it. Cancelling only the component travelling
    // into the snow leaves you free to separate from any convex feature.
    this.vel.y -= GRAVITY * dt;
    const into = this.vel.dot(n);
    if (into < 0) this.vel.addScaledVector(n, -into);

    // Decompose into forward / lateral / normal.
    let vF = this.vel.dot(fwd);
    let vR = this.vel.dot(right);
    const vN = Math.max(0, this.vel.dot(n));

    // ── edge grip ───────────────────────────────────────────────
    // A carve redirects momentum; a skid destroys it. So rather than simply
    // damping the sideways velocity (which would bleed speed every time you
    // turned), rotate the velocity vector toward the skis and only charge for
    // the part of that rotation the edges *weren't* clean enough to carve.
    const edgeMag = Math.abs(this.edge);
    let grip = TUNING.gripBase + TUNING.gripEdge * edgeMag * edgeMag;
    grip *= 1 - s.ice * 0.62;                  // ice lets go
    grip *= 1 + s.deep * 1.1;                  // powder holds
    if (input.brake) grip *= TUNING.skidGrip;  // deliberate skid

    let carveQuality = clamp(edgeMag * 1.35, 0, 1) * (1 - s.ice * 0.55) * (1 - s.rock * 0.6);
    if (input.brake) carveQuality *= 0.15;

    const vMag = Math.hypot(vF, vR);
    let scrubbed = 0;
    if (vMag > 0.02) {
      const ang = Math.atan2(vR, vF);
      const align = 1 - Math.exp(-grip * dt);
      const newAng = ang * (1 - align);
      scrubbed = Math.abs(ang - newAng);
      const loss = (1 - carveQuality) * scrubbed * 0.75;
      const newMag = vMag * Math.max(0, 1 - loss);
      vF = newMag * Math.cos(newAng);
      vR = newMag * Math.sin(newAng);
    }

    // Forward resistance: snow friction + air drag.
    // Note the clamps — an unclamped lerp here extrapolates, and deep snow
    // ends up with more friction than gravity can overcome.
    const normalForce = Math.max(0.15, n.y) * GRAVITY;
    let mu = lerp(TUNING.frictionGroomed, TUNING.frictionPowder, clamp(s.deep * 2.4, 0, 1));
    mu = lerp(mu, TUNING.frictionIce, clamp(s.ice, 0, 1));
    mu = lerp(mu, TUNING.frictionRock, clamp(s.rock * 0.7, 0, 1));
    // Tarmac is not a ski surface. You get about two metres into the car park.
    if (s.paved > 0.02) mu = lerp(mu, 1.4, s.paved);
    if (input.brake) mu += TUNING.brakeFriction * (0.4 + edgeMag * 0.6);

    // Ploughing through deep snow is mostly a drag problem, not a friction
    // one: it's what keeps powder slow without making it unskiable.
    let drag = input.tuck ? TUNING.dragTuck : TUNING.dragUpright;
    drag *= 1 + s.deep * 1.8;
    const speedAbs = Math.abs(vF);
    const decel = mu * normalForce + drag * speedAbs * speedAbs * Math.sign(speedAbs || 1);
    vF -= Math.sign(vF || 1) * Math.min(Math.abs(vF) / Math.max(dt, 1e-4), decel) * dt;

    // Skating. W has only ever meant "tuck", which *reduces* drag — so on a
    // flat it did nothing whatsoever and gravity was the sole engine. Now it
    // also propels: hard from a standstill, tapering to nothing by the time
    // you're moving faster than anyone can actually skate.
    this.skating = 0;
    if (input.tuck && !input.brake) {
      const fade = 1 - clamp(vF / TUNING.skateMax, 0, 1);
      if (fade > 0) {
        // Deep snow and tarmac give the edges little to push against.
        const purchase = (1 - s.deep * 0.55) * (1 - (s.paved ?? 0) * 0.85);
        const thrust = TUNING.skateThrust * fade * fade * purchase;
        vF += thrust * dt;
        this.skating = clamp(fade * purchase, 0, 1);
      }
    }

    // Pole push to get going on the flats, otherwise pop off the snow.
    let jumping = false;
    if (input.jumpPressed) {
      if (this.speed < 4.5) {
        vF += 3.4;
        this.emit('polePush');
      } else {
        jumping = true;
      }
    }

    // Recompose, keeping any outward normal velocity so we can leave the snow.
    this.vel.copy(fwd).multiplyScalar(vF)
      .addScaledVector(right, vR)
      .addScaledVector(n, vN);

    if (jumping) {
      this.doJump(n);
      return;
    }

    // Feedback values.
    this.slip = clamp(scrubbed * (1 - carveQuality) * 14 + Math.abs(vR) / Math.max(4, this.speed * 0.7), 0, 1);
    this.edgeLoad = clamp(edgeMag * clamp(this.speed / 12, 0, 1) * (1 - this.slip * 0.35), 0, 1);
    this.gForce = clamp(1 + (edgeMag * this.speed * this.speed) / 900, 1, 3.2);

    // Move, then stick to the surface.
    this.pos.addScaledVector(this.vel, dt);
    const newGround = this.terrain.heightAt(this.pos.x, this.pos.z);
    const rise = newGround + 0.12 - this.pos.y;

    if (rise < -GROUND_TOLERANCE) {
      // The ground fell away from under us. No threshold gymnastics needed —
      // the velocity was never rotated to follow it, so this is simply the
      // moment the ballistic path and the surface part company.
      this.grounded = false;
      this.airTime = 0;
      this._peakAir = 0;
      this._lastAirStart = this.pos.y;
    } else {
      this.pos.y = newGround + 0.12;

      // Re-seat on the new surface, again cancelling only inward motion.
      const nn = this.terrain.normalAt(this.pos.x, this.pos.z, _v4);
      const into2 = this.vel.dot(nn);
      if (into2 < 0) this.vel.addScaledVector(nn, -into2);

      // A rise we ploughed into is a compression, and compressions cost speed.
      if (rise > 0.55 * Math.max(0.4, this.speed * dt)) {
        const loss = clamp(rise * 0.35, 0, this.speed * 0.5);
        const sp = this.speed;
        if (sp > 0.01) {
          const k = Math.max(0, sp - loss) / sp;
          this.vel.x *= k; this.vel.z *= k;
        }
      }
    }

    if (this.speed > TUNING.maxSpeed) {
      const k = TUNING.maxSpeed / this.speed;
      this.vel.x *= k; this.vel.z *= k;
    }
  }

  doJump(n) {
    const pop = TUNING.jumpImpulse * (0.75 + this.crouch * 0.5);
    this.vel.addScaledVector(n, pop);
    this.vel.y = Math.max(this.vel.y, pop * 0.7);
    this.pos.y += 0.15;
    this.grounded = false;
    this.airTime = 0;
    this._peakAir = 0;
    this._lastAirStart = this.pos.y;
    this.emit('jump', { power: clamp(pop / TUNING.jumpImpulse, 0.3, 1.4) });
  }

  // ── in the air ─────────────────────────────────────────────────
  integrateAir(dt, input) {
    this.airTime += dt;
    this.stats.airTimeTotal += dt;

    // Limited in-air steering: you can rotate the skis, not change trajectory.
    const steer = clamp(input.steer, -1, 1);
    this.heading = wrapAngle(this.heading + steer * 1.5 * dt);
    this.edge = damp(this.edge, steer * 0.55, 5, dt);

    this.vel.y -= GRAVITY * dt;
    const drag = input.tuck ? TUNING.dragTuck * 0.8 : TUNING.dragUpright * 0.85;
    const sp = this.vel.length();
    if (sp > 0.01) this.vel.addScaledVector(this.vel, -drag * sp * dt);

    this.pos.addScaledVector(this.vel, dt);

    this.slip = damp(this.slip, 0, 4, dt);
    this.edgeLoad = damp(this.edgeLoad, 0, 5, dt);
    this.gForce = damp(this.gForce, 0.15, 6, dt);

    const groundY = this.terrain.heightAt(this.pos.x, this.pos.z);
    this._peakAir = Math.max(this._peakAir, this.pos.y - groundY);

    if (this.pos.y <= groundY + 0.12) {
      this.pos.y = groundY + 0.12;
      // Touchdown is resolved here, not on the next frame's ground step: by
      // then `grounded` is already true and the landing would go unnoticed.
      this.terrain.normalAt(this.pos.x, this.pos.z, this.groundNormal);
      this.surface = this.terrain.surfaceAt(this.pos.x, this.pos.z);
      this.onLand();
      this.grounded = true;
    }
  }

  onLand() {
    const n = this.groundNormal;
    const impact = -Math.min(0, this.vel.dot(n));
    const height = this._peakAir;
    this.stats.biggestAir = Math.max(this.stats.biggestAir, height);

    if (this.airTime > 0.25) {
      this.emit('land', {
        impact: clamp(impact / 9, 0.25, 2.2),
        height,
        airTime: this.airTime,
        surface: this.surface,
      });
    }

    if (impact > TUNING.crashImpact && this.surface.deep < 0.4) {
      this.startCrash(clamp(impact / TUNING.crashImpact, 0.8, 2), 'landing');
      return;
    }

    // Absorb the landing: kill the into-slope component, scrub some speed.
    const into = this.vel.dot(n);
    if (into < 0) this.vel.addScaledVector(n, -into);
    const scrub = clamp(impact * 0.035, 0, 0.32);
    this.vel.multiplyScalar(1 - scrub);
    this.crouch = Math.min(1, this.crouch + impact * 0.06);
    this.airTime = 0;
  }

  // ── rails ──────────────────────────────────────────────────────
  updateRail(dt, input, world) {
    const rails = this.terrain.parkFeatures.rails;
    if (!rails.length) {
      this.grinding = damp(this.grinding, 0, 8, dt);
      return;
    }

    if (this.currentRail) {
      const r = this.currentRail;
      const t = this.railParam(r, this.pos);
      const off = this.railOffset(r, this.pos, t);
      if (t < -0.02 || t > 1.02 || off > r.width * 0.9 + 0.5 || input.jumpPressed) {
        if (input.jumpPressed) this.doJump(_v3.set(0, 1, 0));
        this.currentRail = null;
        this.emit('railOff');
      }
      return;
    }

    if (this.grinding > 0.01) this.grinding = damp(this.grinding, 0, 8, dt);
    if (this.vel.y > 1 || this.speed < 3) return;

    for (const r of rails) {
      const t = this.railParam(r, this.pos);
      if (t < -0.03 || t > 1) continue;
      const y = lerp(r.a.y, r.b.y, t);
      // Asymmetric window: generous from below (you're stepping up onto it,
      // which is the normal way to get on) and tight from above.
      const dy = this.pos.y - y;
      if (dy > 0.8 || dy < -1.5) continue;
      if (this.railOffset(r, this.pos, t) > r.width * 0.75 + 0.9) continue;

      // Only lock on if you're actually travelling along it.
      const dir = _v1.copy(r.b).sub(r.a).setY(0).normalize();
      const vd = _v2.copy(this.vel).setY(0).normalize();
      if (Math.abs(dir.dot(vd)) < 0.55) continue;

      this.currentRail = r;
      this.emit('railOn');
      break;
    }
  }

  railParam(r, p) {
    const ax = r.b.x - r.a.x, az = r.b.z - r.a.z;
    const len2 = ax * ax + az * az;
    if (len2 < 1e-5) return -1;
    return ((p.x - r.a.x) * ax + (p.z - r.a.z) * az) / len2;
  }

  railOffset(r, p, t) {
    const cx = lerp(r.a.x, r.b.x, t);
    const cz = lerp(r.a.z, r.b.z, t);
    return Math.hypot(p.x - cx, p.z - cz);
  }

  integrateRail(dt, input) {
    const r = this.currentRail;
    if (!r) return;
    const t = clamp(this.railParam(r, this.pos), 0, 1);
    const dir = _v1.copy(r.b).sub(r.a).normalize();
    const along = this.vel.dot(dir);

    // Rails are fast and near-frictionless. Gravity's component along the rail
    // accelerates you on a down-rail; a little steel friction bleeds it back.
    const v = along - dir.y * GRAVITY * dt - 0.55 * dt * Math.sign(along || 1);

    this.vel.copy(dir).multiplyScalar(v);
    this.pos.addScaledVector(this.vel, dt);

    const nt = clamp(this.railParam(r, this.pos), 0, 1);
    this.pos.x = lerp(r.a.x, r.b.x, nt);
    this.pos.z = lerp(r.a.z, r.b.z, nt);
    this.pos.y = lerp(r.a.y, r.b.y, nt) + 0.14;

    this.grounded = false;
    this.airTime = 0;
    this.edge = damp(this.edge, clamp(input.steer, -1, 1) * 0.3, 6, dt);
    this.slip = 0;
    this.edgeLoad = 0;
  }

  get onRail() { return !!this.currentRail; }

  // ── obstacle collisions ────────────────────────────────────────
  resolveCollisions(dt, world) {
    const hits = world.collisions.query(this.pos.x, this.pos.z, 2.5);
    const bodyR = 0.55;

    for (const c of hits) {
      // Buildings are boxes, not posts. A circle around a 46 m lodge either
      // blocks half the plaza or lets you ski in through the corner.
      if (c.kind === 'solid') { this.resolveSolid(c, bodyR); continue; }

      const dx = this.pos.x - c.x;
      const dz = this.pos.z - c.z;
      const minD = c.r + bodyR;
      const d2 = dx * dx + dz * dz;
      if (d2 > minD * minD) continue;

      // Obstacles have a top. Collision used to be purely a circle in X/Z,
      // which meant clearing a rock by ten metres still counted as hitting
      // it — you'd get knocked down in mid-air by something underneath you.
      if (c.h !== undefined && this.pos.y - SKI_CLEARANCE > c.y + c.h) continue;

      const d = Math.sqrt(d2) || 0.001;
      const nx = dx / d, nz = dz / d;
      const push = minD - d;
      this.pos.x += nx * push;
      this.pos.z += nz * push;

      const closing = -(this.vel.x * nx + this.vel.z * nz);
      if (closing <= 0) continue;

      if (c.soft) {
        // Bamboo just snaps out of the way.
        this.vel.x += nx * closing * 0.25;
        this.vel.z += nz * closing * 0.25;
        this.emit('poleHit');
        continue;
      }

      if (closing > TUNING.crashSpeed) {
        this.emit(c.kind === 'tree' ? 'treeHit' : 'rockHit', { force: clamp(closing / 18, 0.4, 1.5) });
        this.startCrash(clamp(closing / 16, 0.7, 2), c.kind);
        return;
      }

      // Glancing blow: slide around the trunk rather than bouncing off it.
      // Removing the inward component (instead of reflecting it) is what stops
      // you wedging against a tree that happens to sit straight down the hill.
      this.vel.x += nx * closing;
      this.vel.z += nz * closing;
      const graze = clamp(1 - closing / TUNING.crashSpeed, 0, 1);
      this.vel.multiplyScalar(0.86 + graze * 0.1);
      this.emit(c.kind === 'tree' ? 'treeHit' : 'rockHit', { force: clamp(closing / 24, 0.2, 0.8) });
    }
  }

  /**
   * Push out of an oriented box — buildings. You slide along the wall rather
   * than crashing into it, because skiing gently into a lodge at the bottom of
   * a run shouldn't end your day, but going *through* it certainly shouldn't
   * be possible either.
   */
  resolveSolid(c, bodyR) {
    const cos = Math.cos(-c.ry), sin = Math.sin(-c.ry);
    const rx = this.pos.x - c.x, rz = this.pos.z - c.z;
    const lx = rx * cos - rz * sin;
    const lz = rx * sin + rz * cos;

    const ex = c.hx + bodyR, ez = c.hz + bodyR;
    const ox = ex - Math.abs(lx);
    const oz = ez - Math.abs(lz);
    if (ox <= 0 || oz <= 0) return;

    // Eject along whichever face we're least deep through.
    let nx = 0, nz = 0;
    if (ox < oz) {
      nx = Math.sign(lx) || 1;
      this.pos.x += (nx * ox) * cos + 0 * sin;
      this.pos.z += -(nx * ox) * sin + 0 * cos;
    } else {
      nz = Math.sign(lz) || 1;
      this.pos.x += 0 * cos + (nz * oz) * sin;
      this.pos.z += 0 * -sin + (nz * oz) * cos;
    }

    // World-space wall normal, then remove any velocity heading into it.
    const wnx = nx * cos + nz * sin;
    const wnz = -nx * sin + nz * cos;
    const into = this.vel.x * wnx + this.vel.z * wnz;
    if (into < 0) {
      this.vel.x -= wnx * into;
      this.vel.z -= wnz * into;
      this.vel.multiplyScalar(0.94);
      if (-into > 9) this.emit('rockHit', { force: clamp(-into / 22, 0.2, 0.7) });
    }
  }

  /**
   * Exposure: on a ridge there are no boundary walls, there is only air.
   *
   * Most maps keep you in by rising at the edges. A corniced knife edge with
   * three kilometres of drop either side can't do that and still be the thing
   * it is — so instead, straying past `features.exposure` metres from the
   * ridge line means you've gone over, and you get put back on it.
   */
  checkExposure() {
    const limit = this.spec.features?.exposure;
    if (!limit || this.crashed || this.riding) return;

    const samples = this.terrain.trails[0]?.samples;
    if (!samples || samples.length < 2) return;

    // Scan the whole line for the nearest point.
    //
    // This used to guess a starting index from z and search a window around
    // it, which assumes samples are spread evenly along z. They aren't —
    // they're spaced along *arc length*, so on a trail that meanders the
    // guess drifts badly, the window misses the true nearest sample, and the
    // distance comes out enormous. The result was being thrown off a ridge
    // you were standing in the middle of. A few hundred distance checks a
    // frame costs nothing next to being wrong.
    const n = samples.length - 1;
    let best = Infinity, bestI = 0;
    for (let i = 0; i <= n; i++) {
      const dx = samples[i].x - this.pos.x;
      const dz = samples[i].z - this.pos.z;
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; bestI = i; }
    }

    const dist = Math.sqrt(best);
    this.exposure = clamp(dist / limit, 0, 1);
    if (dist <= limit) return;

    // Over the edge. Put them back on the ridge, a little above where they
    // left it, and let the normal crash recovery stand them up.
    const back = samples[Math.max(0, bestI - 3)];
    this.pos.set(back.x, this.terrain.heightAt(back.x, back.z) + 0.3, back.z);
    this.vel.set(0, 0, 0);
    this.exposure = 0;
    this.startCrash(1.6, 'exposure');
  }

  enforceBounds() {
    const t = this.terrain;
    const lim = t.halfW - 6;
    if (this.pos.x > lim) { this.pos.x = lim; this.vel.x = Math.min(this.vel.x, 0) * 0.4; }
    if (this.pos.x < -lim) { this.pos.x = -lim; this.vel.x = Math.max(this.vel.x, 0) * 0.4; }
    if (this.pos.z < 4) { this.pos.z = 4; this.vel.z = Math.max(this.vel.z, 0); }
    if (this.pos.z > t.length - 6) {
      this.pos.z = t.length - 6;
      this.vel.z = Math.min(this.vel.z, 0) * 0.3;
      if (!this.reachedBase) {
        this.reachedBase = true;
        this.emit('reachedBase');
      }
    }
  }

  // ── riding the lifts ───────────────────────────────────────────
  /** The lift whose loading area you're standing in, if any. */
  findLift(world) {
    const lifts = world?.lifts;
    if (!lifts || !lifts.length || this.crashed) return null;
    if (this.speed > 9) return null;      // you have to slow down to load

    let best = null, bestD = LIFT_LOAD_RADIUS;
    for (const lift of lifts) {
      const p = lift.pts[0];
      const d = Math.hypot(this.pos.x - p.x, this.pos.z - p.z);
      if (d < bestD) { bestD = d; best = lift; }
    }
    return best;
  }

  /**
   * Get on. `skipRide` teleports straight to the unload station instead of
   * sitting through the ride — the lift is transport, and some players would
   * rather not spend two minutes of it.
   */
  board(lift, world) {
    if (this.riding) return;
    if (world?.skipLifts) {
      this.unload(lift);
      this.emit('liftSkip', { lift });
      return;
    }
    this.riding = { lift, d: 0 };
    this.vel.set(0, 0, 0);
    this.crashed = false;
    this.currentRail = null;
    this.grinding = 0;
    this.emit('liftOn', { lift });
  }

  updateRide(dt, input, world) {
    const r = this.riding;
    r.d += (r.lift.speed ?? 4.6) * dt;

    const total = r.lift.total;
    if (r.d >= total) {
      this.unload(r.lift);
      return;
    }

    // Bail out mid-ride: you drop off the chair onto whatever's below, which
    // is a normal landing from a few metres and entirely your own problem.
    if (input?.boardPressed && r.d > 6) {
      this.riding = null;
      this.grounded = false;
      this.airTime = 0;
      this._peakAir = 0;
      this.vel.set(Math.sin(this.heading) * 1.5, -0.5, Math.cos(this.heading) * 1.5);
      this.emit('liftOff', { lift: r.lift, early: true });
      return;
    }

    // Sit on the chair: the cable sample is the hanger, the seat hangs below.
    const p = r.lift.sample(r.d);
    this.pos.set(p.x + LIFT_SEAT_SIDE, p.y - LIFT_SEAT_DROP, p.z);
    this.grounded = false;
    this.airTime = 0;
    this.edge = 0;
    this.edgeLoad = 0;
    this.slip = 0;
    this.skating = 0;
    this.rough = 0;
    this.crouch = 0;
    // Face up the line, the way you actually sit.
    const ahead = r.lift.sample(Math.min(total, r.d + 12));
    this.heading = Math.atan2(ahead.x - p.x, ahead.z - p.z);
    this.riding.progress = r.d / total;
  }

  unload(lift) {
    const top = lift.pts[lift.pts.length - 1];
    // Step off just past the top station, onto the snow.
    const prev = lift.pts[lift.pts.length - 2] || top;
    const dx = top.x - prev.x, dz = top.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    const x = top.x + (dx / len) * 14;
    const z = top.z + (dz / len) * 14;

    this.riding = null;
    this.pos.set(x, this.terrain.heightAt(x, z) + 0.12, z);
    this.heading = this.terrain.fallLineHeading(x, z);
    this.vel.set(Math.sin(this.heading) * 2.5, 0, Math.cos(this.heading) * 2.5);
    this.grounded = true;
    this._startY = this.pos.y;
    this.emit('liftOff', { lift });
  }

  /** Bail out mid-ride (used when resetting or changing map). */
  cancelRide() {
    if (!this.riding) return;
    this.unload(this.riding.lift);
  }

  // ── crashing ───────────────────────────────────────────────────
  startCrash(intensity, cause) {
    if (this.crashed) return;
    this.crashed = true;
    this.crashTimer = 0;
    this.crashSpin = (Math.random() < 0.5 ? -1 : 1) * (2 + Math.random() * 4) * intensity;
    this.crashPitch = (Math.random() - 0.5) * 2;
    this.currentRail = null;
    this.grinding = 0;
    this.emit('crash', { intensity, cause });
  }

  updateCrashed(dt, input) {
    this.crashTimer += dt;

    // Slide out, tumbling, until you stop.
    const groundY = this.terrain.heightAt(this.pos.x, this.pos.z);
    this.terrain.normalAt(this.pos.x, this.pos.z, this.groundNormal);
    this.surface = this.terrain.surfaceAt(this.pos.x, this.pos.z);

    this.vel.y -= GRAVITY * dt;
    this.pos.addScaledVector(this.vel, dt);
    if (this.pos.y < groundY + 0.35) {
      this.pos.y = groundY + 0.35;
      this.vel.y = 0;
      const decay = Math.exp(-3.2 * dt);
      this.vel.x *= decay;
      this.vel.z *= decay;
    }

    this.heading = wrapAngle(this.heading + this.crashSpin * dt);
    this.crashSpin *= Math.exp(-2.2 * dt);
    this.edge = 0;
    this.edgeLoad = 0;
    this.slip = 1;
    this.grinding = 0;

    const stopped = this.speed < 1.2;
    if ((this.crashTimer > 1.6 && stopped) || this.crashTimer > 4.5 || input.jumpPressed) {
      this.recover();
    }
  }

  recover() {
    this.crashed = false;
    this.crashTimer = 0;
    this.crashSpin = 0;
    this.vel.set(0, 0, 0);
    this.pos.y = this.terrain.heightAt(this.pos.x, this.pos.z) + 0.2;
    // Point back down the fall line so you aren't stuck facing uphill.
    this.heading = this.terrain.fallLineHeading(this.pos.x, this.pos.z);
    this.emit('recovered');
  }

  /** Snapshot for the audio mixer. */
  audioState() {
    return {
      speed: this.speed,
      airSpeed: this.airSpeed,
      edge: this.edgeLoad,
      slip: this.slip,
      grounded: this.grounded && !this.crashed && !this.onRail,
      deep: this.surface.deep,
      ice: this.surface.ice,
      groom: this.surface.groom,
      rock: this.surface.rock,
      rough: this.rough,
      grinding: this.onRail ? 1 : 0,
    };
  }
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();

export { TUNING };
