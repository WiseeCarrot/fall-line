// Game orchestration: owns the renderer, the current mountain, and the loop.

import * as THREE from 'three';
import { Terrain } from './world/terrain.js';
import { Props } from './world/props.js';
import {
  Sky, WEATHER, buildLighting, buildDistantPeaks, Precipitation,
  presetAt, applyPreset,
} from './world/sky.js';
import { makeSnowMaterial, updateSnowMaterial } from './world/materials.js';
import { Skier } from './player/skier.js';
import { PlayerView } from './player/camera.js';
import { BotCrowd } from './ai/bots.js';
import { Input } from './core/input.js';
import { SpatialHash } from './core/spatial.js';
import { GameAudio } from './audio/gameaudio.js';
import { HUD } from './ui/hud.js';
import { Menu } from './ui/menu.js';
import { clamp } from './core/math.js';

const QUALITY = {
  low:    { terrain: 120000, props: 0.4, bots: 0.5, pixelRatio: 1.0, shadowSize: 1024, precip: 0.5, peaks: false },
  medium: { terrain: 300000, props: 0.75, bots: 0.85, pixelRatio: 1.35, shadowSize: 2048, precip: 1.0, peaks: true },
  high:   { terrain: 420000, props: 1.15, bots: 1.15, pixelRatio: 2.0, shadowSize: 2048, precip: 1.4, peaks: true },
};

const DEFAULT_SETTINGS = {
  master: 0.85, sfx: 1, music: 0.5, ambient: 0.9,
  musicOn: true, sensitivity: 1, invertY: false,
  viewModel: true, hud: true, quality: 'medium',
  shadows: true, precip: true, skipLifts: false,
};

export class Game {
  constructor(canvas, dom) {
    this.canvas = canvas;
    this.dom = dom;
    this.settings = this.loadSettings();

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.view = new PlayerView(this.renderer);
    this.audio = new GameAudio();
    this.input = new Input(canvas);
    this.clock = new THREE.Clock();

    this.map = null;          // current loaded mountain
    this.loading = false;
    this.paused = true;
    this.started = false;
    this.time = 0;
    this.frame = 0;

    this.hud = new HUD(dom.hud);
    this.menu = new Menu(dom.menu, {
      settings: this.settings,
      audio: this.audio,
      onPlay: (spec) => this.loadMap(spec),
      onResume: () => this.resume(),
      onRestart: () => this.restart(),
      onSetting: (k, v) => this.applySetting(k, v),
      saveSettings: () => this.saveSettings(),
      inGame: () => !!this.map,
      currentSpec: () => this.map?.spec,
      currentStats: () => this.map?.skier.stats ?? null,
    });

    this.bindEvents();
    this.resize();
    this.hud.setVisible(false);
    this.menu.show('title');
  }

  // ── settings ────────────────────────────────────────────────────
  loadSettings() {
    try {
      const raw = localStorage.getItem('fallline.settings');
      return { ...DEFAULT_SETTINGS, ...(raw ? JSON.parse(raw) : {}) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings() {
    try {
      localStorage.setItem('fallline.settings', JSON.stringify(this.settings));
    } catch { /* private browsing, no persistence — not worth surfacing */ }
  }

  applySetting(key, value) {
    this.settings[key] = value;
    switch (key) {
      case 'sensitivity': this.input.sensitivity = 0.0022 * value; break;
      case 'invertY': this.input.invertY = value; break;
      case 'viewModel': this.view.showViewModel = value; break;
      case 'hud': this.hud.setVisible(value && !!this.map && !this.paused); break;
      case 'shadows':
        this.renderer.shadowMap.enabled = value;
        if (this.map?.lighting) this.map.lighting.sun.castShadow = value;
        this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
        break;
      case 'precip':
        if (this.map?.precip) this.map.precip.points.visible = value;
        break;
      case 'skipLifts':
        // Applies to the next boarding, so it can be changed mid-ride.
        if (this.map?.world) this.map.world.skipLifts = value;
        break;
      default: break;
    }
    this.saveSettings();
  }

  applyAllSettings() {
    const s = this.settings;
    this.input.sensitivity = 0.0022 * s.sensitivity;
    this.input.invertY = s.invertY;
    this.view.showViewModel = s.viewModel;
    this.renderer.shadowMap.enabled = s.shadows;
    if (this.audio.ready) {
      for (const k of ['master', 'sfx', 'music', 'ambient']) this.audio.setVolume(k, s[k]);
      this.audio.setMusicEnabled(s.musicOn);
    }
  }

  get quality() { return QUALITY[this.settings.quality] || QUALITY.medium; }

  // ── events ──────────────────────────────────────────────────────
  bindEvents() {
    window.addEventListener('resize', () => this.resize());

    this.input.onAction = (action) => {
      if (action === 'lockLost') {
        if (this.map && !this.paused && !this.loading) this.pause();
        return;
      }
      if (action === 'lockGained') return;
      if (!this.map || this.loading) return;

      switch (action) {
        case 'pause':
          this.paused ? this.resume() : this.pause();
          break;
        case 'reset':
          if (!this.paused) this.restart();
          break;
        case 'mute': {
          const muted = this.audio.toggleMute();
          this.hud.toast(muted ? 'Audio muted' : 'Audio on');
          break;
        }
        case 'music':
          this.settings.musicOn = !this.settings.musicOn;
          this.audio.setMusicEnabled(this.settings.musicOn);
          this.hud.toast(this.settings.musicOn ? 'Score on' : 'Score off');
          this.saveSettings();
          break;
        case 'hud':
          this.settings.hud = !this.settings.hud;
          this.hud.setVisible(this.settings.hud);
          this.saveSettings();
          break;
        case 'viewmodel':
          this.settings.viewModel = !this.settings.viewModel;
          this.view.showViewModel = this.settings.viewModel;
          this.saveSettings();
          break;
        default: break;
      }
    };

    this.canvas.addEventListener('click', () => {
      if (this.map && !this.paused && !this.loading) this.input.requestLock();
    });

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.map && !this.paused) this.pause();
    });
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.quality.pixelRatio));
    this.renderer.setSize(w, h, false);
    this.view.setAspect(w / h);
    // Point sprites are sized in metres, so they need the drawing buffer height.
    this.map?.precip?.setViewportHeight(this.renderer.domElement.height);
  }

  // ── map lifecycle ───────────────────────────────────────────────
  async loadMap(spec) {
    if (this.loading) return;
    this.loading = true;
    this.paused = true;
    this.hud.setVisible(false);
    this.input.enabled = false;
    this.input.releaseLock();

    await this.audio.init();
    this.applyAllSettings();
    this.audio.menuMusic();

    this.menu.show('loading', spec);
    await frame();

    this.teardown();

    const q = this.quality;
    const preset = WEATHER[spec.weather] || WEATHER.bluebird;

    // ── terrain
    // A map may ask for more resolution than the detail setting would give —
    // a 6.6 km run needs it, or the cells come out too coarse to hold a ridge.
    const terrain = new Terrain(spec, q.terrain * (spec.vertexBudget || 1));
    await terrain.build((f, label) => this.menu.setProgress(f * 0.5, label));

    const snowMat = makeSnowMaterial(preset);
    const ground = new THREE.Mesh(terrain.geometry, snowMat);
    ground.receiveShadow = true;
    ground.castShadow = false;
    this.scene.add(ground);

    // ── sky, light, backdrop
    const sky = new Sky(preset);
    this.scene.add(sky.mesh);
    const lighting = buildLighting(this.scene, preset, sky.sunDir, Math.max(spec.width, spec.length));
    lighting.sun.castShadow = this.settings.shadows;
    lighting.sun.shadow.mapSize.set(q.shadowSize, q.shadowSize);
    this.renderer.shadowMap.enabled = this.settings.shadows;
    this.renderer.toneMappingExposure = preset.exposure ?? 1;

    let peaks = null;
    if (q.peaks) {
      peaks = buildDistantPeaks(
        spec.seed, preset,
        Math.max(spec.width, spec.length) * 0.9,
        spec.drop * 0.25,
        spec.horizon,
      );
      peaks.position.z = spec.length * 0.5;
      this.scene.add(peaks);
    }

    this.menu.setProgress(0.55, 'Dressing the mountain');
    await frame();

    // ── props
    const props = new Props(terrain, spec, q.props);
    await props.build((f, label) => this.menu.setProgress(0.55 + f * 0.33, label));
    this.scene.add(props.group);

    // ── collision index
    const collisions = new SpatialHash(14).insertAll(props.collidables);

    // ── bots
    this.menu.setProgress(0.9, 'Opening the lifts');
    await frame();
    const bots = new BotCrowd(terrain, spec, collisions, q.bots).build();
    this.scene.add(bots.group);

    // ── precipitation
    let precip = null;
    if (preset.precip) {
      precip = new Precipitation(preset.precip, q.precip);
      precip.points.visible = this.settings.precip;
      precip.setViewportHeight(this.renderer.domElement.height);
      this.scene.add(precip.points);
    }

    // ── player
    const skier = new Skier(terrain, spec);
    // At a resort, start out on the plaza a short skate from a lift. The
    // terrain can't do this itself — it doesn't know where the lifts went.
    if (terrain.baseArea) {
      const baseLift = props.lifts.find((l) => l.pts[0].z > terrain.baseArea.z0 - 40);
      if (baseLift) {
        const p = baseLift.pts[0];
        terrain.spawnOverride = {
          x: clamp(p.x - 26, -terrain.halfW + 40, terrain.halfW - 40),
          z: clamp(p.z - 58, terrain.baseArea.z0 + 15, terrain.baseArea.z1 - 15),
        };
        skier.reset();
        this.input.alignTo(Math.atan2(p.x - skier.pos.x, p.z - skier.pos.z));
      }
    }
    this.view.applyWeather(preset);
    this.input.alignTo(skier.heading);

    this.map = {
      spec, preset, terrain, ground, snowMat, sky, lighting, peaks,
      props, bots, collisions, precip, skier,
      world: {
        collisions, terrain, props,
        lifts: props.lifts,
        skipLifts: this.settings.skipLifts,
      },
      windVec: new THREE.Vector3(preset.wind * 3.5, 0, preset.wind * 1.4),
    };

    this.hud.setMap(spec, preset);
    this.menu.setProgress(1, 'Ready');
    await frame();
    await frame();

    this.loading = false;
    this.resume();
    this.hud.toast(spec.name, spec.blurb);
    this.hud.fadeHint();
  }

  teardown() {
    if (!this.map) return;
    const m = this.map;
    this.audio.detachMap();

    this.scene.remove(m.ground, m.sky.mesh, m.props.group, m.bots.group, m.lighting.group);
    if (m.peaks) {
      this.scene.remove(m.peaks);
      m.peaks.geometry.dispose();
      m.peaks.material.dispose();
    }
    if (m.precip) {
      this.scene.remove(m.precip.points);
      m.precip.dispose();
    }
    // The sun's shadow map is a render target allocated lazily by the
    // renderer; dropping the light doesn't free it, and it's a megabyte-scale
    // texture per map load.
    m.lighting.sun.shadow.dispose();
    m.lighting.group.traverse((o) => o.dispose?.());

    m.terrain.dispose();
    m.snowMat.dispose();
    m.sky.dispose();
    m.props.dispose();
    m.bots.dispose();
    this.scene.fog = null;
    this.map = null;
  }

  // ── run control ─────────────────────────────────────────────────
  restart() {
    if (!this.map) return;
    this.map.skier.reset();
    this.input.alignTo(this.map.skier.heading);
    this.resume();
    this.hud.toast('Back at the top');
  }

  pause() {
    if (!this.map || this.loading) return;
    this.paused = true;
    this.input.enabled = false;
    this.input.releaseLock();
    this.hud.setVisible(false);
    this.menu.show('pause');
  }

  resume() {
    if (!this.map) return;
    this.paused = false;
    this.input.enabled = true;
    this.menu.hide();
    this.hud.setVisible(this.settings.hud);
    if (!this.map.audioAttached) {
      this.audio.attachMap({
        spec: this.map.spec,
        preset: this.map.preset,
        props: this.map.props,
        terrain: this.map.terrain,
      });
      this.map.audioAttached = true;
    }
    this.input.requestLock();
    this.clock.getDelta(); // discard the pause gap
  }

  // ── loop ────────────────────────────────────────────────────────
  start() {
    if (this.started) return;
    this.started = true;
    const loop = () => {
      requestAnimationFrame(loop);
      this.tick();
    };
    loop();
  }

  tick() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.time += dt;
    this.frame++;

    if (!this.map) {
      this.renderer.clear();
      return;
    }

    const m = this.map;
    const input = this.input.sample(dt, m.skier.heading);

    if (!this.paused && !this.loading) {
      m.skier.update(dt, input, m.world);
      this.drainEvents(m.skier);
      m.bots.update(dt, m.skier.pos);
      m.props.update(dt, this.time);
      if (m.precip && m.precip.points.visible) {
        m.precip.update(dt, this.view.camera, m.windVec);
      }
    }

    // Weather that changes with height, for mountains tall enough to have
    // more than one sky.
    if (m.spec.weatherStops) {
      const t = clamp(m.skier.pos.z / m.terrain.length, 0, 1);
      applyPreset(presetAt(m.spec.weatherStops, t), {
        sky: m.sky, lighting: m.lighting, scene: this.scene, renderer: this.renderer,
      });
    }

    this.view.update(dt, m.skier, input, this.time);
    m.sky.update(this.view.camera);
    updateSnowMaterial(m.snowMat, this.time);

    // Keep the shadow frustum centred on the player.
    const sun = m.lighting.sun;
    sun.target.position.copy(m.skier.pos);
    sun.position.copy(m.skier.pos).addScaledVector(m.sky.sunDir, 900);
    sun.target.updateMatrixWorld();

    this.audio.update(dt, {
      skier: m.skier,
      view: this.view,
      bots: m.bots,
      paused: this.paused || this.loading,
    });

    if (!this.paused) {
      this.hud.update(dt, { skier: m.skier, terrain: m.terrain, bots: m.bots });
    }

    this.view.render(this.renderer, this.scene);
  }

  drainEvents(skier) {
    if (!skier.events.length) return;
    const events = skier.events.splice(0, skier.events.length);
    this.audio.handleEvents(events);

    for (const ev of events) {
      if (ev.type === 'land' && ev.height > 3.5) {
        const label = ev.height > 11 ? 'Huge air' : ev.height > 6.5 ? 'Big air' : 'Nice air';
        this.hud.toast(label, `${ev.height.toFixed(1)} m · ${ev.airTime.toFixed(1)}s`);
      } else if (ev.type === 'crash') {
        this.hud.toast(ev.cause === 'tree' ? 'Into the trees' : 'Down you go');
      } else if (ev.type === 'reachedBase') {
        const s = skier.stats;
        this.hud.toast('Bottom of the run', `${Math.round(s.descent)} m vertical · ride up for another`);
      } else if (ev.type === 'liftOn') {
        this.hud.toast(ev.lift?.name ? `On the ${ev.lift.name}` : 'On the lift',
          'Sit back. Press E to get off early.');
      } else if (ev.type === 'liftSkip') {
        this.hud.toast(ev.lift?.name ? `Top of the ${ev.lift.name}` : 'Top of the lift');
      }
    }
  }
}

const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
