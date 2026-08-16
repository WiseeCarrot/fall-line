// Input. Keyboard + mouse with pointer lock.
//
// Steering model: the mouse turns your *view*, and the skis steer toward
// wherever you're looking. That's why it reads naturally in first person —
// you look through the turn and the skis follow, exactly like you would on
// snow. The view is allowed to lead the skis by a limited angle so you can
// still glance around mid-carve.

import { clamp, damp, wrapAngle, angleDelta } from './math.js';

const MAX_LEAD = 0.95;      // radians the view may lead the skis by
const STEER_SPAN = 0.7;     // lead angle that counts as full steering input

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;

    this.viewYaw = 0;
    this.viewPitch = 0;
    this.lookOffsetX = 0;
    this.lookOffsetY = 0;

    this.state = {
      steer: 0, tuck: false, brake: false,
      jumpPressed: false, jumpHeld: false, boardPressed: false,
      viewYaw: 0, viewPitch: 0, lookOffsetX: 0, freeLook: false,
    };

    this.enabled = false;
    this.onAction = () => {};
    this._bind();
  }

  _bind() {
    this._onKeyDown = (e) => {
      if (e.repeat) return;
      const code = e.code;
      this.keys.add(code);
      this.pressed.add(code);
      // Don't let the browser scroll or activate controls behind the canvas.
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
      }
      const action = ACTIONS[code];
      if (action) this.onAction(action, e);
    };
    this._onKeyUp = (e) => this.keys.delete(e.code);

    this._onMouseMove = (e) => {
      if (!this.locked) return;
      this.mouseDx += e.movementX || 0;
      this.mouseDy += e.movementY || 0;
    };

    this._onMouseDown = (e) => {
      if (e.button === 2) this.keys.add('FreeLook');
      if (e.button === 0) { this.keys.add('Space'); this.pressed.add('Space'); }
    };
    this._onMouseUp = (e) => {
      if (e.button === 2) this.keys.delete('FreeLook');
      if (e.button === 0) this.keys.delete('Space');
    };

    this._onLockChange = () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.onAction(this.locked ? 'lockGained' : 'lockLost');
    };

    this._onContext = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('pointerlockchange', this._onLockChange);
    this.canvas.addEventListener('contextmenu', this._onContext);
  }

  requestLock() {
    if (this.locked) return;
    // Browsers rate-limit this and reject if you ask again too soon; a failed
    // request just means the player clicks once more.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p?.catch) p.catch(() => {});
    } catch { /* rate limited */ }
  }

  releaseLock() {
    if (this.locked) document.exitPointerLock?.();
  }

  has(...codes) { return codes.some((c) => this.keys.has(c)); }
  took(code) {
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  /** Consume accumulated input and produce this frame's control state. */
  sample(dt, skierHeading) {
    const s = this.state;

    if (!this.enabled) {
      s.steer = 0; s.tuck = false; s.brake = false;
      s.jumpPressed = false; s.jumpHeld = false; s.boardPressed = false;
      this.mouseDx = 0; this.mouseDy = 0;
      this.pressed.clear();
      return s;
    }

    const freeLook = this.has('KeyC', 'FreeLook');
    const dx = this.mouseDx * this.sensitivity;
    const dy = this.mouseDy * this.sensitivity * (this.invertY ? -1 : 1);
    this.mouseDx = 0;
    this.mouseDy = 0;

    if (freeLook) {
      this.lookOffsetX = clamp(this.lookOffsetX - dx, -2.4, 2.4);
    } else {
      this.viewYaw = wrapAngle(this.viewYaw - dx);
      this.lookOffsetX = damp(this.lookOffsetX, 0, 7, dt);
    }
    this.viewPitch = clamp(this.viewPitch - dy, -0.95, 0.75);

    // Keyboard steering nudges the view, so both schemes drive the same axis.
    let kb = 0;
    if (this.has('KeyA', 'ArrowLeft')) kb += 1;
    if (this.has('KeyD', 'ArrowRight')) kb -= 1;
    if (kb !== 0 && !freeLook) {
      this.viewYaw = wrapAngle(this.viewYaw + kb * 2.4 * dt);
    }

    // Clamp how far the view may lead the skis, then derive steering from it.
    const lead = angleDelta(skierHeading, this.viewYaw);
    if (Math.abs(lead) > MAX_LEAD) {
      this.viewYaw = wrapAngle(skierHeading + Math.sign(lead) * MAX_LEAD);
    }
    const clampedLead = angleDelta(skierHeading, this.viewYaw);
    s.steer = clamp(clampedLead / STEER_SPAN, -1, 1);

    s.tuck = this.has('KeyW', 'ShiftLeft', 'ShiftRight', 'ArrowUp');
    s.brake = this.has('KeyS', 'ControlLeft', 'ControlRight', 'ArrowDown');
    s.jumpPressed = this.took('Space');
    s.jumpHeld = this.has('Space');
    s.boardPressed = this.took('KeyE');
    s.freeLook = freeLook;
    s.viewYaw = this.viewYaw;
    s.viewPitch = this.viewPitch;
    s.lookOffsetX = this.lookOffsetX;

    this.pressed.clear();
    return s;
  }

  /** Re-centre the view behind the skis, e.g. after a reset. */
  alignTo(heading) {
    this.viewYaw = heading;
    this.viewPitch = 0;
    this.lookOffsetX = 0;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this.canvas.removeEventListener('contextmenu', this._onContext);
  }
}

const ACTIONS = {
  Escape: 'pause',
  KeyR: 'reset',
  KeyM: 'mute',
  KeyH: 'hud',
  KeyF: 'viewmodel',
  KeyN: 'music',
};
