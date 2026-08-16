// Facade between the game and the audio engine. The rest of the codebase
// talks to this, never to the raw AudioContext.

import * as THREE from 'three';
import { AudioEngine } from './engine.js';
import { SkiLayers, Ambience } from './layers.js';
import { Sfx, LiftEmitter, LodgeEmitter, PassbyPool } from './sfx.js';
import { Music, moodForMap } from './music.js';

export class GameAudio {
  constructor() {
    this.engine = new AudioEngine();
    this.layers = null;
    this.ambience = null;
    this.sfx = null;
    this.music = null;
    this.emitters = [];
    this.passby = null;
    this._right = new THREE.Vector3();
    this._nearest = [];
    this.initialised = false;
  }

  async init() {
    await this.engine.init();
    if (this.initialised) return this;
    this.layers = new SkiLayers(this.engine);
    this.sfx = new Sfx(this.engine);
    this.music = new Music(this.engine);
    this.initialised = true;
    return this;
  }

  get ready() { return this.engine.ready; }

  // ── map lifecycle ─────────────────────────────────────────────
  attachMap({ spec, preset, props, terrain }) {
    if (!this.ready) return;
    this.detachMap();

    this.layers.start();
    this.ambience = new Ambience(this.engine);
    this.ambience.start(preset, spec);

    // Chairlift emitters, parked at the busy end of each lift line.
    for (const lift of props.lifts || []) {
      const p = lift.pts[Math.floor(lift.pts.length * 0.15)];
      const em = new LiftEmitter(this.engine);
      em.setPosition(p.x, p.y - 4, p.z);
      this.emitters.push(em);

      const base = lift.pts[0];
      const em2 = new LiftEmitter(this.engine);
      em2.setPosition(base.x, base.y - 6, base.z);
      this.emitters.push(em2);
    }

    if (props.lodgePos) {
      const em = new LodgeEmitter(this.engine);
      em.setPosition(props.lodgePos.x, terrain.heightAt(props.lodgePos.x, props.lodgePos.z) + 3, props.lodgePos.z);
      this.emitters.push(em);
    }

    this.passby = new PassbyPool(this.engine, 6);
    this.music.start(moodForMap(spec));
  }

  detachMap() {
    if (this.ambience) { this.ambience.dispose(); this.ambience = null; }
    for (const em of this.emitters) em.dispose();
    this.emitters = [];
    this.passby?.dispose();
    this.passby = null;
    this.layers?.silence();
  }

  menuMusic() {
    if (!this.ready) return;
    this.layers?.silence();
    this.music?.start('menu');
  }

  // ── per-frame ─────────────────────────────────────────────────
  update(dt, { skier, view, bots, paused }) {
    if (!this.ready) return;

    if (paused) {
      this.layers?.silence();
      this.music?.update(dt, 0.1);
      return;
    }

    // On the chair there's no contact with the snow at all — just the wind
    // and the machinery, which the positional lift emitters already give us.
    if (skier.riding) this.layers.silence();
    else this.layers.update(skier.audioState(), dt);
    this.ambience?.update(dt);

    const listener = view.camera.position;
    const right = view.rightVector(this._right);

    for (const em of this.emitters) {
      em.update(listener, right);
      em.tick(dt);
    }

    // Hand the closest few bots to the pass-by voices.
    if (this.passby && bots) {
      const near = bots.nearest(listener, this.passby.size, this._nearest);
      for (let i = 0; i < this.passby.size; i++) {
        if (i < near.length) {
          const b = near[i].bot;
          const src = this.passby.drive(i, b.x, b.y + 1, b.z, b.speed, Math.abs(b.lean));
          src.update(listener, right);
        } else {
          this.passby.quiet(i);
        }
      }
    }

    // The score follows how hard you're skiing.
    const intensity = Math.min(1, skier.speed / 28) * (skier.crashed ? 0.2 : 1);
    this.music.update(dt, intensity);
  }

  /** Drain and play the skier's event queue. */
  handleEvents(events) {
    if (!this.ready) return;
    for (const ev of events) {
      switch (ev.type) {
        case 'jump': this.sfx.jump(ev.power); break;
        case 'land': this.sfx.land(ev.impact, ev.surface); break;
        case 'crash': this.sfx.crash(ev.intensity); break;
        case 'treeHit': this.sfx.treeHit(ev.force); break;
        case 'rockHit': this.sfx.rockHit(ev.force); break;
        case 'poleHit': this.sfx.poleHit(); break;
        case 'polePush': this.sfx.polePush(); break;
        case 'railOn': this.sfx.railClank(true); break;
        case 'railOff': this.sfx.railClank(false); break;
        case 'liftOn': this.sfx.railClank(true); break;
        case 'liftOff': this.sfx.railClank(false); break;
        case 'liftSkip': this.sfx.ui('confirm'); break;
        case 'swish': this.sfx.swish(ev.intensity ?? 1); break;
        default: break;
      }
    }
  }

  ui(kind) { if (this.ready) this.sfx.ui(kind); }

  setVolume(key, v) { this.engine.setVolume(key, v); }
  toggleMute() { return this.engine.toggleMute(); }
  setMusicEnabled(on) { this.music?.setEnabled(on); }
  suspend() { this.engine.suspend(); }
  resume() { this.engine.resume(); }
}
