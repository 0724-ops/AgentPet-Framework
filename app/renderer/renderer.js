// PLACEHOLDER renderer (to be replaced by the real Si 3D scene).
// Draws a magenta rectangle on a transparent canvas and confirms three.js loads
// from the local bridge server.
const THREE_URL = 'http://127.0.0.1:8731/vendor/three/three.module.js';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
let threeOk = false;

function draw() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth * dpr));
  const h = Math.max(1, Math.round(window.innerHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.clearRect(0, 0, w, h);

  // Magenta test rectangle.
  ctx.fillStyle = '#ff00ff';
  ctx.fillRect(w * 0.2, h * 0.2, w * 0.6, h * 0.6);

  // Debug label so the headless PNG capture is human-inspectable.
  ctx.fillStyle = '#ffffff';
  ctx.font = `${Math.round(16 * dpr)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(`PLACEHOLDER  three ${threeOk ? 'ok' : '...'}`, w / 2, h * 0.5);
  ctx.fillText(`${window.innerWidth}x${window.innerHeight}`, w / 2, h * 0.5 + 24 * dpr);

  window.__placeholderDrawn = true;
}

// Draw immediately, then try the bridge-hosted three.js.
draw();
window.addEventListener('resize', draw);
setInterval(draw, 500); // keep the transparent window repainting for capturePage

try {
  const THREE = await import(THREE_URL);
  threeOk = true;
  window.__threeOk = true;
  window.__threeRevision = THREE.REVISION;
  console.log(`three ok (THREE.REVISION=${THREE.REVISION}) from ${THREE_URL}`);
} catch (err) {
  window.__threeOk = false;
  window.__threeError = err && err.message ? err.message : String(err);
  console.error(`three import FAILED from ${THREE_URL}: ${window.__threeError}`);
}
draw();
