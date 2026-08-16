// Heads-up display. Deliberately quiet — there's no timer and no score, so
// the HUD's job is just to tell you how fast you're going, what you're
// standing on, and where you are on the hill.

import { DIFFICULTY, difficultyChip } from '../world/maps.js';
import { clamp } from '../core/math.js';

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

export class HUD {
  constructor(root) {
    this.root = root;
    this.visible = true;
    this.accum = 0;
    this.toasts = [];
    this.build();
  }

  build() {
    const r = this.root;
    r.innerHTML = '';

    // ── top left: where you are ─────────────────────────────────
    const top = el('div', 'hud-top');
    this.mapChip = el('div', 'chip chip-diff');
    this.mapName = el('div', 'hud-map-name');
    this.mapMeta = el('div', 'hud-map-meta');
    const nameCol = el('div', 'hud-map-col');
    nameCol.append(this.mapName, this.mapMeta);
    top.append(this.mapChip, nameCol);
    r.append(top);

    // ── centre: air time and status ─────────────────────────────
    this.centre = el('div', 'hud-centre');
    this.airLabel = el('div', 'hud-air');
    this.statusLabel = el('div', 'hud-status');
    this.centre.append(this.airLabel, this.statusLabel);
    r.append(this.centre);

    // Lift prompt and ride progress
    this.prompt = el('div', 'hud-prompt');
    r.append(this.prompt);
    this.ride = el('div', 'hud-ride');
    this.rideLabel = el('div', 'ride-label', 'Riding up');
    this.rideBar = el('div', 'ride-bar');
    this.rideFill = el('div', 'ride-fill');
    this.rideBar.append(this.rideFill);
    this.rideHint = el('div', 'ride-hint', 'E — get off');
    this.ride.append(this.rideLabel, this.rideBar, this.rideHint);
    r.append(this.ride);

    this.reticle = el('div', 'hud-reticle');
    this.reticle.append(el('span', 'reticle-dot'));
    r.append(this.reticle);

    // ── bottom left: minimap ────────────────────────────────────
    const mapWrap = el('div', 'hud-minimap');
    this.minimap = document.createElement('canvas');
    this.minimap.width = 132;
    this.minimap.height = 178;
    mapWrap.append(this.minimap);
    this.mctx = this.minimap.getContext('2d');
    r.append(mapWrap);

    // ── bottom centre: speed ────────────────────────────────────
    const speedWrap = el('div', 'hud-speed');
    this.speedValue = el('div', 'speed-value', '0');
    this.speedUnit = el('div', 'speed-unit', 'km/h');
    const speedRow = el('div', 'speed-row');
    speedRow.append(this.speedValue, this.speedUnit);
    this.surfaceLabel = el('div', 'surface-label', 'Groomed');
    this.speedBar = el('div', 'speed-bar');
    this.speedFill = el('div', 'speed-fill');
    this.speedBar.append(this.speedFill);
    speedWrap.append(speedRow, this.speedBar, this.surfaceLabel);
    r.append(speedWrap);

    // ── bottom right: run stats ─────────────────────────────────
    const stats = el('div', 'hud-stats');
    this.statAlt = this.statRow(stats, 'Altitude', '—');
    this.statVert = this.statRow(stats, 'Vertical', '0 m');
    this.statDist = this.statRow(stats, 'Distance', '0 m');
    this.statAir = this.statRow(stats, 'Best air', '0.0 s');
    this.statTop = this.statRow(stats, 'Top speed', '0 km/h');
    r.append(stats);

    // ── toasts ──────────────────────────────────────────────────
    this.toastWrap = el('div', 'hud-toasts');
    r.append(this.toastWrap);

    // ── controls reminder ───────────────────────────────────────
    this.hint = el('div', 'hud-hint');
    this.hint.innerHTML =
      '<kbd>Mouse</kbd> steer &nbsp; <kbd>W</kbd> skate / tuck &nbsp; <kbd>S</kbd> check speed &nbsp; ' +
      '<kbd>Space</kbd> jump &nbsp; <kbd>E</kbd> lift &nbsp; <kbd>C</kbd> look around &nbsp; ' +
      '<kbd>R</kbd> restart &nbsp; <kbd>Esc</kbd> menu';
    r.append(this.hint);
  }

  statRow(parent, label, value) {
    const row = el('div', 'stat-row');
    row.append(el('span', 'stat-label', label));
    const v = el('span', 'stat-value', value);
    row.append(v);
    parent.append(row);
    return v;
  }

  setMap(spec, preset) {
    this.clearToasts();
    // Only mountains with a real-world elevation show one.
    this.baseAltitude = spec.baseAltitude || 0;
    this.statAlt.parentElement.style.display = this.baseAltitude ? '' : 'none';
    const d = DIFFICULTY[spec.difficulty];
    this.mapChip.textContent = d.symbol;
    const { fg, bg } = difficultyChip(spec.difficulty);
    this.mapChip.style.color = fg;
    this.mapChip.style.background = bg;
    this.mapName.textContent = spec.name;
    this.mapMeta.textContent = `${d.label} · ${preset.name} · ${spec.drop} m vertical`;
    this.prepareMinimap(spec);
  }

  /** Pre-render the static part of the minimap: outline plus trail lines. */
  prepareMinimap(spec) {
    this.minimapSpec = spec;
    this.minimapBase = document.createElement('canvas');
    this.minimapBase.width = this.minimap.width;
    this.minimapBase.height = this.minimap.height;
    this.mapReady = false;
  }

  buildMinimapBase(terrain) {
    const c = this.minimapBase;
    const g = c.getContext('2d');
    const W = c.width, H = c.height;
    g.clearRect(0, 0, W, H);

    const pad = 8;
    const sx = (W - pad * 2) / terrain.width;
    const sz = (H - pad * 2) / terrain.length;
    this.mm = { sx, sz, pad, halfW: terrain.halfW };
    const px = (x) => pad + (x + terrain.halfW) * sx;
    const pz = (z) => pad + z * sz;

    g.fillStyle = 'rgba(14,18,26,0.55)';
    g.fillRect(0, 0, W, H);

    // Shade the off-piste so trails read as lighter ribbons.
    g.strokeStyle = 'rgba(180,205,235,0.16)';
    g.lineWidth = 1;
    g.strokeRect(pad, pad, W - pad * 2, H - pad * 2);

    // Runs are drawn in their own difficulty colour where the map defines
    // them per-run, so the minimap reads like a trail map.
    const RUN_COLOURS = {
      green: 'rgba(96,196,116,0.85)',
      blue: 'rgba(96,166,224,0.85)',
      black: 'rgba(232,238,248,0.9)',
      dblack: 'rgba(244,148,148,0.9)',
      park: 'rgba(240,166,72,0.85)',
      back: 'rgba(168,152,224,0.85)',
    };
    for (const trail of terrain.trails) {
      g.beginPath();
      g.lineWidth = Math.max(2, trail.width * sx);
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.strokeStyle = RUN_COLOURS[trail.difficulty] || 'rgba(226,238,252,0.5)';
      trail.samples.forEach((p, i) => {
        const X = px(p.x), Y = pz(p.z);
        if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y);
      });
      g.stroke();
    }

    // Lifts
    g.setLineDash([3, 3]);
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,190,90,0.6)';
    g.setLineDash([]);

    this.mapReady = true;
  }

  drawMinimap(terrain, skier, bots) {
    if (!this.mapReady) this.buildMinimapBase(terrain);
    const g = this.mctx;
    const W = this.minimap.width, H = this.minimap.height;
    g.clearRect(0, 0, W, H);
    g.drawImage(this.minimapBase, 0, 0);

    const { sx, sz, pad } = this.mm;
    const px = (x) => pad + (x + terrain.halfW) * sx;
    const pz = (z) => pad + z * sz;

    if (bots) {
      g.fillStyle = 'rgba(255,214,140,0.75)';
      for (const b of bots.bots) {
        g.fillRect(px(b.x) - 1, pz(b.z) - 1, 2, 2);
      }
    }

    // Player: a triangle pointing where the skis point.
    const X = px(skier.pos.x), Y = pz(skier.pos.z);
    g.save();
    g.translate(X, Y);
    g.rotate(-skier.heading + Math.PI);
    g.beginPath();
    g.moveTo(0, -6);
    g.lineTo(4, 4);
    g.lineTo(0, 2);
    g.lineTo(-4, 4);
    g.closePath();
    g.fillStyle = '#63c6ff';
    g.fill();
    g.strokeStyle = 'rgba(6,10,16,0.9)';
    g.lineWidth = 1;
    g.stroke();
    g.restore();
  }

  update(dt, { skier, terrain, bots }) {
    if (!this.visible) return;
    this.accum += dt;

    // Fast-changing readouts every frame, text only a few times a second.
    const kmh = skier.speed * 3.6;
    this.speedFill.style.width = `${clamp(kmh / 160, 0, 1) * 100}%`;

    if (!skier.grounded && !skier.onRail && skier.airTime > 0.35) {
      this.airLabel.textContent = `${skier.airTime.toFixed(1)}s`;
      this.airLabel.classList.add('active');
    } else {
      this.airLabel.classList.remove('active');
    }

    this.statusLabel.textContent = skier.crashed ? 'Getting up…' : '';
    this.statusLabel.classList.toggle('active', skier.crashed);

    // Lift: either an offer to board, or how far up you are.
    const riding = !!skier.riding;
    this.ride.classList.toggle('active', riding);
    if (riding) {
      this.rideFill.style.width = `${clamp(skier.riding.progress || 0, 0, 1) * 100}%`;
    }
    const offer = !riding && skier.nearLift;
    this.prompt.classList.toggle('active', !!offer);
    if (offer && this.prompt.dataset.shown !== 'yes') {
      this.prompt.innerHTML = '<kbd>E</kbd> ride the lift';
      this.prompt.dataset.shown = 'yes';
    } else if (!offer) {
      this.prompt.dataset.shown = '';
    }

    if (this.accum > 0.1) {
      this.accum = 0;
      this.speedValue.textContent = Math.round(kmh);
      this.surfaceLabel.textContent = surfaceName(skier.surface, skier.onRail);
      if (this.baseAltitude) {
        const alt = Math.round(this.baseAltitude + skier.pos.y);
        this.statAlt.textContent = `${alt.toLocaleString('en-US')} m`;
      }
      this.statVert.textContent = `${Math.round(skier.stats.descent)} m`;
      this.statDist.textContent = skier.stats.distance > 1200
        ? `${(skier.stats.distance / 1000).toFixed(2)} km`
        : `${Math.round(skier.stats.distance)} m`;
      this.statAir.textContent = `${skier.stats.biggestAir.toFixed(1)} m`;
      this.statTop.textContent = `${Math.round(skier.stats.topSpeed * 3.6)} km/h`;
      this.drawMinimap(terrain, skier, bots);
    }

    this.tickToasts(dt);
  }

  toast(text, sub = '') {
    const node = el('div', 'toast');
    node.append(el('div', 'toast-main', text));
    if (sub) node.append(el('div', 'toast-sub', sub));
    this.toastWrap.append(node);
    requestAnimationFrame(() => node.classList.add('in'));
    this.toasts.push({ node, life: 2.8 });
    while (this.toasts.length > 4) {
      const old = this.toasts.shift();
      old.node.remove();
    }
  }

  clearToasts() {
    for (const t of this.toasts) t.node.remove();
    this.toasts.length = 0;
  }

  tickToasts(dt) {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const t = this.toasts[i];
      t.life -= dt;
      if (t.life <= 0.5) t.node.classList.remove('in');
      if (t.life <= 0) {
        t.node.remove();
        this.toasts.splice(i, 1);
      }
    }
  }

  setVisible(v) {
    this.visible = v;
    this.root.style.display = v ? '' : 'none';
  }

  /** Show the controls reminder again, then fade it after a while. */
  fadeHint() {
    this.hint?.classList.remove('faded');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this.hint?.classList.add('faded'), 14000);
  }
}

function surfaceName(s, onRail) {
  if (onRail) return 'Rail';
  if (s.paved > 0.4) return 'Car park';
  if (s.ice > 0.45) return 'Ice';
  if (s.rock > 0.4) return 'Rock';
  if (s.deep > 0.28) return 'Deep powder';
  if (s.deep > 0.14) return 'Soft snow';
  if (s.groom > 0.6) return 'Groomed';
  if (s.groom > 0.2) return 'Skied off';
  return 'Off-piste';
}
