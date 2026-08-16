// The continuous voice of skiing. These layers run forever once started and
// are mixed purely by moving gains and filter cutoffs, which is far cheaper
// (and smoother) than retriggering sounds.
//
// The mix is designed so you can hear what you're doing with your eyes shut:
// hard snow is bright and hissy, powder is a dull roar, an edge that's holding
// is a narrow band that rises in pitch as you load it, and ice chatters.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class SkiLayers {
  constructor(engine) {
    this.e = engine;
    this.started = false;
    this.nodes = {};
  }

  start() {
    if (this.started || !this.e.ready) return;
    const e = this.e;
    const bus = e.buses.ski.gain;
    const n = this.nodes;
    this.started = true;

    // Shared chatter modulator: bumps and ice make the contact sound pulse.
    n.chatterOsc = e.osc('sawtooth', 12);
    n.chatterDepth = e.gain(0);
    n.chatterOsc.connect(n.chatterDepth);
    n.chatterOsc.start();

    const modulated = () => {
      const g = e.gain(1);
      n.chatterDepth.connect(g.gain);
      return g;
    };

    // ── 1. base contact: the broadband rush of bases on snow
    n.baseSrc = e.noiseSource('pink');
    n.baseFilter = e.filter('bandpass', 420, 0.7);
    n.baseGain = e.gain(0);
    n.baseMod = modulated();
    n.baseSrc.connect(n.baseFilter).connect(n.baseMod).connect(n.baseGain).connect(bus);
    n.baseSrc.start();

    // ── 2. hard-snow hiss: bright, only on groomed or scoured surfaces
    n.hissSrc = e.noiseSource('white');
    n.hissFilter = e.filter('highpass', 2600, 0.8);
    n.hissGain = e.gain(0);
    n.hissSrc.connect(n.hissFilter).connect(n.hissGain).connect(bus);
    n.hissSrc.start();

    // ── 3. edge: a resonant band that climbs as the edge is loaded
    n.edgeSrc = e.noiseSource('white');
    n.edgeFilter = e.filter('bandpass', 1400, 5.5);
    n.edgePeak = e.filter('peaking', 2600, 3);
    n.edgePeak.gain.value = 6;
    n.edgeGain = e.gain(0);
    n.edgeMod = modulated();
    n.edgeSrc.connect(n.edgeFilter).connect(n.edgePeak).connect(n.edgeMod)
      .connect(n.edgeGain).connect(bus);
    n.edgeSrc.start();

    // ── 4. powder: low, soft, enveloping
    n.powSrc = e.noiseSource('brown');
    n.powFilter = e.filter('lowpass', 420, 0.9);
    n.powGain = e.gain(0);
    n.powSrc.connect(n.powFilter).connect(n.powGain).connect(bus);
    n.powSrc.start();

    // ── 5. ice: narrow, glassy, aggressively chattering
    n.iceSrc = e.noiseSource('white');
    n.iceFilter = e.filter('bandpass', 3100, 13);
    n.iceGain = e.gain(0);
    n.iceMod = modulated();
    n.iceSrc.connect(n.iceFilter).connect(n.iceMod).connect(n.iceGain).connect(bus);
    n.iceSrc.start();

    // ── 6. wind in your ears, driven by airspeed not ground speed
    n.windSrc = e.noiseSource('brown', 1.0);
    n.windFilter = e.filter('lowpass', 380, 0.6);
    n.windGain = e.gain(0);
    n.windSrc.connect(n.windFilter).connect(n.windGain).connect(bus);
    n.windSrc.start();

    n.whistleSrc = e.noiseSource('white');
    n.whistleFilter = e.filter('bandpass', 900, 9);
    n.whistleGain = e.gain(0);
    n.whistleSrc.connect(n.whistleFilter).connect(n.whistleGain).connect(bus);
    n.whistleSrc.start();

    // ── 7. rail grind: metal, harmonic, with a noise edge
    n.grindOsc = e.osc('sawtooth', 180);
    n.grindOsc2 = e.osc('square', 271);
    n.grindNoise = e.noiseSource('white');
    n.grindFilter = e.filter('bandpass', 2200, 7);
    n.grindGain = e.gain(0);
    const grindMix = e.gain(0.5);
    n.grindOsc.connect(grindMix);
    n.grindOsc2.connect(e.gain(0.35)).connect(grindMix);
    n.grindNoise.connect(e.gain(0.5)).connect(grindMix);
    grindMix.connect(n.grindFilter).connect(n.grindGain).connect(bus);
    n.grindOsc.start(); n.grindOsc2.start(); n.grindNoise.start();
  }

  /**
   * @param s.speed     m/s along the snow
   * @param s.airSpeed  m/s through the air (includes falling)
   * @param s.edge      0..1 how hard the edges are loaded
   * @param s.slip      0..1 how much the skis are sliding sideways
   * @param s.grounded  boolean
   * @param s.deep      0..1 powder depth
   * @param s.ice       0..1
   * @param s.groom     0..1
   * @param s.rock      0..1
   * @param s.rough     0..1 terrain roughness under the skis
   * @param s.grinding  0..1 on a rail
   */
  update(s, dt) {
    if (!this.started) return;
    const e = this.e;
    const n = this.nodes;

    const v = clamp(s.speed / 34, 0, 1.5);        // normalised speed
    const contact = s.grounded ? 1 : 0;
    const hard = clamp(s.groom * 0.7 + s.ice * 0.9 + s.rock * 0.5, 0, 1);
    const soft = clamp(s.deep * 2.2, 0, 1);

    // chatter rate follows how fast bumps pass under the skis
    const chatterHz = clamp(4 + s.speed * (2.2 + s.ice * 2.5), 3, 90);
    e.set(n.chatterOsc.frequency, chatterHz, 0.05);
    const chatterAmt = contact * clamp(s.rough * 0.55 + s.ice * 0.45 * s.edge, 0, 0.9) * clamp(v * 1.4, 0, 1);
    e.set(n.chatterDepth.gain, chatterAmt, 0.08);

    // 1. base
    e.set(n.baseFilter.frequency, 320 + s.speed * 26 + soft * -90, 0.08);
    e.set(n.baseGain.gain, contact * clamp(v * 0.72, 0, 0.72) * (0.45 + s.slip * 0.55), 0.07);

    // 2. hiss
    e.set(n.hissFilter.frequency, 2300 + s.speed * 55, 0.1);
    e.set(n.hissGain.gain, contact * hard * clamp(v * v * 0.3, 0, 0.3) * (1 - soft * 0.8), 0.08);

    // 3. edge — the pitch rise under load is the main feedback for carving
    e.set(n.edgeFilter.frequency, 900 + s.edge * 1700 + s.speed * 34, 0.05);
    e.set(n.edgeFilter.Q, 3 + s.edge * 7, 0.1);
    e.set(n.edgeGain.gain, contact * s.edge * clamp(v * 0.5, 0, 0.5) * (0.35 + hard * 0.65), 0.05);

    // 4. powder
    e.set(n.powFilter.frequency, 260 + s.speed * 12, 0.1);
    e.set(n.powGain.gain, contact * soft * clamp(v * 0.85, 0, 0.85), 0.09);

    // 5. ice
    e.set(n.iceFilter.frequency, 2600 + s.edge * 1400, 0.07);
    e.set(n.iceGain.gain, contact * s.ice * clamp(v * 0.42, 0, 0.42) * (0.3 + s.edge * 0.7), 0.06);

    // 6. wind
    const a = clamp(s.airSpeed / 40, 0, 1.4);
    e.set(n.windFilter.frequency, 260 + s.airSpeed * 34, 0.12);
    e.set(n.windGain.gain, clamp(a * a * 0.9, 0, 0.95), 0.1);
    e.set(n.whistleFilter.frequency, 620 + s.airSpeed * 26, 0.12);
    e.set(n.whistleGain.gain, clamp((a - 0.45) * 0.34, 0, 0.24), 0.14);

    // 7. grind
    if (s.grinding > 0.01) {
      const base = 130 + s.speed * 9;
      e.set(n.grindOsc.frequency, base, 0.04);
      e.set(n.grindOsc2.frequency, base * 1.51, 0.04);
      e.set(n.grindFilter.frequency, 1600 + s.speed * 60, 0.05);
    }
    e.set(n.grindGain.gain, s.grinding * clamp(v * 0.4, 0.05, 0.4), 0.04);
  }

  /** Duck everything for menus and pauses. */
  silence() {
    if (!this.started) return;
    const n = this.nodes;
    for (const key of ['baseGain', 'hissGain', 'edgeGain', 'powGain', 'iceGain', 'windGain', 'whistleGain', 'grindGain']) {
      this.e.set(n[key].gain, 0, 0.08);
    }
    this.e.set(n.chatterDepth.gain, 0, 0.08);
  }
}

/**
 * Ambient bed: a wide wind bed with slow gusts, plus incidental life (birds,
 * distant lift machinery, the murmur of a base area). Everything is scheduled
 * rather than looped so it never sounds like a tape.
 */
export class Ambience {
  constructor(engine) {
    this.e = engine;
    this.started = false;
    this.timers = [];
    this.nextEvent = 0;
  }

  start(preset, mapSpec) {
    if (!this.e.ready || this.started) return;
    this.started = true;
    this.preset = preset;
    this.spec = mapSpec;
    const e = this.e;
    const bus = e.buses.ambient.gain;

    // Broad wind bed
    this.bed = e.noiseSource('brown', 0.8);
    this.bedFilter = e.filter('lowpass', 300, 0.5);
    this.bedGain = e.gain(0);
    this.bed.connect(this.bedFilter).connect(this.bedGain).connect(bus);
    this.bed.start();
    e.set(this.bedGain.gain, 0.06 + preset.wind * 0.14, 2.5);

    // Gust modulation on top of the bed
    this.gustSrc = e.noiseSource('brown', 0.55);
    this.gustFilter = e.filter('bandpass', 420, 1.1);
    this.gustGain = e.gain(0);
    this.gustSrc.connect(this.gustFilter).connect(this.gustGain).connect(bus);
    this.gustSrc.start();

    // High trees hissing in the wind, if there are any
    if (mapSpec.trees.density > 0.2) {
      this.treeSrc = e.noiseSource('pink');
      this.treeFilter = e.filter('bandpass', 1800, 1.4);
      this.treeGain = e.gain(0);
      this.treeSrc.connect(this.treeFilter).connect(this.treeGain).connect(bus);
      this.treeSrc.start();
      e.set(this.treeGain.gain, 0.018 * preset.wind * mapSpec.trees.density, 3);
    }

    this.gustPhase = Math.random() * 10;
    this.birdTimer = 4 + Math.random() * 8;
    this.creakTimer = 10 + Math.random() * 20;
  }

  update(dt, ctxState) {
    if (!this.started) return;
    const e = this.e;
    const p = this.preset;

    // Layered slow LFOs give gusts that never repeat on an obvious period.
    this.gustPhase += dt;
    const g =
      Math.sin(this.gustPhase * 0.13) * 0.5 +
      Math.sin(this.gustPhase * 0.291 + 1.7) * 0.3 +
      Math.sin(this.gustPhase * 0.061 + 4.1) * 0.2;
    const gust = Math.max(0, g) ** 1.6;
    e.set(this.gustGain.gain, gust * (0.05 + p.wind * 0.2), 0.5);
    e.set(this.gustFilter.frequency, 300 + gust * 500 + p.wind * 200, 0.5);
    if (this.treeGain) {
      e.set(this.treeGain.gain, (0.012 + gust * 0.05) * p.wind * this.spec.trees.density, 0.6);
    }

    // Birds only where there are trees, and not in a storm or at night.
    const quiet = p.wind < 1.2 && !p.stars;
    if (this.spec.trees.density > 0.25 && quiet) {
      this.birdTimer -= dt;
      if (this.birdTimer <= 0) {
        this.birdTimer = 6 + Math.random() * 22;
        this.chirp();
      }
    }

    // Cold trees and lift towers pop and creak.
    this.creakTimer -= dt;
    if (this.creakTimer <= 0) {
      this.creakTimer = 14 + Math.random() * 40;
      this.creak();
    }
  }

  chirp() {
    const e = this.e;
    const t = e.time;
    const notes = 2 + Math.floor(Math.random() * 3);
    const baseF = 2200 + Math.random() * 1600;
    const pan = e.panner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const out = e.gain(0.09 + Math.random() * 0.06);
    pan.connect(out).connect(e.buses.ambient.gain);

    for (let i = 0; i < notes; i++) {
      const start = t + i * (0.09 + Math.random() * 0.07);
      const dur = 0.05 + Math.random() * 0.05;
      const o = e.osc('sine', baseF);
      const mod = e.osc('sine', baseF * 2.1);
      const modGain = e.gain(baseF * 0.5);
      mod.connect(modGain).connect(o.frequency);
      const g = e.gain(0);
      o.connect(g).connect(pan);

      o.frequency.setValueAtTime(baseF * (0.9 + Math.random() * 0.3), start);
      o.frequency.exponentialRampToValueAtTime(baseF * (1.1 + Math.random() * 0.5), start + dur);
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(1, start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, start + dur);
      o.start(start); mod.start(start);
      o.stop(start + dur + 0.05); mod.stop(start + dur + 0.05);
    }
  }

  creak() {
    const e = this.e;
    const t = e.time;
    const dur = 0.5 + Math.random() * 1.2;
    const src = e.noiseSource('pink');
    const f = e.filter('bandpass', 180 + Math.random() * 260, 22);
    const g = e.gain(0);
    const pan = e.panner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    src.connect(f).connect(g).connect(pan).connect(e.buses.ambient.gain);
    src.start(t);

    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05 + Math.random() * 0.04, t + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    f.frequency.linearRampToValueAtTime(f.frequency.value * (0.6 + Math.random() * 0.6), t + dur);
    src.stop(t + dur + 0.1);
  }

  silence() {
    if (!this.started) return;
    for (const g of [this.bedGain, this.gustGain, this.treeGain]) {
      if (g) this.e.set(g.gain, 0, 0.3);
    }
  }

  restore() {
    if (!this.started) return;
    this.e.set(this.bedGain.gain, 0.06 + this.preset.wind * 0.14, 1.0);
  }

  /** Stop the looping sources for good — silence() only fades them. */
  dispose() {
    if (!this.started) return;
    this.silence();
    const at = this.e.time + 0.4;
    for (const s of [this.bed, this.gustSrc, this.treeSrc]) {
      if (s) { try { s.stop(at); } catch { /* already stopped */ } }
    }
    this.started = false;
  }
}
