// The mountain catalog. Every field here is an input to the procedural terrain
// builder in terrain.js — no map is hand-modelled, but each one is pinned to a
// seed so a given run always regenerates identically.
//
// Coordinate convention: the fall line runs along +Z. Origin is the summit,
// z = length is the base. X is across the hill.
//
// `pitch` is a gradient profile down the run: t is 0 at the summit, 1 at the
// base, g is rise/run (0.3 ≈ 17°, 0.7 ≈ 35°, 1.0 = 45°). Interpolating between
// these is what gives a run its character — headwalls, benches, runouts.

// `chip` is the colour a symbol sits *on*, for ratings that are a shape on a
// field rather than a bare shape. Only advanced intermediate needs one: it is
// a black diamond inside a blue square, and it is neither a blue square nor a
// black diamond — it sits between them, which is the whole point of it.
export const DIFFICULTY = {
  green:  { label: 'Green Circle',  symbol: '●', color: '#3fa34d', order: 0 },
  blue:   { label: 'Blue Square',   symbol: '■', color: '#3b82c4', order: 1 },
  advint: { label: 'Advanced Intermediate', symbol: '◈', color: '#12141a', chip: '#3b82c4', order: 2 },
  black:  { label: 'Black Diamond', symbol: '◆', color: '#1b1b1f', order: 3 },
  dblack: { label: 'Double Black',  symbol: '◆◆', color: '#1b1b1f', order: 4 },
  // Not a rating any resort issues. Reserved for faces steeper than anything
  // that gets patrolled, where the pitch by itself is the hazard.
  tblack: { label: 'Triple Black',  symbol: '◆◆◆', color: '#1b1b1f', order: 5 },
  park:   { label: 'Terrain Park',  symbol: '▲', color: '#c9761e', order: 6 },
  back:   { label: 'Backcountry',   symbol: '✦', color: '#6b5ea8', order: 7 },
};

/** Difficulties whose symbol needs a light chip to stay legible. */
export const DARK_DIFFICULTY = new Set(['black', 'dblack', 'tblack']);

/**
 * Foreground and background for a difficulty chip.
 *
 * Three cases: a rating carrying its own field colour uses it; a dark symbol
 * inverts to stay legible; everything else is its own colour on a neutral
 * tint. Centralised because the menu, the HUD and the trail signs all draw
 * the same chip and had drifted into three copies of the same conditional.
 */
export function difficultyChip(key) {
  const d = DIFFICULTY[key] ?? DIFFICULTY.blue;
  if (d.chip) return { fg: d.color, bg: d.chip };
  if (DARK_DIFFICULTY.has(key)) return { fg: '#eef2f7', bg: 'rgba(10,12,16,0.9)' };
  return { fg: d.color, bg: 'rgba(255,255,255,0.14)' };
}

export const CATEGORIES = [
  { id: 'resort',     name: 'Ski Resorts',     blurb: 'Full mountains. Multiple trails, lifts, a lodge at the base.' },
  { id: 'groomer',    name: 'Groomed Trails',  blurb: 'Single runs, corduroy, cruising.' },
  { id: 'steep',      name: 'Steeps & Chutes', blurb: 'Black diamond and worse. Trees, rocks, no-fall zones.' },
  { id: 'park',       name: 'Terrain Parks',   blurb: 'Jumps, rails, hips, and a halfpipe.' },
  { id: 'wild',       name: 'Backcountry',     blurb: 'Unpatrolled. Deep snow, big country, nobody around.' },
];

/** Smoothstep-interpolated gradient at normalised distance `t` down a run. */
export function gradientAt(pitch, t) {
  if (t <= pitch[0].t) return pitch[0].g;
  for (let i = 1; i < pitch.length; i++) {
    if (t <= pitch[i].t) {
      const a = pitch[i - 1], b = pitch[i];
      const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return a.g + (b.g - a.g) * (f * f * (3 - 2 * f));
    }
  }
  return pitch[pitch.length - 1].g;
}

/**
 * Vertical drop implied by a pitch profile.
 *
 * The pitch profile is the authoritative description of a run — it's what
 * decides how the thing actually skis. Vertical is a *consequence* of pitch
 * and length, so it's integrated here rather than authored. (Authoring both
 * and rescaling one to match the other quietly flattens every map whose
 * numbers don't already agree.)
 */
function deriveDrop(pitch, length) {
  const steps = 2048;
  let sum = 0;
  for (let i = 0; i < steps; i++) sum += gradientAt(pitch, (i + 0.5) / steps);
  return Math.round(((sum / steps) * length) / 10) * 10;
}

const M = (def) => withDrop({
  // defaults
  category: 'groomer',
  difficulty: 'blue',
  width: 900,
  length: 2600,
  pitch: [{ t: 0, g: 0.3 }, { t: 1, g: 0.3 }],
  wander: 1,
  relief: { scale: 420, amp: 26, octaves: 4 },
  moguls: { amount: 0, wavelength: 17 },
  trails: { count: 1, width: 62, groom: 1 },
  trees: { density: 0.45, kinds: ['pine'], line: 0.9, glade: 0 },
  rocks: 0.25,
  cliffs: 0,
  weather: 'bluebird',
  bots: 14,
  features: {},
  boundsRise: 1,
  horizon: 1,      // skyline height: 1 is alpine, lower is rolling country
  fan: 1,          // how high up the mountain trails split apart
  baseAltitude: 0, // real-world elevation of the base, for the HUD readout
  ...def,
});

function withDrop(spec) {
  spec.drop = deriveDrop(spec.pitch, spec.length);
  return spec;
}

export const MAPS = [
  // ─────────────────────────── Resorts ───────────────────────────
  M({
    id: 'alpenglow',
    name: 'Alpenglow Resort',
    category: 'resort',
    difficulty: 'blue',
    blurb: 'The flagship. Six trails off one summit, two chairs, and a lodge you can hear from the midstation.',
    seed: 10471,
    width: 2000, length: 3400,
    pitch: [{ t: 0, g: 0.42 }, { t: 0.25, g: 0.3 }, { t: 0.5, g: 0.38 }, { t: 0.8, g: 0.26 }, { t: 1, g: 0.1 }],
    relief: { scale: 520, amp: 40, octaves: 5 },
    trails: { count: 6, width: 78, groom: 1 },
    trees: { density: 0.6, kinds: ['pine', 'fir'], line: 0.88, glade: 0.15 },
    moguls: { amount: 0.18, wavelength: 18 },
    weather: 'bluebird',
    bots: 34,
    features: { lifts: 2, lodge: true, gates: true, midstation: true },
  }),
  M({
    id: 'cedar-hollow',
    name: 'Cedar Hollow',
    category: 'resort',
    difficulty: 'green',
    blurb: 'A gentle family hill in a wide valley. Wide trails, slow zones, and a lot of first-timers.',
    seed: 22318,
    width: 1700, length: 2800,
    pitch: [{ t: 0, g: 0.22 }, { t: 0.4, g: 0.17 }, { t: 0.7, g: 0.24 }, { t: 1, g: 0.08 }],
    relief: { scale: 480, amp: 22, octaves: 4 },
    trails: { count: 5, width: 105, groom: 1 },
    trees: { density: 0.5, kinds: ['cedar', 'pine'], line: 0.95, glade: 0.05 },
    rocks: 0.08,
    weather: 'overcast',
    bots: 42,
    features: { lifts: 2, lodge: true, gates: true, tubing: 8 },
  }),
  M({
    id: 'vermillion',
    name: 'Vermillion Peaks',
    category: 'resort',
    difficulty: 'black',
    blurb: 'Big, mean, and above treeline for the top third. The upper mountain is all fall line.',
    seed: 30991,
    width: 2200, length: 3800,
    pitch: [{ t: 0, g: 0.66 }, { t: 0.2, g: 0.54 }, { t: 0.45, g: 0.62 }, { t: 0.75, g: 0.38 }, { t: 1, g: 0.15 }],
    relief: { scale: 600, amp: 62, octaves: 5 },
    trails: { count: 6, width: 66, groom: 0.75 },
    trees: { density: 0.55, kinds: ['fir', 'pine'], line: 0.62, glade: 0.3 },
    moguls: { amount: 0.42, wavelength: 15 },
    rocks: 0.5, cliffs: 0.35,
    weather: 'alpine',
    bots: 26,
    features: { lifts: 2, lodge: true, gates: true, midstation: true },
  }),
  M({
    id: 'nordkette',
    name: 'Nordkette Basin',
    category: 'resort',
    difficulty: 'blue',
    blurb: 'A north-facing bowl that holds snow all season. Trails fan out from a single ridge.',
    seed: 41200,
    width: 2100, length: 3000,
    pitch: [{ t: 0, g: 0.5 }, { t: 0.3, g: 0.34 }, { t: 0.6, g: 0.4 }, { t: 1, g: 0.14 }],
    relief: { scale: 700, amp: 70, octaves: 5 },
    trails: { count: 5, width: 84, groom: 0.9 },
    trees: { density: 0.4, kinds: ['fir'], line: 0.7, glade: 0.2 },
    moguls: { amount: 0.22, wavelength: 19 },
    rocks: 0.35,
    weather: 'flurries',
    bots: 28,
    features: { lifts: 2, lodge: true, gates: true },
  }),
  M({
    id: 'whitecap',
    name: 'Whitecap Village',
    category: 'resort',
    difficulty: 'green',
    blurb: 'Low-angle rollers above a village base. The easiest top-to-bottom on the list.',
    seed: 50733,
    width: 1600, length: 3000,
    pitch: [{ t: 0, g: 0.2 }, { t: 0.3, g: 0.26 }, { t: 0.55, g: 0.14 }, { t: 0.8, g: 0.22 }, { t: 1, g: 0.06 }],
    relief: { scale: 380, amp: 26, octaves: 4 },
    trails: { count: 4, width: 115, groom: 1 },
    trees: { density: 0.55, kinds: ['pine', 'cedar'], line: 0.96, glade: 0 },
    rocks: 0.05,
    weather: 'bluebird',
    bots: 40,
    features: { lifts: 2, lodge: true, gates: true, village: true, tubing: 6 },
  }),
  M({
    id: 'summit-lakes',
    name: 'Summit Lakes',
    category: 'resort',
    difficulty: 'blue',
    blurb: 'Long rolling intermediate terrain with frozen lakes in the flats between pitches.',
    seed: 61845,
    width: 1900, length: 3600,
    pitch: [{ t: 0, g: 0.34 }, { t: 0.2, g: 0.12 }, { t: 0.4, g: 0.44 }, { t: 0.6, g: 0.1 }, { t: 0.8, g: 0.36 }, { t: 1, g: 0.08 }],
    relief: { scale: 540, amp: 34, octaves: 4 },
    trails: { count: 5, width: 88, groom: 1 },
    trees: { density: 0.5, kinds: ['pine', 'fir'], line: 0.92, glade: 0.1 },
    weather: 'dusk',
    bots: 30,
    features: { lifts: 2, lodge: true, gates: true, lakes: true },
  }),

  M({
    id: 'perfect-north',
    name: 'Perfect North',
    category: 'resort',
    difficulty: 'blue',
    blurb: 'A 400-foot hill in southern Indiana that skis far bigger than it reads. All snowmaking, lit until ten, and absolutely packed.',
    seed: 74025,
    // Built from the hill's own trail map rather than invented. The runs, the
    // ratings, the five chairs by colour, both parks, the race lane and the
    // tubing hill are all what the map shows, in the order the map shows them.
    //
    // What a trail map can't give is metres: it's an oblique painted panorama,
    // so every lateral position here is proportional to the drawing, not
    // surveyed. Run order and grouping are right; exact spacing is a reading.
    //
    // The real hill: 400 ft of vertical over about 100 acres, night skiing,
    // 100% snowmaking. Small numbers everywhere — the design problem is making
    // a short, gentle hill still feel worth skiing, which it does through
    // width, traffic, and a lot of lift infrastructure.
    //
    // A broad face, wider than it is deep, which is what the trail map shows,
    // and what makes the runs work. Spreading 400 ft of vertical over 1300 m
    // of run would give a 6° hill no per-run tweak can rescue; the real runs
    // are short and steep, ~15° up top flattening to nothing at the base.
    width: 1300, length: 550,
    pitch: [
      { t: 0, g: 0.06 }, { t: 0.18, g: 0.36 }, { t: 0.5, g: 0.28 },
      { t: 0.75, g: 0.14 }, { t: 0.93, g: 0.05 }, { t: 1, g: 0.012 },
    ],
    // Low relief on purpose. At amp 14 the noise gradient exceeded the base
    // pitch and produced counter-slopes you'd coast to a stop on — which a
    // graded, fully snowmade hill simply doesn't have.
    relief: { scale: 380, amp: 7, octaves: 4 },
    // The trail map, run for run, left to right across the face. Difficulties
    // are the hill's own ratings, including the advanced-intermediate tier the
    // map draws as a diamond inside a square. `steep` is scaled from the
    // published slope angles (4.4° on Rehearsal to 24.8° on Hollywood), which
    // is what makes a black actually ski like a black next to a green here.
    trails: {
      width: 46, groom: 1,
      runs: [
        // ── the face, summit to base
        { name: 'Backstage',           diff: 'blue',   x: -0.93, xBase: -0.97, steep: 0.72 },
        { name: 'Tuff Enuff',          diff: 'blue',   x: -0.80, xBase: -0.85, steep: 1.30 },
        { name: 'Hollywood',           diff: 'black',  x: -0.66, xBase: -0.72, steep: 1.62 },
        { name: 'Center Stage',        diff: 'black',  x: -0.54, xBase: -0.58, steep: 1.56 },
        // A connector, not a run: it leaves the top of the face and traverses
        // right to the head of the White Chair, losing very little on the way.
        { name: 'Hoyt Connection',     diff: 'blue',   x: -0.44, xBase: -0.20, top: 0.02, bottom: 0.42, steep: 0.40 },
        { name: "Clyde's Super Slide", diff: 'blue',   x: -0.31, xBase: -0.36, steep: 1.02 },
        { name: 'Deception',           diff: 'black',  x: -0.19, xBase: -0.22, steep: 1.50 },
        // Showtime hands over to Lower Showtime at the bench, as on the map.
        { name: 'Showtime',            diff: 'black',  x: -0.06, xBase:  0.02, bottom: 0.46, steep: 1.46 },
        { name: 'Lower Showtime',      diff: 'black',  x:  0.02, xBase:  0.10, top: 0.46, steep: 1.10 },
        { name: 'Encore',              diff: 'black',  x:  0.14, xBase:  0.16, steep: 1.44 },
        { name: 'Runway',              diff: 'advint', x:  0.27, xBase:  0.29, steep: 0.90 },
        { name: 'Intermission',        diff: 'advint', x:  0.40, xBase:  0.43, steep: 1.36 },
        { name: 'Special Effects',     diff: 'advint', x:  0.53, xBase:  0.57, steep: 1.30 },
        { name: 'The Far Side',        diff: 'blue',   x:  0.72, xBase:  0.78, steep: 0.74 },

        // ── lower mountain, from the bench down
        { name: 'The Meadow',          diff: 'blue',   x: -0.10, xBase: -0.06, top: 0.30, steep: 0.94, width: 76 },
        { name: 'Cat Walk',            diff: 'green',  x:  0.06, xBase:  0.02, top: 0.60, steep: 0.55 },
        { name: 'Ski Wiz',             diff: 'blue',   x:  0.24, xBase:  0.22, top: 0.54, steep: 0.75 },
        { name: 'Rehearsal',           diff: 'green',  x:  0.31, xBase:  0.30, top: 0.70, steep: 0.50 },
        { name: 'Call Back',           diff: 'green',  x:  0.43, xBase:  0.40, top: 0.72, steep: 0.55 },
        { name: 'Broadway',            diff: 'green',  x:  0.56, xBase:  0.50, top: 0.56, steep: 0.62 },
      ],
    },
    // Bare winter hardwoods with conifers mixed through them, which is what
    // the map draws and what southern Indiana actually has.
    trees: { density: 1.3, kinds: ['bare', 'fir'], line: 1, glade: 0 },
    moguls: { amount: 0.12, wavelength: 16 },
    rocks: 0.02,
    // Runs 60 m apart can't meander 20 m each and stay separate runs.
    wander: 0.5,
    weather: 'nightresort',
    horizon: 0.08,   // Ohio River valley: wooded ridges, not the Rockies
    bots: 130,       // by a wide margin the busiest hill in the game, which is
    botsMin: 105,    // the single most accurate thing about it
    features: {
      lodge: true, gates: true, floodlights: true,
      hub: 5,          // five connected wings, as the trail map shows
      // The five chairs by name, in the map's order across the face. x here is
      // a fraction of the half-width — base-area space, not the narrower band
      // the runs are laid out in — so each lane threads the gap between two
      // runs rather than sitting on one.
      lifts: [
        { name: 'Red Chair',    x: -0.46 },
        { name: 'White Chair',  x: -0.31 },
        { name: 'Blue Chair',   x: -0.16 },
        { name: 'Orange Chair', x:  0.02 },
        { name: 'Green Chair',  x:  0.21 },
        // The beginner hill is served by surface lifts, as it is in life.
        { name: 'Jam Session Tow', x: -0.88, top: 0.78, bottom: 0.96, kind: 'tow' },
        { name: 'Beginner Carpet', x: -0.79, top: 0.82, bottom: 0.96, kind: 'carpet' },
      ],
      // Two parks, which is two objects and not one park at two sizes:
      // Audition out on the face, Jam Session down on the learning area.
      park: [
        { x: -0.30, t0: 0.42, t1: 0.80, jumps: 3, rails: 5, hips: 1, seed: 0x11 },
        { x: -0.80, t0: 0.70, t1: 0.92, jumps: 2, rails: 3, seed: 0x22 },
      ],
      // The real hill runs 25 tubing lanes; a dozen reads the same. On the map
      // it sits off on the far skier's right, nowhere near the beginner hill.
      tubing: 12,
      base: { x: -0.24, learnX: -0.86, lotX: 0.40, tubingX: 0.80 },
      // Race training, fenced off between Special Effects and The Far Side.
      race: { x: 0.40, t0: 0.40, t1: 0.72, gates: 20 },
      // 100% snowmaking: even the margins are firm. Anywhere near powder
      // depth here and a 6° pitch can't overcome the friction, so drifting a
      // few metres off the corduroy would bring you to a dead stop.
      deep: 0.12,
    },
  }),

  // ──────────────────────── Groomed trails ────────────────────────
  M({
    id: 'bunny-meadow',
    name: 'Bunny Meadow',
    category: 'groomer',
    difficulty: 'green',
    blurb: 'Barely a hill. Good for learning what the edges do.',
    seed: 70112,
    width: 700, length: 1400,
    pitch: [{ t: 0, g: 0.14 }, { t: 0.6, g: 0.18 }, { t: 1, g: 0.05 }],
    relief: { scale: 300, amp: 8, octaves: 3 },
    trails: { count: 1, width: 200, groom: 1 },
    trees: { density: 0.3, kinds: ['pine'], line: 1, glade: 0 },
    rocks: 0.02, wander: 0.3,
    weather: 'bluebird',
    bots: 22,
    features: { lifts: 1, gates: true },
  }),
  M({
    id: 'sunrise-cruiser',
    name: 'Sunrise Cruiser',
    category: 'groomer',
    difficulty: 'green',
    blurb: 'East-facing corduroy at first light. Wide, consistent, empty.',
    seed: 71430,
    width: 900, length: 2800,
    pitch: [{ t: 0, g: 0.24 }, { t: 0.5, g: 0.2 }, { t: 1, g: 0.16 }],
    trails: { count: 1, width: 130, groom: 1 },
    trees: { density: 0.5, kinds: ['pine'], line: 0.95, glade: 0 },
    rocks: 0.06,
    weather: 'sunrise',
    bots: 10,
  }),
  M({
    id: 'larch-lane',
    name: 'Larch Lane',
    category: 'groomer',
    difficulty: 'green',
    blurb: 'A winding cat track through golden larch. More turning than descending.',
    seed: 72658,
    width: 1100, length: 3000,
    pitch: [{ t: 0, g: 0.18 }, { t: 1, g: 0.16 }],
    trails: { count: 1, width: 46, groom: 1 },
    trees: { density: 0.85, kinds: ['larch', 'pine'], line: 0.98, glade: 0 },
    wander: 2.6, rocks: 0.1,
    weather: 'goldenhour',
    bots: 12,
  }),
  M({
    id: 'blue-ribbon',
    name: 'Blue Ribbon',
    category: 'groomer',
    difficulty: 'blue',
    blurb: 'The benchmark intermediate. Steady 22 degrees, top to bottom, no surprises.',
    seed: 73901,
    width: 850, length: 3000,
    pitch: [{ t: 0, g: 0.4 }, { t: 1, g: 0.38 }],
    trails: { count: 1, width: 96, groom: 1 },
    trees: { density: 0.6, kinds: ['fir', 'pine'], line: 0.9, glade: 0 },
    moguls: { amount: 0.1, wavelength: 18 },
    weather: 'bluebird',
    bots: 18,
  }),
  M({
    id: 'marmot-traverse',
    name: 'Marmot Traverse',
    category: 'groomer',
    difficulty: 'blue',
    blurb: 'A high traverse that cuts across three drainages before dropping into the trees.',
    seed: 74277,
    width: 1600, length: 3200,
    pitch: [{ t: 0, g: 0.3 }, { t: 0.35, g: 0.18 }, { t: 0.6, g: 0.46 }, { t: 1, g: 0.28 }],
    relief: { scale: 620, amp: 58, octaves: 5 },
    trails: { count: 2, width: 70, groom: 0.95 },
    trees: { density: 0.5, kinds: ['fir'], line: 0.8, glade: 0.1 },
    wander: 3.2, rocks: 0.3,
    weather: 'alpine',
    bots: 16,
  }),
  M({
    id: 'cathedral-bowl',
    name: 'Cathedral Bowl',
    category: 'groomer',
    difficulty: 'blue',
    blurb: 'An enormous open bowl. Pick any line you want down the middle of it.',
    seed: 75514,
    width: 1800, length: 2600,
    pitch: [{ t: 0, g: 0.48 }, { t: 0.4, g: 0.42 }, { t: 0.8, g: 0.3 }, { t: 1, g: 0.12 }],
    relief: { scale: 900, amp: 90, octaves: 4 },
    trails: { count: 1, width: 560, groom: 0.6 },
    trees: { density: 0.35, kinds: ['fir'], line: 0.55, glade: 0.05 },
    moguls: { amount: 0.16, wavelength: 22 },
    rocks: 0.4,
    weather: 'alpine',
    bots: 20,
  }),
  M({
    id: 'silver-creek',
    name: 'Silver Creek',
    category: 'groomer',
    difficulty: 'blue',
    blurb: 'Follows a creek drainage. Banked walls on both sides the whole way down.',
    seed: 76680,
    width: 1000, length: 3200,
    pitch: [{ t: 0, g: 0.36 }, { t: 0.5, g: 0.42 }, { t: 1, g: 0.24 }],
    relief: { scale: 300, amp: 44, octaves: 5 },
    trails: { count: 1, width: 74, groom: 0.9 },
    trees: { density: 0.75, kinds: ['cedar', 'fir'], line: 0.92, glade: 0.08 },
    wander: 2.2, rocks: 0.3,
    weather: 'flurries',
    bots: 15,
  }),

  // ────────────────────── Steeps & chutes ──────────────────────
  M({
    id: 'devils-spine',
    name: "Devil's Spine",
    category: 'steep',
    difficulty: 'black',
    blurb: 'A rock spine with a skiable ribbon on top. Fall either side and you are going a long way.',
    seed: 80119,
    width: 900, length: 2400,
    pitch: [{ t: 0, g: 0.78 }, { t: 0.4, g: 0.7 }, { t: 0.75, g: 0.62 }, { t: 1, g: 0.24 }],
    relief: { scale: 260, amp: 52, octaves: 5 },
    trails: { count: 1, width: 40, groom: 0.25 },
    trees: { density: 0.5, kinds: ['fir'], line: 0.6, glade: 0.35 },
    moguls: { amount: 0.5, wavelength: 13 },
    rocks: 0.75, cliffs: 0.6,
    weather: 'alpine',
    bots: 8,
  }),
  M({
    id: 'corkscrew',
    name: 'Corkscrew Couloir',
    category: 'steep',
    difficulty: 'black',
    blurb: 'A narrow slot that turns four times. You cannot see the exit from the entrance.',
    seed: 81447,
    width: 1000, length: 2000,
    pitch: [{ t: 0, g: 0.86 }, { t: 0.5, g: 0.74 }, { t: 0.85, g: 0.58 }, { t: 1, g: 0.2 }],
    relief: { scale: 220, amp: 40, octaves: 5 },
    trails: { count: 1, width: 38, groom: 0.2 },
    trees: { density: 0.25, kinds: ['fir'], line: 0.5, glade: 0.1 },
    moguls: { amount: 0.35, wavelength: 12 },
    wander: 4.5, rocks: 0.9, cliffs: 0.8, boundsRise: 2.6,
    weather: 'alpine',
    bots: 5,
  }),
  M({
    id: 'widowmaker',
    name: 'Widowmaker',
    category: 'steep',
    difficulty: 'black',
    blurb: 'Old growth, tight spacing, and a pitch that never lets up. Pure tree skiing.',
    seed: 82903,
    width: 1100, length: 2600,
    pitch: [{ t: 0, g: 0.68 }, { t: 0.5, g: 0.66 }, { t: 1, g: 0.4 }],
    relief: { scale: 340, amp: 40, octaves: 5 },
    trails: { count: 1, width: 240, groom: 0.15 },
    trees: { density: 1.35, kinds: ['fir', 'cedar'], line: 0.98, glade: 0.9 },
    moguls: { amount: 0.4, wavelength: 14 },
    rocks: 0.45,
    weather: 'flurries',
    bots: 9,
  }),
  M({
    id: 'ravens-drop',
    name: "Raven's Drop",
    category: 'steep',
    difficulty: 'black',
    blurb: 'Starts with a cornice and ends in a mogul field the size of a parking lot.',
    seed: 83366,
    width: 1000, length: 2400,
    pitch: [{ t: 0, g: 0.9 }, { t: 0.15, g: 0.6 }, { t: 0.5, g: 0.58 }, { t: 1, g: 0.3 }],
    relief: { scale: 300, amp: 36, octaves: 5 },
    trails: { count: 1, width: 150, groom: 0.3 },
    trees: { density: 0.6, kinds: ['fir'], line: 0.75, glade: 0.4 },
    moguls: { amount: 0.85, wavelength: 13 },
    rocks: 0.5, cliffs: 0.3,
    weather: 'overcast',
    bots: 11,
  }),
  M({
    id: 'the-fang',
    name: 'The Fang',
    category: 'steep',
    difficulty: 'dblack',
    blurb: 'An open hanging snowfield that closes to a slot you could touch both walls of. It gets narrower the whole way down, and you get faster.',
    seed: 84512,
    // Named for its shape, and now actually that shape: a wide root at the
    // top tapering to a point. The run gets harder exactly as you get faster,
    // which is the whole idea — the crux is at the bottom, not the entrance,
    // so there is nowhere to stop and reconsider once you're committed.
    width: 1100, length: 2100,
    pitch: [
      { t: 0, g: 0.62 }, { t: 0.12, g: 0.78 }, { t: 0.42, g: 0.9 },
      { t: 0.68, g: 1.05 }, { t: 0.82, g: 0.7 }, { t: 1, g: 0.2 },
    ],
    relief: { scale: 300, amp: 40, octaves: 5 },
    trails: {
      count: 1, width: 130, groom: 0.12,
      widthProfile: [
        { t: 0, w: 170 },      // hanging snowfield, room to make turns
        { t: 0.3, w: 96 },
        { t: 0.55, w: 40 },
        { t: 0.74, w: 15 },    // the throat
        { t: 0.86, w: 26 },
        { t: 1, w: 150 },      // apron
      ],
    },
    trees: { density: 0.12, kinds: ['fir'], line: 0.4, glade: 0.1 },
    moguls: { amount: 0.22, wavelength: 12 },
    wander: 0.8, rocks: 0.9, cliffs: 0.85, boundsRise: 2.4,
    weather: 'storm',
    bots: 3,
    features: { spires: true },
  }),
  M({
    id: 'obsidian-chute',
    name: 'Obsidian Chute',
    category: 'steep',
    difficulty: 'dblack',
    blurb: 'Volcanic rock, black sand under thin snow, and a chute that funnels into an apron.',
    seed: 85780,
    width: 1200, length: 2200,
    pitch: [{ t: 0, g: 1.0 }, { t: 0.35, g: 0.88 }, { t: 0.7, g: 0.6 }, { t: 1, g: 0.22 }],
    relief: { scale: 240, amp: 56, octaves: 5 },
    trails: { count: 1, width: 42, groom: 0.1 },
    trees: { density: 0.1, kinds: ['fir'], line: 0.35, glade: 0 },
    moguls: { amount: 0.25, wavelength: 12 },
    wander: 2.8, rocks: 1.2, cliffs: 0.95, boundsRise: 2.8,
    weather: 'ashfall',
    bots: 4,
  }),
  M({
    id: 'cornice-run',
    name: 'Cornice Run',
    category: 'steep',
    difficulty: 'dblack',
    blurb: 'A wind-loaded ridge with a mandatory air off the lip, then 700 metres of open steep.',
    seed: 86094,
    width: 1400, length: 2400,
    pitch: [{ t: 0, g: 0.3 }, { t: 0.1, g: 1.3 }, { t: 0.25, g: 0.8 }, { t: 0.6, g: 0.74 }, { t: 1, g: 0.26 }],
    relief: { scale: 420, amp: 74, octaves: 5 },
    trails: { count: 1, width: 300, groom: 0.15 },
    trees: { density: 0.25, kinds: ['fir'], line: 0.5, glade: 0.2 },
    moguls: { amount: 0.35, wavelength: 16 },
    rocks: 0.8, cliffs: 0.7,
    weather: 'alpine',
    bots: 6,
  }),

  // ──────────────────────── Terrain parks ────────────────────────
  M({
    id: 'frostbite-park',
    name: 'Frostbite Terrain Park',
    category: 'park',
    difficulty: 'park',
    blurb: 'Three jump lines, a hip, and a halfpipe at the bottom. Everything is built, nothing is natural.',
    seed: 90233,
    width: 800, length: 2400,
    pitch: [{ t: 0, g: 0.28 }, { t: 0.5, g: 0.26 }, { t: 1, g: 0.2 }],
    relief: { scale: 400, amp: 10, octaves: 3 },
    trails: { count: 1, width: 190, groom: 1 },
    trees: { density: 0.4, kinds: ['pine'], line: 0.95, glade: 0 },
    rocks: 0.02, wander: 0.4,
    weather: 'bluebird',
    bots: 20,
    features: { park: { jumps: 9, rails: 7, pipe: true, hips: 2 }, lifts: 1 },
  }),
  M({
    id: 'rail-yard',
    name: 'The Rail Yard',
    category: 'park',
    difficulty: 'park',
    blurb: 'Low angle, all metal. Boxes, kinks, down-flats, and a wall ride.',
    seed: 91560,
    width: 620, length: 1700,
    pitch: [{ t: 0, g: 0.2 }, { t: 1, g: 0.16 }],
    relief: { scale: 320, amp: 6, octaves: 3 },
    trails: { count: 1, width: 170, groom: 1 },
    trees: { density: 0.25, kinds: ['pine'], line: 1, glade: 0 },
    rocks: 0, wander: 0.2,
    weather: 'nightpark',
    bots: 16,
    features: { park: { jumps: 3, rails: 14, pipe: false, hips: 1 }, lifts: 1, floodlights: true },
  }),
  M({
    id: 'airbag-jumpline',
    name: 'Big Air Jumpline',
    category: 'park',
    difficulty: 'park',
    blurb: 'Four kickers in a row, each bigger than the last. The last one is 22 metres.',
    seed: 92814,
    width: 560, length: 2000,
    pitch: [{ t: 0, g: 0.34 }, { t: 0.5, g: 0.3 }, { t: 1, g: 0.24 }],
    relief: { scale: 400, amp: 6, octaves: 3 },
    trails: { count: 1, width: 150, groom: 1 },
    trees: { density: 0.35, kinds: ['fir'], line: 0.95, glade: 0 },
    rocks: 0, wander: 0.15,
    weather: 'goldenhour',
    bots: 12,
    features: { park: { jumps: 4, rails: 2, pipe: false, hips: 0, huge: true }, lifts: 1 },
  }),

  // ────────────────────────── Mount Everest ──────────────────────
  //
  // The whole descent in one terrain: the summit ridge to Base Camp, 3,497 m,
  // 6.6 km of run, and no seam anywhere in it. Filed with the steeps because
  // that is what it is — the last double black before the triple blacks.
  M({
    id: 'everest-full',
    name: 'Mount Everest',
    category: 'steep',
    difficulty: 'dblack',
    blurb: 'The whole mountain in one run. Off the summit ridge, over the Hillary Step, down the Lhotse Face, across the Western Cwm and through the Khumbu Icefall to Base Camp. Three and a half vertical kilometres without stopping.',
    seed: 88490,
    // One terrain for the lot. Ends on Base Camp at 5,364 m.
    baseAltitude: 5364,
    // 6.6 km of run in a single heightfield. The width is set by the widest
    // section (the Cwm) and the vertex budget is raised well above standard,
    // because at the default the cells come out at 8 m and a 15 m summit
    // ridge stops being a ridge at all.
    width: 1800, length: 6600,
    vertexBudget: 2.4,
    pitch: [
      // Nothing here drops below ~0.17. A near-flat bench is only skiable if
      // the snow under it is shallow enough, and one terrain has one depth
      // for all 6.6 km — at this one the Balcony and the South Col fell under
      // the gradient where friction beats gravity and stopped you dead.
      // ── the Southeast Ridge ─────────────────────────────
      { t: 0,     g: 0.28 },   // summit snow dome
      { t: 0.028, g: 0.94 },   // the Hillary Step
      { t: 0.05,  g: 0.20 },   // cornice traverse to the South Summit
      { t: 0.078, g: 0.84 },   // off the back of the South Summit
      { t: 0.137, g: 0.55 },
      { t: 0.18,  g: 0.19 },   // the Balcony, 8,400 m
      { t: 0.218, g: 0.91 },   // the Triangular Face
      { t: 0.274, g: 0.64 },
      { t: 0.31,  g: 0.18 },   // the South Col, 7,906 m
      // ── the Geneva Spur and the Lhotse Face ─────────────
      { t: 0.375, g: 0.72 },   // over the lip onto the Spur
      { t: 0.405, g: 0.21 },   // the traverse below it
      { t: 0.44,  g: 0.74 },   // the Yellow Band
      { t: 0.465, g: 0.90 },   // upper Lhotse Face
      { t: 0.51,  g: 0.34 },   // the Camp III ledges
      { t: 0.53,  g: 0.86 },   // lower Lhotse Face
      { t: 0.575, g: 0.36 },
      { t: 0.605, g: 0.22 },   // the bergschrund
      // ── the Western Cwm ─────────────────────────────────
      { t: 0.63,  g: 0.60 },
      { t: 0.68,  g: 0.43 },   // the Valley of Silence
      { t: 0.735, g: 0.36 },   // the crevasse field
      { t: 0.79,  g: 0.48 },
      { t: 0.82,  g: 0.36 },   // the bench above Camp I
      // ── the Khumbu Icefall ──────────────────────────────
      { t: 0.845, g: 0.41 },   // the lip
      { t: 0.88,  g: 1.03 },   // over the edge
      { t: 0.915, g: 0.48 },   // a shelf between the steps
      { t: 0.94,  g: 0.97 },   // the big broken middle
      { t: 0.962, g: 0.41 },
      { t: 0.978, g: 0.95 },   // the last steep step
      { t: 0.993, g: 0.50 },
      { t: 1,     g: 0.35 },   // out onto the moraine at Base Camp
    ],
    // Four skies, blended by height. The sun rises as you descend, which is
    // also what happens: you summit around dawn and reach Base Camp later.
    weather: 'deathzone',
    weatherStops: [
      { t: 0,    weather: 'deathzone' },
      { t: 0.34, weather: 'lhotse' },
      { t: 0.62, weather: 'cwm' },
      { t: 0.86, weather: 'khumbu' },
    ],
    relief: { scale: 340, amp: 46, octaves: 5 },
    trails: {
      count: 1, width: 120, groom: 0.07,
      widthProfile: [
        { t: 0,     w: 30 },   // summit ridge
        { t: 0.04,  w: 15 },   // the Hillary Step and the cornice traverse
        { t: 0.087, w: 26 },
        { t: 0.143, w: 52 },
        { t: 0.18,  w: 74 },   // the Balcony
        { t: 0.236, w: 170 },  // the Triangular Face
        { t: 0.31,  w: 430 },  // the South Col
        { t: 0.365, w: 150 },  // the Geneva Spur
        { t: 0.40,  w: 110 },
        { t: 0.44,  w: 130 },  // the Yellow Band
        { t: 0.50,  w: 330 },  // the Lhotse Face opens
        { t: 0.60,  w: 470 },
        { t: 0.70,  w: 620 },  // the Cwm floor
        { t: 0.80,  w: 520 },
        { t: 0.87,  w: 85 },   // into the Icefall
        { t: 0.93,  w: 58 },   // threading the towers
        { t: 0.97,  w: 210 },
        { t: 1,     w: 420 },  // Base Camp
      ],
    },
    trees: { density: 0, kinds: ['fir'], line: 0, glade: 0 },
    moguls: { amount: 0, wavelength: 20 },
    rocks: 0.95, cliffs: 0.8,
    wander: 1.5, boundsRise: 2.2,
    horizon: 1.6,
    bots: 8,
    features: {
      deep: 0.09,        // wind-scoured almost the whole way down
      spires: true,
      crevasses: { t0: 0.63, t1: 0.97 },   // the Cwm and the Icefall only
      seracs: 70,
      // The Lhotse Face and the Icefall are ice; the ridge and the Cwm are not.
      iceField: [
        { t0: 0.435, t1: 0.61, amount: 0.95 },
        { t0: 0.855, t1: 0.965, amount: 0.5 },
      ],
      rockBands: [{ t0: 0.425, t1: 0.452, color: 0xb8a05c, amount: 0.5 }],
      camp: { at: 0.985, tents: 30 },   // Base Camp
    },
  }),

  // ──────────────────────── Triple black ─────────────────────────
  M({
    id: 'lenzspitze',
    name: 'Lenzspitze — Nordostwand',
    category: 'steep',
    difficulty: 'tblack',
    blurb: "The north-east face, off Heitz's list. Fifty-five degrees, top to bottom, on wind-hammered ice. There is no corridor and no run-out — you hold the whole face or you don't, and the only thing at the bottom is the bergschrund.",
    seed: 42941,
    // 4,294 m to the Hohbalm glacier at ~3,210 m. A face, not a run: it is
    // barely longer than it is tall, which is what 50°+ actually means.
    baseAltitude: 3210,
    width: 1100, length: 950,
    pitch: [
      { t: 0,    g: 0.86 },   // the summit cornice
      { t: 0.1,  g: 1.34 },   // and straight into it
      { t: 0.46, g: 1.45 },   // 55°, sustained, the middle of the face
      { t: 0.74, g: 1.24 },
      { t: 0.9,  g: 0.66 },   // the bergschrund
      { t: 1,    g: 0.3 },    // the glacier below
    ],
    relief: { scale: 220, amp: 34, octaves: 5 },
    // Deliberately no corridor. The "trail" is the whole face; there is
    // nothing marked, nothing groomed and nothing to aim between.
    trails: {
      count: 1, width: 300, groom: 0.04,
      widthProfile: [
        { t: 0,   w: 190 },
        { t: 0.4, w: 340 },
        { t: 0.8, w: 300 },
        { t: 1,   w: 380 },
      ],
    },
    trees: { density: 0, kinds: ['fir'], line: 0, glade: 0 },
    moguls: { amount: 0, wavelength: 20 },
    rocks: 1.15, cliffs: 1.0,
    wander: 0.5, boundsRise: 2.6,
    weather: 'lhotse',   // a north face: shadowed, raking light, blue
    horizon: 1.3,
    bots: 1,             // one other person on the whole mountain
    features: {
      deep: 0.04,        // scoured to ice; nothing accumulates at this angle
      spires: true,
      iceField: [{ t0: 0.08, t1: 0.86, amount: 0.75 }],
    },
  }),

  M({
    id: 'the-gullet',
    name: 'The Gullet',
    category: 'steep',
    difficulty: 'tblack',
    blurb: 'A slot in a north wall, nine metres across at its widest, running fifty degrees for six hundred vertical metres. Both walls are within reach the entire way. You cannot traverse, you cannot stop, and you cannot see the exit until you are in it.',
    seed: 31788,
    width: 700, length: 1300,
    pitch: [
      { t: 0,    g: 0.5 },    // the entrance shelf, all of ten metres of it
      { t: 0.08, g: 1.28 },
      { t: 0.5,  g: 1.18 },   // fifty degrees, unbroken
      { t: 0.8,  g: 1.0 },
      { t: 0.92, g: 0.5 },
      { t: 1,    g: 0.24 },   // the apron
    ],
    relief: { scale: 170, amp: 26, octaves: 5 },
    trails: {
      count: 1, width: 14, groom: 0.06,
      widthProfile: [
        { t: 0,    w: 22 },
        { t: 0.12, w: 11 },
        { t: 0.55, w: 9 },    // both walls within reach
        { t: 0.85, w: 16 },
        { t: 1,    w: 120 },  // it finally lets go
      ],
    },
    trees: { density: 0, kinds: ['fir'], line: 0, glade: 0 },
    moguls: { amount: 0, wavelength: 20 },
    rocks: 1.2, cliffs: 1.0,
    // A nine-metre slot cannot also swing two hundred metres across the face
    // — at 2.2 the corridor snaked harder than anything could be held at
    // ninety km/h, and it was only ever passable by luck.
    wander: 0.9, boundsRise: 3.6,   // rock walls, not snow banks
    weather: 'storm',
    horizon: 1.2,
    bots: 0,                         // nobody else is in here
    features: {
      deep: 0.05,
      spires: true,
      iceField: [{ t0: 0.15, t1: 0.8, amount: 0.6 }],
      // No exposure here. That's for ridges, where the ground falls away and
      // there is nothing to stop you — this is a slot with rock walls on both
      // sides, and boundsRise already does the containing.
    },
  }),

  // ───────────────────────── Backcountry ─────────────────────────
  M({
    id: 'glacier-traverse',
    name: 'Glacier Traverse',
    category: 'wild',
    difficulty: 'back',
    blurb: 'Four kilometres of glacier. Crevasse fields, seracs, and no trees at all.',
    seed: 100482,
    width: 2600, length: 4600,
    pitch: [{ t: 0, g: 0.4 }, { t: 0.25, g: 0.2 }, { t: 0.5, g: 0.44 }, { t: 0.7, g: 0.18 }, { t: 1, g: 0.3 }],
    relief: { scale: 800, amp: 96, octaves: 5 },
    trails: { count: 1, width: 900, groom: 0.35 },
    trees: { density: 0, kinds: ['fir'], line: 0, glade: 0 },
    rocks: 0.6, cliffs: 0.4,
    weather: 'glacier',
    bots: 4,
    features: { crevasses: true, seracs: 24 },
  }),
  M({
    id: 'powder-basin',
    name: 'Powder Basin',
    category: 'wild',
    difficulty: 'back',
    blurb: 'A metre of untracked in a wide north bowl. Slow, deep, quiet.',
    seed: 101736,
    width: 2200, length: 3000,
    pitch: [{ t: 0, g: 0.5 }, { t: 0.5, g: 0.46 }, { t: 0.85, g: 0.32 }, { t: 1, g: 0.14 }],
    relief: { scale: 700, amp: 80, octaves: 5 },
    trails: { count: 1, width: 800, groom: 0.05 },
    trees: { density: 0.45, kinds: ['fir'], line: 0.7, glade: 0.6 },
    moguls: { amount: 0.05, wavelength: 26 },
    rocks: 0.35,
    weather: 'powderday',
    bots: 6,
    features: { deep: 1 },
  }),
  M({
    id: 'midnight-glades',
    name: 'Midnight Glades',
    category: 'wild',
    difficulty: 'back',
    blurb: 'Skiing trees by moonlight. You mostly hear where you are going.',
    seed: 102955,
    width: 1400, length: 2800,
    pitch: [{ t: 0, g: 0.46 }, { t: 0.5, g: 0.44 }, { t: 1, g: 0.26 }],
    relief: { scale: 380, amp: 44, octaves: 5 },
    trails: { count: 1, width: 400, groom: 0.1 },
    trees: { density: 1.1, kinds: ['fir', 'cedar'], line: 0.95, glade: 0.85 },
    moguls: { amount: 0.15, wavelength: 20 },
    rocks: 0.4,
    weather: 'moonlight',
    bots: 5,
  }),
  M({
    id: 'whiteout-ridge',
    name: 'Whiteout Ridge',
    category: 'wild',
    difficulty: 'back',
    blurb: 'Visibility about forty metres. The ridge is out there somewhere.',
    seed: 103118,
    width: 1800, length: 3000,
    pitch: [{ t: 0, g: 0.52 }, { t: 0.4, g: 0.4 }, { t: 0.8, g: 0.44 }, { t: 1, g: 0.2 }],
    relief: { scale: 560, amp: 72, octaves: 5 },
    trails: { count: 1, width: 700, groom: 0.2 },
    trees: { density: 0.3, kinds: ['fir'], line: 0.6, glade: 0.3 },
    moguls: { amount: 0.2, wavelength: 18 },
    rocks: 0.55,
    weather: 'whiteout',
    bots: 4,
  }),
  M({
    id: 'hanging-valley',
    name: 'Hanging Valley',
    category: 'wild',
    difficulty: 'back',
    blurb: 'A shelf above a big drop, reached by a traverse. Sun all afternoon.',
    seed: 104627,
    width: 2000, length: 3400,
    pitch: [{ t: 0, g: 0.36 }, { t: 0.2, g: 0.1 }, { t: 0.42, g: 0.92 }, { t: 0.6, g: 0.34 }, { t: 0.85, g: 0.5 }, { t: 1, g: 0.16 }],
    relief: { scale: 620, amp: 88, octaves: 5 },
    trails: { count: 1, width: 620, groom: 0.15 },
    trees: { density: 0.5, kinds: ['fir', 'larch'], line: 0.78, glade: 0.5 },
    rocks: 0.6, cliffs: 0.5,
    weather: 'goldenhour',
    bots: 5,
  }),
];

export const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));

export function mapsInCategory(cat) {
  return MAPS.filter((m) => m.category === cat);
}
