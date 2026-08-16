// First-person camera and view model.
//
// The view model (skis, poles, gloves) lives in its own scene rendered with a
// cleared depth buffer on top of the world. That's the standard fix for
// first-person geometry punching through walls — here it stops your ski tips
// from being swallowed by a mogul.

import * as THREE from 'three';
import { clamp, damp, wrapAngle } from '../core/math.js';

const BASE_FOV = 76;

// A three.js camera looks down its local -Z. This game's heading convention is
// the opposite: `headingVec(h)` is (sin h, 0, cos h), so heading 0 faces +Z,
// which is the direction the fall line runs on every map. Without this offset
// the camera faces exactly backwards — you ski down the hill looking at the
// slope you already skied.
const CAMERA_YAW_OFFSET = Math.PI;

export class PlayerView {
  constructor(renderer) {
    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.15, 7000);

    // Separate pass for the view model.
    this.viewScene = new THREE.Scene();
    this.viewCamera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.05, 20);
    this.buildViewModel();

    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.fov = BASE_FOV;
    this.shake = 0;
    this.shakeSeed = Math.random() * 100;
    this.bobPhase = 0;
    this.crashRoll = 0;
    this.crashPitch = 0;
    this.showViewModel = true;
    this.tmp = new THREE.Vector3();
  }

  buildViewModel() {
    const g = new THREE.Group();
    this.viewScene.add(g);
    this.rig = g;

    const light = new THREE.HemisphereLight(0xdcecff, 0x60646c, 2.1);
    this.viewScene.add(light);
    const key = new THREE.DirectionalLight(0xfff4e2, 1.4);
    key.position.set(0.6, 1, 0.4);
    this.viewScene.add(key);
    this.viewLights = { hemi: light, key };

    const topMat = new THREE.MeshPhongMaterial({ color: 0x1f6fb2, shininess: 70, specular: 0x8899aa });
    const edgeMat = new THREE.MeshPhongMaterial({ color: 0xc8ced6, shininess: 110, specular: 0xffffff });
    const bootMat = new THREE.MeshPhongMaterial({ color: 0x22262c, shininess: 40 });
    const poleMat = new THREE.MeshPhongMaterial({ color: 0x8f959d, shininess: 90 });
    const gloveMat = new THREE.MeshLambertMaterial({ color: 0x2b3038 });
    const cuffMat = new THREE.MeshLambertMaterial({ color: 0xd94f2b });
    this.viewMats = [topMat, edgeMat, bootMat, poleMat, gloveMat, cuffMat];

    // Note the cheat: real skis sit 1.6 m below the eye and would fall
    // entirely outside a 76° vertical field of view. So they're drawn closer
    // and higher than they physically are, which is what puts the tips in the
    // bottom third of the frame where you can actually read your edge angle.
    this.skis = [];
    for (const side of [-1, 1]) {
      const ski = new THREE.Group();

      const body = new THREE.Mesh(new THREE.BoxGeometry(0.135, 0.026, 1.7), topMat);
      body.position.z = -0.15;
      ski.add(body);

      const edgeStrip = new THREE.Mesh(new THREE.BoxGeometry(0.148, 0.01, 1.7), edgeMat);
      edgeStrip.position.set(0, -0.017, -0.15);
      ski.add(edgeStrip);

      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.004, 1.2), cuffMat);
      stripe.position.set(0, 0.015, -0.28);
      ski.add(stripe);

      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.024, 0.34), topMat);
      tip.position.set(0, 0.05, -1.13);
      tip.rotation.x = 0.5;
      ski.add(tip);

      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.024, 0.2), topMat);
      tail.position.set(0, 0.028, 0.76);
      tail.rotation.x = -0.26;
      ski.add(tail);

      const binding = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.05, 0.3), bootMat);
      binding.position.set(0, 0.038, 0.44);
      ski.add(binding);

      const boot = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.2, 0.34), bootMat);
      boot.position.set(0, 0.14, 0.46);
      ski.add(boot);

      const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.03, 0.09), cuffMat);
      buckle.position.set(0, 0.18, 0.44);
      ski.add(buckle);

      ski.position.set(side * 0.30, -0.98, -1.62);
      ski.rotation.x = 0.05;
      ski.rotation.y = -side * 0.022;   // a touch of toe-in, like a real stance
      g.add(ski);
      this.skis.push({ group: ski, side });
    }

    // Poles hang from the grips and sweep sharply back past the camera, so
    // only the hands and a short length of shaft stay in frame — which is all
    // you'd see of your own poles while actually skiing.
    this.poles = [];
    for (const side of [-1, 1]) {
      const pole = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.009, 1.25, 6), poleMat);
      shaft.position.y = -0.62;
      pole.add(shaft);

      const basket = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.012, 8), gloveMat);
      basket.position.y = -1.14;
      pole.add(basket);

      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.017, 0.13, 6), gloveMat);
      grip.position.y = 0.01;
      pole.add(grip);

      const glove = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.085, 0.12), gloveMat);
      glove.position.set(0, 0.015, 0.015);
      pole.add(glove);

      const cuff = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.028, 0.09), cuffMat);
      cuff.position.set(0, 0.052, 0.05);
      pole.add(cuff);

      pole.position.set(side * 0.34, -0.5, -0.62);
      pole.rotation.x = -0.85;
      pole.rotation.z = side * 0.2;
      g.add(pole);
      this.poles.push({ group: pole, side });
    }
  }

  setAspect(aspect) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = aspect;
    this.viewCamera.updateProjectionMatrix();
  }

  /** Match the view model's lighting to the map so the skis don't look pasted on. */
  applyWeather(preset) {
    this.viewLights.hemi.color.set(preset.ambient);
    this.viewLights.hemi.groundColor.set(preset.ground);
    this.viewLights.hemi.intensity = 1.1 + preset.hemiIntensity * 0.7;
    this.viewLights.key.color.set(preset.sunColor);
    this.viewLights.key.intensity = 0.5 + preset.sunIntensity * 0.5;
  }

  update(dt, skier, input, time) {
    const speed = skier.speed;

    // ── orientation ──────────────────────────────────────────────
    this.yaw = input.viewYaw + input.lookOffsetX;
    this.pitch = clamp(input.viewPitch, -0.95, 0.75);

    // Roll into the turn, plus a bit of extra when the edge is loaded.
    const targetRoll = -skier.lean * 0.13 - skier.edgeLoad * Math.sign(skier.edge) * 0.055;
    this.roll = damp(this.roll, targetRoll, 8, dt);

    if (skier.crashed) {
      this.crashRoll += skier.crashSpin * dt * 0.55;
      this.crashPitch = damp(this.crashPitch, skier.crashPitch ?? 0.6, 3, dt);
    } else {
      this.crashRoll = damp(this.crashRoll, 0, 5, dt);
      this.crashPitch = damp(this.crashPitch, 0, 5, dt);
    }

    // ── position ─────────────────────────────────────────────────
    const eye = 1.62 - skier.crouch * 0.42 - (skier.crashed ? 1.1 : 0);
    this.bobPhase = skier.bob;

    const bobAmp = clamp(speed / 22, 0, 1) * (0.5 + skier.rough * 1.4) * (1 - skier.crouch * 0.45);
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * bobAmp;
    const bobX = Math.sin(this.bobPhase) * 0.028 * bobAmp;

    // Terrain chatter — high frequency, scaled by roughness and speed.
    const targetShake = skier.grounded
      ? clamp(skier.rough * speed / 26, 0, 1) * 0.7 + (skier.surface.ice * skier.edgeLoad * 0.3)
      : 0;
    this.shake = damp(this.shake, targetShake, 10, dt);
    const t = time * 34 + this.shakeSeed;
    const shakeX = (Math.sin(t * 1.37) + Math.sin(t * 2.71) * 0.5) * 0.012 * this.shake;
    const shakeY = (Math.sin(t * 1.83) + Math.sin(t * 3.11) * 0.5) * 0.012 * this.shake;

    this.camera.position.set(
      skier.pos.x + bobX,
      skier.pos.y + eye + bobY,
      skier.pos.z,
    );

    // `this.yaw` stays in the game's heading convention — the view model and
    // the audio panner both read it — so the -Z correction is applied only
    // where the three.js camera is actually oriented.
    this.camera.rotation.set(0, 0, 0);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + CAMERA_YAW_OFFSET;
    this.camera.rotation.x = this.pitch + this.crashPitch + shakeY;
    this.camera.rotation.z = this.roll + this.crashRoll + shakeX;

    // ── field of view ────────────────────────────────────────────
    const tuckKick = input.tuck ? 4 : 0;
    const targetFov = BASE_FOV + clamp(speed / 34, 0, 1) * 15 + tuckKick + (skier.crashed ? -6 : 0);
    this.fov = damp(this.fov, targetFov, 4, dt);
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
      this.viewCamera.fov = this.fov;
      this.viewCamera.updateProjectionMatrix();
    }

    this.updateViewModel(dt, skier, input, time);
  }

  updateViewModel(dt, skier, input, time) {
    this.rig.visible = this.showViewModel && !skier.crashed;
    if (!this.rig.visible) return;

    // The skis are drawn in view space, so they need to counter-rotate against
    // the head: you look into the turn, the skis stay pointed where they point.
    const headOffset = wrapAngle(this.yaw - skier.heading);
    const bank = skier.lean;
    const crouch = skier.crouch;
    const airborne = !skier.grounded && !skier.onRail;

    const yBase = -0.98 + crouch * 0.2 + (airborne ? 0.08 : 0);
    const zBase = -1.62 + crouch * 0.14;
    const bobY = Math.sin(skier.bob * 2) * 0.022 * clamp(skier.speed / 20, 0, 1);

    for (const { group, side } of this.skis) {
      // Wider stance when skidding, narrow and tipped when carving.
      const stance = 0.30 + skier.slip * 0.07 - Math.abs(bank) * 0.035;
      const tipIn = bank * 0.11;

      group.position.x = damp(group.position.x, side * stance + tipIn, 12, dt);
      group.position.y = damp(group.position.y, yBase + bobY + (side === Math.sign(bank || 1) ? -0.015 : 0.015) * Math.abs(bank), 12, dt);
      group.position.z = damp(group.position.z, zBase, 10, dt);

      group.rotation.order = 'YXZ';
      group.rotation.y = damp(group.rotation.y, -headOffset - side * 0.022 + side * skier.slip * 0.06, 10, dt);
      // Edge angle — this is the readable bit: the skis visibly tip on edge.
      group.rotation.z = damp(group.rotation.z, bank * 0.55, 11, dt);
      group.rotation.x = damp(
        group.rotation.x,
        0.05 + (airborne ? -0.14 : clamp(-this.pitch * 0.3, -0.22, 0.22) + skier.rough * 0.045 * Math.sin(time * 22)),
        9, dt,
      );
    }

    // Poles swing back at speed, plant when you push.
    const plant = skier.speed < 5 ? Math.sin(time * 9) * 0.25 : 0;
    for (const { group, side } of this.poles) {
      const tuck = input.tuck ? 1 : 0;
      group.position.x = damp(group.position.x, side * (0.34 - tuck * 0.08), 8, dt);
      group.position.y = damp(group.position.y, -0.5 + crouch * 0.16 - tuck * 0.02, 8, dt);
      group.position.z = damp(group.position.z, -0.62 - tuck * 0.16, 8, dt);
      group.rotation.x = damp(group.rotation.x, -0.85 - tuck * 0.3 + plant * side, 8, dt);
      group.rotation.z = damp(group.rotation.z, side * (0.2 + bank * 0.1), 8, dt);
    }
  }

  /** Unit vector out of the listener's right ear, for audio panning. */
  rightVector(out = new THREE.Vector3()) {
    return out.set(1, 0, 0).applyQuaternion(this.camera.quaternion).setY(0).normalize();
  }

  render(renderer, scene) {
    renderer.render(scene, this.camera);
    // renderer.info resets per render() call, so the world's numbers have to
    // be captured before the view-model pass overwrites them.
    this.worldStats = {
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
    };
    if (this.rig.visible) {
      renderer.autoClear = false;
      renderer.clearDepth();
      this.viewCamera.quaternion.identity();
      this.viewCamera.position.set(0, 0, 0);
      renderer.render(this.viewScene, this.viewCamera);
      renderer.autoClear = true;
    }
  }

  dispose() {
    this.viewScene.traverse((o) => {
      if (o.isMesh) o.geometry.dispose();
    });
    for (const m of this.viewMats) m.dispose();
  }
}
