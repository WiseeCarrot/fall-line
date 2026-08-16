// One-shot sound effects and positional emitters. All synthesised.
//
// Positional audio here is deliberately hand-rolled rather than using
// PannerNode: we only ever have a handful of emitters, and computing rolloff
// and pan in JS avoids fighting the listener's orientation every frame.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rand = (a, b) => a + Math.random() * (b - a);

// A narrow bandpass throws away nearly all of a noise source's energy — a Q of
// 20 leaves well under a tenth of it. The resonant one-shots below (bamboo,
// steel, wood) therefore need gains that look absurd next to the broadband
// ones; measured at the master bus they land in the same place.
const Q_MAKEUP = (q) => Math.sqrt(Math.max(1, q)) * 2.6;

export class PositionalSource {
  constructor(engine, { ref = 25, max = 400, gain = 1 } = {}) {
    this.e = engine;
    this.ref = ref;
    this.max = max;
    this.baseGain = gain;
    this.pan = engine.panner();
    this.out = engine.gain(0);
    this.pan.connect(this.out);
    this.position = { x: 0, y: 0, z: 0 };
    // Looping oscillators and buffer sources run until explicitly stopped.
    // Without this, every map you load leaves its emitters churning forever.
    this.sources = [];
  }

  track(...nodes) {
    this.sources.push(...nodes);
    return nodes[nodes.length - 1];
  }

  dispose(fade = 0.25) {
    const stopAt = this.e.time + fade + 0.05;
    this.e.set(this.out.gain, 0, fade * 0.4);
    for (const s of this.sources) {
      try { s.stop(stopAt); } catch { /* already stopped */ }
    }
    this.sources.length = 0;
    setTimeout(() => { try { this.out.disconnect(); } catch { /* gone */ } }, (fade + 0.2) * 1000);
  }

  connect(dest) { this.out.connect(dest); return this; }
  get input() { return this.pan; }

  setPosition(x, y, z) { this.position.x = x; this.position.y = y; this.position.z = z; }

  /** listenerRight must be a unit vector pointing out of the listener's right ear. */
  update(listener, right, occlusion = 1) {
    const dx = this.position.x - listener.x;
    const dy = this.position.y - listener.y;
    const dz = this.position.z - listener.z;
    const dist = Math.hypot(dx, dy, dz);

    if (dist > this.max) {
      this.e.set(this.out.gain, 0, 0.2);
      return 0;
    }
    const rolloff = this.ref / (this.ref + Math.max(0, dist - this.ref) * 1.35);
    const edge = 1 - clamp((dist - this.max * 0.7) / (this.max * 0.3), 0, 1);
    const g = rolloff * edge * this.baseGain * occlusion;
    this.e.set(this.out.gain, g, 0.15);

    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = clamp((dx * right.x + dz * right.z) * inv, -1, 1);
    this.e.set(this.pan.pan, pan * 0.85, 0.12);
    return g;
  }
}

export class Sfx {
  constructor(engine) {
    this.e = engine;
    this.lastCrash = -10;
  }

  get bus() { return this.e.buses.sfx.gain; }

  // ── air / snow ────────────────────────────────────────────────
  /** Pop off a lip: ski unweighting, then a short whoosh of clean air. */
  jump(power = 1) {
    const e = this.e, t = e.time;
    const p = clamp(power, 0.2, 1.6);

    // unweighting scrape
    const src = e.noiseSource('white');
    const f = e.filter('bandpass', 900 + p * 500, 1.6);
    const g = e.gain(0);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42 * p, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.2);
    src.stop(t + 0.3);

    // body movement thump
    const o = e.osc('sine', 150);
    const og = e.gain(0);
    o.connect(og).connect(this.bus);
    o.frequency.setValueAtTime(150 * p, t);
    o.frequency.exponentialRampToValueAtTime(58, t + 0.13);
    og.gain.setValueAtTime(0.22 * p, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    o.start(t); o.stop(t + 0.2);
  }

  /**
   * Landing. Deep snow gives a soft muffled whump, hardpack a sharp slap, and
   * a big impact adds a low body thud you feel more than hear.
   */
  land(impact = 1, surface = {}) {
    const e = this.e, t = e.time;
    const i = clamp(impact, 0.1, 2.2);
    const deep = surface.deep ?? 0.2;
    const hard = clamp(1 - deep * 2, 0, 1);

    const src = e.noiseSource('white');
    const f = e.filter('lowpass', 400 + hard * 3400, 1.1);
    const g = e.gain(0);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    const dur = 0.1 + deep * 0.35;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3 * i, t + 0.005 + deep * 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    f.frequency.exponentialRampToValueAtTime(220 + hard * 900, t + dur);
    src.stop(t + dur + 0.1);

    const o = e.osc('sine', 90);
    const og = e.gain(0);
    const od = e.filter('lowpass', 200, 0.7);
    o.connect(od).connect(og).connect(this.bus);
    o.frequency.setValueAtTime(96, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    og.gain.setValueAtTime(0.34 * i, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    o.start(t); o.stop(t + 0.3);

    // spray of snow flicked up on a hard landing
    if (i > 0.7) {
      const s2 = e.noiseSource('pink');
      const f2 = e.filter('highpass', 1800, 0.8);
      const g2 = e.gain(0);
      s2.connect(f2).connect(g2).connect(this.bus);
      s2.start(t + 0.02);
      g2.gain.setValueAtTime(0, t + 0.02);
      g2.gain.linearRampToValueAtTime(0.1 * (i - 0.7), t + 0.05);
      g2.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
      s2.stop(t + 0.55);
    }
  }

  /** A yard sale: impact, tumble, and snow going everywhere. */
  crash(intensity = 1) {
    const e = this.e, t = e.time;
    if (t - this.lastCrash < 0.4) return;
    this.lastCrash = t;
    const i = clamp(intensity, 0.4, 2);

    this.land(i * 1.3, { deep: 0.15 });

    // tumbling: a few irregular muffled impacts
    const bumps = 3 + Math.floor(Math.random() * 3);
    for (let k = 0; k < bumps; k++) {
      const st = t + 0.14 + k * rand(0.1, 0.22);
      const o = e.osc('sine', rand(70, 130));
      const g = e.gain(0);
      const lp = e.filter('lowpass', 300, 0.8);
      o.connect(lp).connect(g).connect(this.bus);
      o.frequency.exponentialRampToValueAtTime(40, st + 0.12);
      g.gain.setValueAtTime(0.16 * i * (1 - k / bumps), st);
      g.gain.exponentialRampToValueAtTime(0.001, st + 0.16);
      o.start(st); o.stop(st + 0.2);

      const s = e.noiseSource('white');
      const f = e.filter('bandpass', rand(400, 1600), 1.3);
      const sg = e.gain(0);
      s.connect(f).connect(sg).connect(this.bus);
      s.start(st);
      sg.gain.setValueAtTime(0.11 * i, st);
      sg.gain.exponentialRampToValueAtTime(0.001, st + 0.2);
      s.stop(st + 0.25);
    }

    // long hiss of sliding to a stop
    const sl = e.noiseSource('pink');
    const sf = e.filter('lowpass', 1400, 0.7);
    const sg = e.gain(0);
    sl.connect(sf).connect(sg).connect(this.bus);
    sl.start(t + 0.1);
    sg.gain.setValueAtTime(0, t + 0.1);
    sg.gain.linearRampToValueAtTime(0.14 * i, t + 0.25);
    sg.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
    sf.frequency.exponentialRampToValueAtTime(300, t + 1.4);
    sl.stop(t + 1.7);
  }

  /** Hitting a tree: modal wood tone plus a shower of snow off the branches. */
  treeHit(force = 1) {
    const e = this.e, t = e.time;
    const modes = [174, 292, 431, 688];
    for (let m = 0; m < modes.length; m++) {
      const src = e.noiseSource('white');
      const q = 26 - m * 4;
      const f = e.filter('bandpass', modes[m] * rand(0.96, 1.04), q);
      const g = e.gain(0);
      src.connect(f).connect(g).connect(this.bus);
      src.start(t);
      const amp = (0.5 / (m + 1)) * force * 0.6 * Q_MAKEUP(q) * 0.35;
      g.gain.setValueAtTime(amp, t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.28 - m * 0.05);
      src.stop(t + 0.4);
    }
    // snow dumping out of the canopy a beat later
    const s = e.noiseSource('pink');
    const f = e.filter('lowpass', 900, 0.8);
    const g = e.gain(0);
    s.connect(f).connect(g).connect(this.bus);
    s.start(t + 0.12);
    g.gain.setValueAtTime(0, t + 0.12);
    g.gain.linearRampToValueAtTime(0.12 * force, t + 0.2);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    s.stop(t + 1.0);
  }

  rockHit(force = 1) {
    const e = this.e, t = e.time;
    const src = e.noiseSource('white');
    const q = 9;
    const f = e.filter('bandpass', rand(1400, 2600), q);
    const g = e.gain(0);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    g.gain.setValueAtTime(0.3 * force * Q_MAKEUP(q) * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.14);
    src.stop(t + 0.2);

    const o = e.osc('triangle', 220);
    const og = e.gain(0.24 * force);
    o.connect(og).connect(this.bus);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.1);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    o.start(t); o.stop(t + 0.16);
  }

  /** Clipping a bamboo marker — light, hollow, harmless. */
  poleHit() {
    const e = this.e, t = e.time;
    for (const fr of [640, 1180]) {
      const src = e.noiseSource('white');
      const q = 18;
      const f = e.filter('bandpass', fr * rand(0.9, 1.1), q);
      const g = e.gain(0.16 * Q_MAKEUP(q));
      src.connect(f).connect(g).connect(this.bus);
      src.start(t);
      g.gain.exponentialRampToValueAtTime(0.0005, t + 0.16);
      src.stop(t + 0.2);
    }
  }

  /** Locking onto a rail / dismounting. */
  railClank(up = true) {
    const e = this.e, t = e.time;
    const modes = up ? [880, 1330, 2100] : [660, 1010, 1620];
    const q = 30;
    modes.forEach((fr, i) => {
      const src = e.noiseSource('white');
      const f = e.filter('bandpass', fr, q);
      const g = e.gain((0.14 / (i + 1)) * Q_MAKEUP(q));
      src.connect(f).connect(g).connect(this.bus);
      src.start(t);
      g.gain.exponentialRampToValueAtTime(0.0004, t + 0.5 - i * 0.1);
      src.stop(t + 0.6);
    });
  }

  /** Passing close to a gate or marker at speed. */
  swish(intensity = 1) {
    const e = this.e, t = e.time;
    const src = e.noiseSource('white');
    const q = 2.2;
    const f = e.filter('bandpass', 700, q);
    const g = e.gain(0);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.09 * intensity * Q_MAKEUP(q), t + 0.04);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(420, t + 0.2);
    src.stop(t + 0.25);
  }

  /** Double pole plant to get moving on a flat. */
  polePush() {
    const e = this.e, t = e.time;
    for (let k = 0; k < 2; k++) {
      const st = t + k * 0.055;
      const src = e.noiseSource('white');
      const q = 4;
      const f = e.filter('bandpass', rand(1600, 2400), q);
      const g = e.gain(0);
      src.connect(f).connect(g).connect(this.bus);
      src.start(st);
      g.gain.setValueAtTime(0.13 * Q_MAKEUP(q), st);
      g.gain.exponentialRampToValueAtTime(0.0008, st + 0.13);
      f.frequency.exponentialRampToValueAtTime(500, st + 0.12);
      src.stop(st + 0.18);
    }
  }

  // ── interface ─────────────────────────────────────────────────
  ui(kind = 'click') {
    const e = this.e, t = e.time;
    const bus = e.buses.ui.gain;
    const spec = {
      hover:   { f: [1320], dur: 0.06, amp: 0.05, type: 'sine' },
      click:   { f: [880, 1320], dur: 0.11, amp: 0.11, type: 'triangle' },
      confirm: { f: [660, 990, 1320], dur: 0.26, amp: 0.1, type: 'triangle' },
      back:    { f: [660, 440], dur: 0.14, amp: 0.09, type: 'sine' },
      toggle:  { f: [1046], dur: 0.09, amp: 0.08, type: 'square' },
    }[kind] || { f: [880], dur: 0.1, amp: 0.1, type: 'sine' };

    spec.f.forEach((fr, i) => {
      const st = t + i * spec.dur * 0.35;
      const o = e.osc(spec.type, fr);
      const g = e.gain(0);
      const lp = e.filter('lowpass', 5200, 0.9);
      o.connect(lp).connect(g).connect(bus);
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(spec.amp, st + 0.006);
      g.gain.exponentialRampToValueAtTime(0.0004, st + spec.dur);
      o.start(st); o.stop(st + spec.dur + 0.05);
    });
  }
}

// ── continuous positional emitters ────────────────────────────────

/** A running chairlift: bullwheel hum, cable whir, and tower sheave clanks. */
export class LiftEmitter extends PositionalSource {
  constructor(engine) {
    super(engine, { ref: 22, max: 320, gain: 0.55 });
    const e = engine;

    const hum = e.osc('sawtooth', 46);
    const hum2 = e.osc('sine', 92);
    const humFilter = e.filter('lowpass', 260, 3.2);
    const humGain = e.gain(0.16);
    hum.connect(humFilter);
    hum2.connect(e.gain(0.4)).connect(humFilter);
    humFilter.connect(humGain).connect(this.input);
    hum.start(); hum2.start();
    this.track(hum, hum2);

    const whir = e.noiseSource('pink');
    const whirFilter = e.filter('bandpass', 1100, 3);
    const whirGain = e.gain(0.05);
    whir.connect(whirFilter).connect(whirGain).connect(this.input);
    whir.start();
    this.track(whir);

    this.clankTimer = 2;
    this.connect(e.buses.ambient.gain);
  }

  tick(dt) {
    this.clankTimer -= dt;
    if (this.clankTimer <= 0) {
      this.clankTimer = rand(3.4, 7.5);
      this.clank();
    }
  }

  clank() {
    const e = this.e, t = e.time;
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const st = t + i * rand(0.06, 0.12);
      const src = e.noiseSource('white');
      const f = e.filter('bandpass', rand(700, 1900), 24);
      const g = e.gain(rand(0.05, 0.12));
      src.connect(f).connect(g).connect(this.input);
      src.start(st);
      g.gain.exponentialRampToValueAtTime(0.0004, st + rand(0.15, 0.4));
      src.stop(st + 0.5);
    }
  }
}

/** The base area: muffled crowd, boots on decking, the odd clatter of gear. */
export class LodgeEmitter extends PositionalSource {
  constructor(engine) {
    super(engine, { ref: 30, max: 260, gain: 0.42 });
    const e = engine;

    const crowd = e.noiseSource('pink');
    const band = e.filter('bandpass', 620, 1.1);
    const lp = e.filter('lowpass', 1500, 0.7);
    const g = e.gain(0.1);
    crowd.connect(band).connect(lp).connect(g).connect(this.input);
    crowd.start();

    // slow swell so the crowd breathes
    const lfo = e.osc('sine', 0.09);
    const lfoGain = e.gain(0.035);
    lfo.connect(lfoGain).connect(g.gain);
    lfo.start();
    this.track(crowd, lfo);

    this.clatterTimer = 3;
    this.connect(e.buses.ambient.gain);
  }

  tick(dt) {
    this.clatterTimer -= dt;
    if (this.clatterTimer <= 0) {
      this.clatterTimer = rand(2.5, 9);
      const e = this.e, t = e.time;
      const src = e.noiseSource('white');
      const f = e.filter('bandpass', rand(1200, 3000), 12);
      const g = e.gain(rand(0.03, 0.07));
      src.connect(f).connect(g).connect(this.input);
      src.start(t);
      g.gain.exponentialRampToValueAtTime(0.0004, t + rand(0.1, 0.3));
      src.stop(t + 0.4);
    }
  }
}

/** A bot skiing past you — brief, close, and panned. */
export class PassbyPool {
  constructor(engine, size = 6) {
    this.e = engine;
    this.voices = [];
    for (let i = 0; i < size; i++) {
      const p = new PositionalSource(engine, { ref: 9, max: 70, gain: 0.85 });
      const src = engine.noiseSource('pink');
      const f = engine.filter('bandpass', 700, 1.4);
      const g = engine.gain(0);
      src.connect(f).connect(g).connect(p.input);
      src.start();
      p.track(src);
      p.connect(engine.buses.sfx.gain);
      this.voices.push({ p, f, g, active: false });
    }
  }

  dispose() {
    for (const v of this.voices) v.p.dispose(0.2);
    this.voices.length = 0;
  }

  /** Drive one voice from a nearby bot's state. */
  drive(index, x, y, z, speed, edge) {
    const v = this.voices[index % this.voices.length];
    v.p.setPosition(x, y, z);
    const e = this.e;
    e.set(v.f.frequency, 420 + speed * 34 + edge * 500, 0.08);
    e.set(v.g.gain, Math.min(0.5, speed / 30) * (0.3 + edge * 0.7), 0.09);
    v.active = true;
    return v.p;
  }

  quiet(index) {
    const v = this.voices[index % this.voices.length];
    this.e.set(v.g.gain, 0, 0.15);
    v.active = false;
  }

  get size() { return this.voices.length; }
}
