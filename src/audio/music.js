// Generative ambient score. There's no loop and no recorded material — a
// lookahead scheduler places pad chords, bass and bell figures on a slow grid,
// choosing voicings from a mood palette tied to the map you're on.
//
// Everything is scheduled ~1 bar ahead of the audio clock so the game loop's
// jitter never lands a note late.

const A4 = 69;
const mtof = (m) => 440 * Math.pow(2, (m - A4) / 12);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Chords as semitone stacks over a root. Progressions are (rootOffset, chord).
const CH = {
  maj7:  [0, 4, 7, 11],
  min7:  [0, 3, 7, 10],
  maj9:  [0, 4, 7, 14],
  min9:  [0, 3, 10, 14],
  sus2:  [0, 2, 7, 12],
  sus4:  [0, 5, 7, 12],
  add9:  [0, 4, 9, 14],
  min:   [0, 3, 7, 12],
  dim:   [0, 3, 6, 10],
  maj:   [0, 4, 7, 12],
};

export const MOODS = {
  calm: {
    root: 57, // A
    prog: [[0, CH.maj9], [-3, CH.maj7], [4, CH.min7], [-1, CH.sus2]],
    bar: 9.5, padCut: 900, bright: 0.5, bells: 0.55, bassLevel: 0.5,
    scale: [0, 2, 4, 7, 9, 11],
  },
  grand: {
    root: 55, // G
    prog: [[0, CH.maj7], [5, CH.sus2], [-4, CH.add9], [2, CH.min7]],
    bar: 11, padCut: 1150, bright: 0.7, bells: 0.4, bassLevel: 0.62,
    scale: [0, 2, 4, 7, 9],
  },
  tense: {
    root: 50, // D
    prog: [[0, CH.min9], [-2, CH.maj7], [3, CH.min7], [-4, CH.sus4]],
    bar: 8, padCut: 620, bright: 0.28, bells: 0.25, bassLevel: 0.8,
    scale: [0, 2, 3, 5, 7, 10],
  },
  cold: {
    root: 53, // F
    prog: [[0, CH.sus2], [7, CH.min7], [-2, CH.maj9], [5, CH.sus4]],
    bar: 12, padCut: 760, bright: 0.42, bells: 0.7, bassLevel: 0.45,
    scale: [0, 2, 5, 7, 10],
  },
  night: {
    root: 50,
    prog: [[0, CH.min9], [-4, CH.maj7], [-6, CH.maj9], [-2, CH.min7]],
    bar: 13, padCut: 560, bright: 0.22, bells: 0.8, bassLevel: 0.7,
    scale: [0, 2, 3, 5, 7, 10],
  },
  park: {
    root: 58, // A#
    prog: [[0, CH.maj7], [3, CH.min7], [-2, CH.sus2], [-4, CH.maj9]],
    bar: 6.4, padCut: 1000, bright: 0.6, bells: 0.5, bassLevel: 0.7,
    scale: [0, 3, 5, 7, 10], drums: true,
  },
  menu: {
    root: 55,
    prog: [[0, CH.maj9], [4, CH.min7], [-3, CH.maj7], [2, CH.sus2]],
    bar: 10, padCut: 850, bright: 0.55, bells: 0.6, bassLevel: 0.4,
    scale: [0, 2, 4, 7, 9, 11],
  },
};

/** Choose a mood from the map spec — steeps get tense, night gets night. */
export function moodForMap(spec) {
  if (spec.category === 'park') return 'park';
  if (spec.weather === 'moonlight' || spec.weather === 'nightpark') return 'night';
  if (spec.weather === 'glacier' || spec.weather === 'whiteout') return 'cold';
  if (spec.difficulty === 'black' || spec.difficulty === 'dblack') return 'tense';
  if (spec.category === 'resort') return 'grand';
  if (spec.category === 'wild') return 'cold';
  return 'calm';
}

export class Music {
  constructor(engine) {
    this.e = engine;
    this.playing = false;
    this.mood = null;
    this.nextBar = 0;
    this.step = 0;
    this.enabled = true;
    this.intensity = 0;   // 0..1, nudged by how fast you're going
    this.out = null;
  }

  ensureOut() {
    if (this.out) return;
    const e = this.e;
    this.out = e.gain(0);
    this.filter = e.filter('lowpass', 2400, 0.7);
    this.out.connect(this.filter);
    this.filter.connect(e.buses.music.gain);
  }

  start(moodKey) {
    if (!this.e.ready || !this.enabled) return;
    this.ensureOut();
    const changed = this.mood !== moodKey;
    this.mood = moodKey;
    this.spec = MOODS[moodKey] || MOODS.calm;
    if (changed) this.step = 0;
    this.playing = true;
    this.nextBar = this.e.time + 0.4;
    this.e.set(this.out.gain, 1, 3.5);
  }

  stop(fade = 2.0) {
    if (!this.out) return;
    this.playing = false;
    this.e.set(this.out.gain, 0, fade);
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.stop(0.6);
  }

  /** Call every frame. Schedules ahead of the audio clock. */
  update(dt, intensity = 0) {
    if (!this.playing || !this.e.ready) return;
    this.intensity += (intensity - this.intensity) * Math.min(1, dt * 0.6);
    // Open the master filter as you pick up speed — subtle, but it makes the
    // score feel like it's responding to the run.
    this.e.set(this.filter.frequency, 1500 + this.intensity * 3200, 1.2);

    const now = this.e.time;
    while (this.nextBar < now + 1.5) {
      this.scheduleBar(this.nextBar);
      this.nextBar += this.spec.bar;
    }
  }

  scheduleBar(t) {
    const s = this.spec;
    const [offset, chord] = s.prog[this.step % s.prog.length];
    const root = s.root + offset;
    this.step++;

    this.pad(t, root, chord);
    this.bass(t, root);
    if (Math.random() < s.bells) this.bellFigure(t, root, chord);
    if (s.drums) this.drumBar(t);
    if (Math.random() < 0.35) this.shimmer(t, root + 24);
  }

  /** Slow-attack detuned saw pad through a moving lowpass. */
  pad(t, root, chord) {
    const e = this.e, s = this.spec;
    const dur = s.bar * 1.15;
    const voices = chord.map((iv) => root + iv);

    for (let i = 0; i < voices.length; i++) {
      const freq = mtof(voices[i] + (i === 0 ? 0 : 12 * (Math.random() < 0.3 ? 1 : 0)));
      const vg = e.gain(0);
      const lp = e.filter('lowpass', s.padCut * 0.5, 1.1);
      const pan = e.panner();
      pan.pan.value = (i / Math.max(1, voices.length - 1)) * 1.2 - 0.6;
      vg.connect(lp).connect(pan).connect(this.out);

      for (const detune of [-6.5, 0, 7.5]) {
        const o = e.osc('sawtooth', freq);
        o.detune.value = detune;
        const og = e.gain(0.055 / voices.length);
        o.connect(og).connect(vg);
        o.start(t);
        o.stop(t + dur + 0.4);
      }
      // a sine underneath keeps the pad from sounding thin
      const sub = e.osc('sine', freq);
      const subG = e.gain(0.05 / voices.length);
      sub.connect(subG).connect(vg);
      sub.start(t); sub.stop(t + dur + 0.4);

      const atk = s.bar * 0.3;
      vg.gain.setValueAtTime(0.0001, t);
      vg.gain.linearRampToValueAtTime(1, t + atk);
      vg.gain.setTargetAtTime(0.0001, t + dur * 0.55, dur * 0.28);

      lp.frequency.setValueAtTime(s.padCut * 0.45, t);
      lp.frequency.linearRampToValueAtTime(s.padCut * (0.9 + s.bright), t + atk * 1.4);
      lp.frequency.setTargetAtTime(s.padCut * 0.4, t + dur * 0.6, dur * 0.3);
    }
  }

  bass(t, root) {
    const e = this.e, s = this.spec;
    const dur = s.bar * 0.85;
    const freq = mtof(root - 24);
    const o = e.osc('sine', freq);
    const o2 = e.osc('triangle', freq * 2.005);
    const g = e.gain(0);
    const lp = e.filter('lowpass', 220, 1.2);
    o.connect(lp);
    o2.connect(e.gain(0.18)).connect(lp);
    lp.connect(g).connect(this.out);
    o.start(t); o2.start(t);
    o.stop(t + dur + 0.3); o2.stop(t + dur + 0.3);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16 * s.bassLevel, t + 0.9);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.6, dur * 0.3);
  }

  /** Sparse bell / harp figure drawn from the mood's scale. */
  bellFigure(t, root, chord) {
    const e = this.e, s = this.spec;
    const notes = 2 + Math.floor(Math.random() * 4);
    const octave = pick([12, 24, 24, 36]);

    for (let i = 0; i < notes; i++) {
      const st = t + rand(0.2, s.bar * 0.7) + i * rand(0.35, 1.1);
      const deg = pick(s.scale);
      const freq = mtof(root + octave + deg);

      const o = e.osc('triangle', freq);
      const mod = e.osc('sine', freq * 2.76);
      const modG = e.gain(freq * 0.9);
      mod.connect(modG).connect(o.frequency);

      const g = e.gain(0);
      const lp = e.filter('lowpass', 4200, 0.8);
      const pan = e.panner();
      pan.pan.value = rand(-0.75, 0.75);
      o.connect(lp).connect(g).connect(pan).connect(this.out);

      const amp = rand(0.035, 0.075);
      const dec = rand(1.4, 3.4);
      g.gain.setValueAtTime(0, st);
      g.gain.linearRampToValueAtTime(amp, st + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0002, st + dec);
      modG.gain.setValueAtTime(freq * 0.9, st);
      modG.gain.exponentialRampToValueAtTime(freq * 0.02, st + 0.5);

      o.start(st); mod.start(st);
      o.stop(st + dec + 0.1); mod.stop(st + dec + 0.1);
    }
  }

  /** High sine drone that fades in and out across a bar. */
  shimmer(t, note) {
    const e = this.e, s = this.spec;
    const freq = mtof(note + pick(s.scale));
    const o = e.osc('sine', freq);
    const g = e.gain(0);
    const pan = e.panner();
    pan.pan.value = rand(-0.9, 0.9);
    o.connect(g).connect(pan).connect(this.out);
    const dur = s.bar * rand(0.5, 0.9);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(rand(0.012, 0.03), t + dur * 0.45);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.1);
  }

  /** Half-time, brushed, deliberately unobtrusive — this is a park, not a race. */
  drumBar(t) {
    const e = this.e, s = this.spec;
    const beat = s.bar / 8;
    for (let i = 0; i < 8; i++) {
      const st = t + i * beat;
      if (i % 4 === 0) this.kick(st);
      if (i % 4 === 2) this.snare(st);
      if (i % 2 === 1 && Math.random() < 0.8) this.hat(st, 0.5);
      if (Math.random() < 0.18) this.hat(st + beat * 0.5, 0.28);
    }
  }

  kick(t) {
    const e = this.e;
    const o = e.osc('sine', 120);
    const g = e.gain(0);
    o.connect(g).connect(this.out);
    o.frequency.setValueAtTime(115, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.09);
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.3);
    o.start(t); o.stop(t + 0.35);
  }

  snare(t) {
    const e = this.e;
    const src = e.noiseSource('white');
    const f = e.filter('bandpass', 1900, 1.2);
    const g = e.gain(0.09);
    src.connect(f).connect(g).connect(this.out);
    src.start(t);
    g.gain.exponentialRampToValueAtTime(0.0004, t + 0.16);
    src.stop(t + 0.22);
  }

  hat(t, amp) {
    const e = this.e;
    const src = e.noiseSource('white');
    const f = e.filter('highpass', 7200, 1.1);
    const g = e.gain(0.035 * amp);
    src.connect(f).connect(g).connect(this.out);
    src.start(t);
    g.gain.exponentialRampToValueAtTime(0.0003, t + 0.05);
    src.stop(t + 0.09);
  }
}
