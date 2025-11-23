import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import {
  RADIUS,
  MAX_ZOOM,
  MIN_ZOOM,
  STARTING_RADIUS
} from "./Constants.js";
import { TileManager } from "./TileManager.js";
import { Controls } from "./Controls.js";

const canvas = document.getElementById("renderCanvas");

// Three.js core setup
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.01,
  RADIUS * 10
);

// Lights
{
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.9);
  scene.add(hemi);
}

// Managers
const tileManager = new TileManager(scene, camera);

// Controls
const controls = new Controls(camera, canvas, () => {
  // Callback if needed
});

// UI wiring for Pause
const pauseToggleBtn = document.getElementById("pauseToggle");
if (pauseToggleBtn) {
  pauseToggleBtn.onclick = () => {
    tileManager.loadingPaused = !tileManager.loadingPaused;
    pauseToggleBtn.textContent = tileManager.loadingPaused
      ? "Resume Loading"
      : "Pause Loading";
  };
}

// Resize handling
window.addEventListener("resize", () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

// Init sequence
(async function init() {

  let lastTime = performance.now();
  let frameCount = 0;
  let fps = 0;
  let lastFpsTime = lastTime;

  function animate(timestamp) {
    requestAnimationFrame(animate);

    // FPS Calculation
    const now = performance.now();
    frameCount++;
    if (now - lastFpsTime >= 1000) {
      fps = frameCount;
      frameCount = 0;
      lastFpsTime = now;
    }

    controls.updateCamera();

    // Continuous update
    tileManager.update();

    // Calculate current zoom based on altitude
    const altitude = Math.max(0.001, controls.radius - RADIUS);
    const altitudeKm = altitude * 100; // Convert to km
    const currentZoom = tileManager.lodManager.getDesiredZoom(altitudeKm);

    updateInfoDisplay(fps, currentZoom);

    renderer.render(scene, camera);
  }

  animate();
})();

// Update info UI
function updateInfoDisplay(fps, zoom) {
  const infoElement = document.getElementById("info");
  if (!infoElement) return;

  infoElement.textContent =
    `FPS: ${fps} | Zoom: ${zoom} | ` +
    `Active: ${tileManager.activeTiles.size} | ` +
    `Cached: ${tileManager.tileCache.size()} | ` +
    `Loading: ${tileManager.currentLoads} | ` +
    `Queue: ${tileManager.loadQueue.length}`;
}
