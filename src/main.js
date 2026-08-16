import { Game } from './game.js';

const canvas = document.getElementById('viewport');
const dom = {
  hud: document.getElementById('hud'),
  menu: document.getElementById('menu'),
};

function fail(message, detail) {
  const box = document.getElementById('boot-error');
  box.style.display = 'flex';
  box.querySelector('.boot-msg').textContent = message;
  box.querySelector('.boot-detail').textContent = detail || '';
  console.error(message, detail);
}

// WebGL2 is required for the snow shader's derivative-based groove fade.
// Probe on a throwaway canvas — asking the real one for a context here would
// lock in the wrong context attributes before the renderer gets to it.
const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  fail(
    'This game needs WebGL 2.',
    'Your browser or graphics driver did not provide a WebGL 2 context. Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.',
  );
} else {
  probe.getExtension('WEBGL_lose_context')?.loseContext();

  try {
    const game = new Game(canvas, dom);
    game.start();
    window.game = game; // handy in the console
    document.getElementById('boot').classList.add('done');
  } catch (err) {
    fail('Something went wrong starting the game.', String(err?.stack || err));
  }
}
