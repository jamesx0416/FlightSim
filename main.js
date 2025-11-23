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

// State
let currentTileZoom = 4;

// Managers
const tileManager = new TileManager(scene, camera);

// Zoom update logic
function updateZoomLevel(radius) {
  const altitude = Math.max(0.001, radius - RADIUS);
  const rawZoom = -1.2 * Math.log(altitude) + 9;
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(rawZoom)));

  if (newZoom !== currentTileZoom) {
    currentTileZoom = newZoom;
    // Clear pending queue when zoom changes significantly
    tileManager.pendingTileCreation.length = 0;
  }

  updateInfoDisplay(currentTileZoom);
}

// Controls
const controls = new Controls(camera, canvas, () => {
  updateZoomLevel(controls.radius);
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

// Update info UI
function updateInfoDisplay(z) {
  const infoElement = document.getElementById("info");
  if (!infoElement) return;

  infoElement.textContent =
    `tile zoom ${z}, visible ${tileManager.visibleTilesSet.size}, ` +
    `cached ${tileManager.tileImageCache.size}, concurrent ${tileManager.currentLoads}`;
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
  await tileManager.loadBaseZoomTiles();
  await tileManager.updateVisibleTiles(currentTileZoom, controls.getCameraParams());

  // Initial zoom check
  updateZoomLevel(controls.radius);

  function animate(timestamp) {
    requestAnimationFrame(animate);

    controls.updateCamera();

    // Continuous update
    tileManager.updateVisibleTiles(currentTileZoom, controls.getCameraParams());
    tileManager.processTileQueue();


    updateInfoDisplay(currentTileZoom);

    renderer.render(scene, camera);
  }

  animate();
})();
