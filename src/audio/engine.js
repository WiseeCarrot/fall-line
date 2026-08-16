// Audio engine. Every sound in this game is generated here at runtime — there
// are no audio files anywhere in the project.
//
// Signal flow:
//   sources → bus (sfx / ski / ambient / music / ui) → master → limiter → out
//   each bus also has a send into a procedurally generated convolution reverb
//
// The mountain reverb is a synthesised impulse response: sparse early
// reflections off distant valley walls, then a long, dark, quiet tail.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.buses = {};
    this.buffers = {};
    this.volumes = { master: 0.85, sfx: 1, music: 0.55, ambient: 0.9 };
    this.muted = false;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    const ctx = this.ctx;

    // ── master chain ────────────────────────────────────────────
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.16;

    this.master = ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // A gentle high shelf cut keeps the noise-heavy ski layers from getting
    // fizzy when several are open at once.
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'highshelf';
    this.tone.frequency.value = 7000;
    this.tone.gain.value = -3.5;

    this.master.connect(this.tone);
    this.tone.connect(this.limiter);
    this.limiter.connect(ctx.destination);

    // ── reverb ──────────────────────────────────────────────────
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = this.makeImpulseResponse(3.4, 0.32);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.9;
    const revDamp = ctx.createBiquadFilter();
    revDamp.type = 'lowpass';
    revDamp.frequency.value = 3400;
    this.convolver.connect(revDamp);
    revDamp.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    // ── buses ───────────────────────────────────────────────────
    for (const name of ['sfx', 'ski', 'ambient', 'music', 'ui']) {
      const g = ctx.createGain();
      const send = ctx.createGain();
      g.connect(this.master);
      g.connect(send);
      send.connect(this.convolver);
      send.gain.value = { sfx: 0.22, ski: 0.1, ambient: 0.3, music: 0.42, ui: 0.05 }[name];
      this.buses[name] = { gain: g, send };
    }

    // ── noise sources ───────────────────────────────────────────
    this.buffers.white = this.makeNoise('white', 4);
    this.buffers.pink = this.makeNoise('pink', 4);
    this.buffers.brown = this.makeNoise('brown', 5);

    this.applyVolumes();
    this.ready = true;
    return this;
  }

  get time() { return this.ctx ? this.ctx.currentTime : 0; }

  applyVolumes() {
    if (!this.ready) return;
    const v = this.volumes;
    const m = this.muted ? 0 : 1;
    this.master.gain.value = v.master * m;
    this.buses.sfx.gain.gain.value = v.sfx;
    this.buses.ski.gain.gain.value = v.sfx;
    this.buses.ui.gain.gain.value = v.sfx * 0.8;
    this.buses.music.gain.gain.value = v.music;
    this.buses.ambient.gain.gain.value = v.ambient;
  }

  setVolume(key, value) {
    this.volumes[key] = clamp01(value);
    this.applyVolumes();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.applyVolumes();
    return this.muted;
  }

  // ── procedural buffers ────────────────────────────────────────
  /**
   * Coloured noise. Pink uses Paul Kellet's economy filter; brown is a leaky
   * integrator. Both loop, so DC offset has to be trimmed or the loop thumps.
   */
  makeNoise(kind, seconds) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);

    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      if (kind === 'white') {
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      } else if (kind === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + w * 0.0555179;
          b1 = 0.99332 * b1 + w * 0.0750759;
          b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856;
          b4 = 0.55000 * b4 + w * 0.5329522;
          b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
          b6 = w * 0.115926;
        }
      } else {
        let last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          d[i] = last * 3.5;
        }
      }

      // De-click the loop point with a short equal-power crossfade.
      const fade = Math.min(2048, len >> 4);
      for (let i = 0; i < fade; i++) {
        const t = i / fade;
        const a = Math.cos((1 - t) * Math.PI * 0.5);
        const b = Math.cos(t * Math.PI * 0.5);
        d[i] = d[i] * a + d[len - fade + i] * b;
      }

      let mean = 0;
      for (let i = 0; i < len; i++) mean += d[i];
      mean /= len;
      for (let i = 0; i < len; i++) d[i] -= mean;
    }
    return buf;
  }

  /**
   * Impulse response for a wide, cold, open valley: a handful of discrete
   * early reflections from ridgelines, then a diffuse exponential tail.
   */
  makeImpulseResponse(seconds, wetness) {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = this.ctx.createBuffer(2, len, sr);

    const taps = [0.031, 0.058, 0.094, 0.137, 0.191, 0.263, 0.35, 0.47];
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const skew = ch === 0 ? 1 : 1.07;

      for (let i = 0; i < len; i++) {
        const t = i / len;
        const decay = Math.pow(1 - t, 2.6);
        d[i] = (Math.random() * 2 - 1) * decay * 0.32;
      }
      for (const tap of taps) {
        const idx = Math.floor(tap * skew * sr);
        if (idx < len) {
          const amp = (1 - tap) * 0.55 * (Math.random() * 0.5 + 0.5);
          for (let k = 0; k < 220; k++) {
            if (idx + k >= len) break;
            d[idx + k] += (Math.random() * 2 - 1) * amp * (1 - k / 220);
          }
        }
      }
      for (let i = 0; i < len; i++) d[i] *= wetness;
    }
    return buf;
  }

  // ── node helpers ──────────────────────────────────────────────
  noiseSource(kind = 'white', playbackRate = 1) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffers[kind];
    src.loop = true;
    src.playbackRate.value = playbackRate;
    return src;
  }

  gain(value = 0) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  filter(type, freq, Q = 1) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    return f;
  }

  osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /** Constant-power stereo placement plus distance rolloff, done in JS. */
  panner() {
    const p = this.ctx.createStereoPanner();
    return p;
  }

  /** Smooth parameter moves. Web Audio param ramps are per-parameter cheap. */
  set(param, value, tau = 0.06) {
    if (!Number.isFinite(value)) return;
    param.setTargetAtTime(value, this.ctx.currentTime, Math.max(0.005, tau));
  }

  suspend() { if (this.ctx?.state === 'running') this.ctx.suspend(); }
  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }
}
