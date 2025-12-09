import * as THREE from "three";
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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  100, // Near plane: 100m (to avoid z-fighting at high alt, we can adjust dynamic near plane later if needed)
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
// Initialize 3D Tiles
(async () => {
  await tiles3DManager.init(KEYS.GOOGLE_MAPS, KEYS.CESIUM_ION);
  if (tiles3DManager.isInitialized) {
    console.log("3D Tiles loaded, hiding 2D globe.");
    tileManager.setVisible(false);
  }
})();

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

  let activeCount = 0;
  let cachedCount = 0;
  let loadingCount = 0;

  if (tiles3DManager.isInitialized && tiles3DManager.tilesRenderer) {
    // 3D Mode Stats
    const visibleTiles = tiles3DManager.tilesRenderer.visibleTiles;

    let count = 0;
    if (visibleTiles) {
      if (typeof visibleTiles.length === 'number') {
        count = visibleTiles.length;
      } else if (typeof visibleTiles.size === 'number') {
        count = visibleTiles.size;
      }
    }
    activeCount = count;

    loadingCount = (tiles3DManager.tilesRenderer.stats && tiles3DManager.tilesRenderer.stats.downloading) || 0;

    // Cache stats
    const renderer = tiles3DManager.tilesRenderer;
    if (renderer.lruCache && renderer.lruCache.itemList) {
      cachedCount = renderer.lruCache.itemList.length || 0;
    } else if (renderer.lruCache && typeof renderer.lruCache.size === 'number') {
      cachedCount = renderer.lruCache.size;
    } else {
      cachedCount = (renderer.stats && renderer.stats.downloaded) || 0;
    }
  } else {
    // 2D Mode Stats
    activeCount = tileManager.activeTiles.size;
    cachedCount = tileManager.tileCache.size();
    loadingCount = tileManager.currentLoads;
  }

  infoElement.textContent =
    `FPS: ${fps} | Zoom: ${zoom} | ` +
    `Active: ${activeCount} | ` +
    `Cached: ${cachedCount} | ` +
    `Loading: ${loadingCount}`;
}
