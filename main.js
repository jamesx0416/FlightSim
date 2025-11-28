import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import {
  RADIUS,
  MAX_ZOOM,
  MIN_ZOOM,
  STARTING_RADIUS
} from "./Constants.js";
import { TileManager } from "./TileManager.js";
import { Tiles3DManager } from "./Tiles3DManager.js";
import { Controls } from "./Controls.js";
import { KEYS } from "./Keys.js";

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
const tiles3DManager = new Tiles3DManager(scene, camera, renderer);

// Example: Load Google Photorealistic 3D Tiles
if (KEYS.GOOGLE_MAPS !== 'YOUR_GOOGLE_MAPS_KEY_HERE') {
  tiles3DManager.loadTileset(`https://tile.googleapis.com/v1/3dtiles/root.json?key=${KEYS.GOOGLE_MAPS}`);
  tiles3DManager.setTransform(40.689, -74.044, 0); // Statue of Liberty
}

// Example: Load Cesium Ion asset (Requires Cesium Ion Access Token)
if (KEYS.CESIUM_ION !== 'YOUR_CESIUM_TOKEN_HERE') {
  tiles3DManager.loadCesiumIonAsset(96188, KEYS.CESIUM_ION); // OSM Buildings (Global)
}
// Note: Global tilesets like OSM Buildings don't need setTransform - they're already in correct world coordinates

// For LOCAL tilesets only (like Google Photorealistic in a specific city):
// tiles3DManager.setTransform(40.689, -74.044, 0); // Position at Statue of Liberty

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
    tiles3DManager.update();

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
    `Loading: ${tileManager.currentLoads}`;
}
