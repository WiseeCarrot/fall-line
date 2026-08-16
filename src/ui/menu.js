// All front-end screens: title, mountain select, settings, pause, loading.
// One root element, one visible screen at a time.

import { MAPS, CATEGORIES, DIFFICULTY, difficultyChip, mapsInCategory, gradientAt } from '../world/maps.js';
import { WEATHER } from '../world/sky.js';
import { clamp } from '../core/math.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const TIPS = [
  'Look where you want to go — the skis follow your eyes.',
  'Hold S to check your speed before a steep pitch, not during it.',
  'Tuck (W) on the flats. Stand up before you need to turn.',
  'Powder wants a wider, rounder turn than corduroy does.',
  'On ice, edge earlier and lighter. Grip you force is grip you lose.',
  'Press C to look around without changing where the skis point.',
  'Nothing here is timed. Take the long way down.',
  'Deep snow is the softest thing to land in.',
  'Trees are closer together than they look from the trail.',
  'Ride the rail out the end, or press Space to hop off early.',
];

export class Menu {
  constructor(root, opts) {
    this.root = root;
    this.opts = opts;
    this.settings = opts.settings;
    this.screen = null;
    this.selectedCategory = 'resort';
    this.build();
  }

  build() {
    this.root.innerHTML = '';
    this.backdrop = el('div', 'menu-backdrop');
    this.panel = el('div', 'menu-panel');
    this.root.append(this.backdrop, this.panel);
  }

  show(screen, data) {
    this.screen = screen;
    this.root.style.display = 'flex';
    this.root.dataset.screen = screen;
    this.panel.innerHTML = '';
    ({
      title: () => this.buildTitle(),
      maps: () => this.buildMaps(),
      settings: () => this.buildSettings(),
      pause: () => this.buildPause(),
      loading: () => this.buildLoading(data),
    }[screen] || (() => {}))();
  }

  hide() {
    this.screen = null;
    this.root.style.display = 'none';
  }

  click(fn) {
    return (e) => {
      e.preventDefault();
      this.opts.audio?.ui('click');
      fn(e);
    };
  }

  button(label, cls, fn) {
    const b = el('button', `btn ${cls || ''}`, label);
    b.addEventListener('click', this.click(fn));
    b.addEventListener('mouseenter', () => this.opts.audio?.ui('hover'));
    return b;
  }

  // ── title ───────────────────────────────────────────────────────
  buildTitle() {
    const wrap = el('div', 'screen screen-title');
    const brand = el('div', 'brand');
    brand.append(el('div', 'brand-mark', '⛰'));
    const t = el('div', 'brand-text');
    t.append(el('h1', null, 'FALL LINE'));
    t.append(el('p', 'tagline', `${MAPS.length} mountains. No clock, no gates, no finish line.`));
    brand.append(t);
    wrap.append(brand);

    const actions = el('div', 'title-actions');
    actions.append(this.button('Choose a mountain', 'primary', () => this.show('maps')));
    actions.append(this.button('Settings', 'ghost', () => this.show('settings')));
    wrap.append(actions);

    const facts = el('div', 'title-facts');
    for (const [k, v] of [
      ['Mountains', String(MAPS.length)],
      ['Vertical', `${(MAPS.reduce((a, m) => a + m.drop, 0) / 1000).toFixed(1)} km`],
      ['Audio', 'Fully synthesised'],
      ['View', 'First person'],
    ]) {
      const f = el('div', 'fact');
      f.append(el('div', 'fact-value', v));
      f.append(el('div', 'fact-label', k));
      facts.append(f);
    }
    wrap.append(facts);
    this.panel.append(wrap);
  }

  // ── mountain select ─────────────────────────────────────────────
  buildMaps() {
    const wrap = el('div', 'screen screen-maps');

    const head = el('div', 'screen-head');
    const back = this.button('‹ Back', 'icon', () => this.show('title'));
    head.append(back, el('h2', null, 'Choose a mountain'));
    wrap.append(head);

    const tabs = el('div', 'tabs');
    for (const cat of CATEGORIES) {
      const count = mapsInCategory(cat.id).length;
      const tab = el('button', 'tab' + (cat.id === this.selectedCategory ? ' active' : ''));
      tab.append(el('span', 'tab-name', cat.name));
      tab.append(el('span', 'tab-count', String(count)));
      tab.addEventListener('click', this.click(() => {
        this.selectedCategory = cat.id;
        this.show('maps');
      }));
      tab.addEventListener('mouseenter', () => this.opts.audio?.ui('hover'));
      tabs.append(tab);
    }
    wrap.append(tabs);

    const cat = CATEGORIES.find((c) => c.id === this.selectedCategory);
    wrap.append(el('p', 'cat-blurb', cat.blurb));

    const grid = el('div', 'map-grid');
    for (const spec of mapsInCategory(this.selectedCategory)) {
      grid.append(this.mapCard(spec));
    }
    wrap.append(grid);
    this.panel.append(wrap);
  }

  mapCard(spec) {
    const d = DIFFICULTY[spec.difficulty];
    const w = WEATHER[spec.weather];
    const card = el('button', 'map-card');

    const preview = document.createElement('canvas');
    preview.width = 320;
    preview.height = 96;
    preview.className = 'map-preview';
    drawProfile(preview, spec, w);
    card.append(preview);

    const body = el('div', 'card-body');
    const top = el('div', 'card-top');
    const chip = el('span', 'chip chip-diff', d.symbol);
    const { fg, bg } = difficultyChip(spec.difficulty);
    chip.style.color = fg;
    chip.style.background = bg;
    top.append(chip, el('h3', null, spec.name));
    body.append(top);
    body.append(el('p', 'card-blurb', spec.blurb));

    const meta = el('div', 'card-meta');
    meta.append(el('span', null, `${spec.drop} m vertical`));
    meta.append(el('span', null, `${(spec.length / 1000).toFixed(1)} km`));
    meta.append(el('span', null, w.name));
    meta.append(el('span', null, `${spec.bots} skiers`));
    body.append(meta);
    card.append(body);

    card.addEventListener('click', this.click(() => this.opts.onPlay(spec)));
    card.addEventListener('mouseenter', () => this.opts.audio?.ui('hover'));
    return card;
  }

  // ── settings ────────────────────────────────────────────────────
  buildSettings() {
    const wrap = el('div', 'screen screen-settings');
    const head = el('div', 'screen-head');
    head.append(
      this.button('‹ Back', 'icon', () => this.show(this.opts.inGame() ? 'pause' : 'title')),
      el('h2', null, 'Settings'),
    );
    wrap.append(head);

    const cols = el('div', 'settings-cols');

    const audioCol = el('div', 'settings-col');
    audioCol.append(el('h3', null, 'Audio'));
    audioCol.append(this.slider('Master', 'master', 0, 1, 0.01, (v) => this.opts.audio?.setVolume('master', v)));
    audioCol.append(this.slider('Effects', 'sfx', 0, 1, 0.01, (v) => this.opts.audio?.setVolume('sfx', v)));
    audioCol.append(this.slider('Ambience', 'ambient', 0, 1, 0.01, (v) => this.opts.audio?.setVolume('ambient', v)));
    audioCol.append(this.slider('Music', 'music', 0, 1, 0.01, (v) => this.opts.audio?.setVolume('music', v)));
    audioCol.append(this.toggle('Generative score', 'musicOn', (v) => this.opts.audio?.setMusicEnabled(v)));
    cols.append(audioCol);

    const ctrlCol = el('div', 'settings-col');
    ctrlCol.append(el('h3', null, 'Controls'));
    ctrlCol.append(this.slider('Mouse sensitivity', 'sensitivity', 0.4, 3, 0.05, (v) => this.opts.onSetting('sensitivity', v)));
    ctrlCol.append(this.toggle('Invert look', 'invertY', (v) => this.opts.onSetting('invertY', v)));
    ctrlCol.append(this.toggle('Show skis and poles', 'viewModel', (v) => this.opts.onSetting('viewModel', v)));
    ctrlCol.append(this.toggle('Show HUD', 'hud', (v) => this.opts.onSetting('hud', v)));
    ctrlCol.append(this.toggle('Skip lift rides', 'skipLifts', (v) => this.opts.onSetting('skipLifts', v)));
    ctrlCol.append(el('p', 'settings-note',
      'At a resort you start at the bottom. Skate over to a lift with W and press E to ride up — or skip straight to the top.'));
    cols.append(ctrlCol);

    const vidCol = el('div', 'settings-col');
    vidCol.append(el('h3', null, 'Graphics'));
    vidCol.append(this.choice('Detail', 'quality', [
      ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'],
    ], (v) => this.opts.onSetting('quality', v)));
    vidCol.append(this.toggle('Shadows', 'shadows', (v) => this.opts.onSetting('shadows', v)));
    vidCol.append(this.toggle('Snowfall', 'precip', (v) => this.opts.onSetting('precip', v)));
    vidCol.append(el('p', 'settings-note',
      'Detail changes how many trees, rocks and other skiers are placed. It takes effect the next time a mountain loads.'));
    cols.append(vidCol);

    wrap.append(cols);
    this.panel.append(wrap);
  }

  slider(label, key, min, max, step, onChange) {
    const row = el('label', 'setting-row');
    row.append(el('span', 'setting-label', label));
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min; input.max = max; input.step = step;
    input.value = this.settings[key];
    const val = el('span', 'setting-value', fmt(this.settings[key], max));
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      this.settings[key] = v;
      val.textContent = fmt(v, max);
      onChange(v);
      this.opts.saveSettings();
    });
    row.append(input, val);
    return row;
  }

  toggle(label, key, onChange) {
    const row = el('label', 'setting-row setting-toggle');
    row.append(el('span', 'setting-label', label));
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = !!this.settings[key];
    const pill = el('span', 'pill');
    input.addEventListener('change', () => {
      this.settings[key] = input.checked;
      onChange(input.checked);
      this.opts.audio?.ui('toggle');
      this.opts.saveSettings();
    });
    row.append(input, pill);
    return row;
  }

  choice(label, key, options, onChange) {
    const row = el('div', 'setting-row setting-choice');
    row.append(el('span', 'setting-label', label));
    const group = el('div', 'choice-group');
    for (const [value, text] of options) {
      const b = el('button', 'choice' + (this.settings[key] === value ? ' active' : ''), text);
      b.addEventListener('click', this.click(() => {
        this.settings[key] = value;
        onChange(value);
        this.opts.saveSettings();
        for (const c of group.children) c.classList.remove('active');
        b.classList.add('active');
      }));
      group.append(b);
    }
    row.append(group);
    return row;
  }

  // ── pause ───────────────────────────────────────────────────────
  buildPause() {
    const wrap = el('div', 'screen screen-pause');
    const spec = this.opts.currentSpec();
    wrap.append(el('h2', null, 'Paused'));
    if (spec) wrap.append(el('p', 'pause-sub', spec.name));

    const stats = this.opts.currentStats?.();
    if (stats) {
      const grid = el('div', 'pause-stats');
      for (const [k, v] of [
        ['Vertical', `${Math.round(stats.descent)} m`],
        ['Distance', stats.distance > 1200 ? `${(stats.distance / 1000).toFixed(2)} km` : `${Math.round(stats.distance)} m`],
        ['Top speed', `${Math.round(stats.topSpeed * 3.6)} km/h`],
        ['Best air', `${stats.biggestAir.toFixed(1)} m`],
        ['Time out', formatTime(stats.runTime)],
      ]) {
        const f = el('div', 'fact');
        f.append(el('div', 'fact-value', v));
        f.append(el('div', 'fact-label', k));
        grid.append(f);
      }
      wrap.append(grid);
    }

    const actions = el('div', 'title-actions');
    actions.append(this.button('Resume', 'primary', () => this.opts.onResume()));
    actions.append(this.button('Back to the top', 'ghost', () => this.opts.onRestart()));
    actions.append(this.button('Another mountain', 'ghost', () => this.show('maps')));
    actions.append(this.button('Settings', 'ghost', () => this.show('settings')));
    wrap.append(actions);
    this.panel.append(wrap);
  }

  // ── loading ─────────────────────────────────────────────────────
  buildLoading(spec) {
    const wrap = el('div', 'screen screen-loading');
    wrap.append(el('div', 'loading-eyebrow', 'Loading mountain'));
    wrap.append(el('h2', null, spec?.name || ''));
    if (spec) wrap.append(el('p', 'pause-sub', spec.blurb));

    const bar = el('div', 'progress');
    this.progressFill = el('div', 'progress-fill');
    bar.append(this.progressFill);
    wrap.append(bar);

    this.progressLabel = el('div', 'progress-label', 'Preparing…');
    wrap.append(this.progressLabel);

    const tip = el('div', 'tip');
    tip.append(el('span', 'tip-tag', 'Tip'));
    tip.append(el('span', null, TIPS[Math.floor(Math.random() * TIPS.length)]));
    wrap.append(tip);

    this.panel.append(wrap);
  }

  setProgress(frac, label) {
    if (this.progressFill) this.progressFill.style.width = `${clamp(frac, 0, 1) * 100}%`;
    if (this.progressLabel && label) this.progressLabel.textContent = label;
  }
}

const fmt = (v, max) => (max <= 1 ? `${Math.round(v * 100)}%` : `${v.toFixed(2)}×`);

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Draw a map's pitch profile as a little mountain silhouette, tinted with the
 * weather preset. It's a genuine read of the terrain spec, not decoration:
 * you can see the headwalls and benches before you drop in.
 */
function drawProfile(canvas, spec, weather) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, `#${weather.skyTop.toString(16).padStart(6, '0')}`);
  sky.addColorStop(1, `#${weather.skyHorizon.toString(16).padStart(6, '0')}`);
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);

  const steps = 120;
  const heights = [];
  let e = 0;
  for (let i = 0; i <= steps; i++) {
    heights.push(e);
    e -= gradientAt(spec.pitch, i / steps);
  }
  const total = -heights[steps];
  const norm = heights.map((h) => (total > 0.001 ? (h + total) / total : 0));

  // Two silhouettes: a faded ridge behind, the profile in front.
  for (const layer of [{ off: 0.16, alpha: 0.28, shift: 6 }, { off: 0, alpha: 1, shift: 0 }]) {
    g.beginPath();
    g.moveTo(-2, H + 2);
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * W + layer.shift;
      const y = H - (norm[i] * 0.72 + 0.06 + layer.off) * H;
      if (i === 0) g.lineTo(x, y); else g.lineTo(x, y);
    }
    g.lineTo(W + 2, H + 2);
    g.closePath();
    g.fillStyle = layer.alpha === 1
      ? 'rgba(246,250,255,0.94)'
      : 'rgba(210,226,244,0.3)';
    g.fill();
  }

  // Difficulty band along the bottom edge.
  const d = DIFFICULTY[spec.difficulty];
  g.fillStyle = d.color;
  g.globalAlpha = 0.9;
  g.fillRect(0, H - 3, W, 3);
  g.globalAlpha = 1;
}
