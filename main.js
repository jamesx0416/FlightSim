import * as THREE from "three";
import { GlobeControls } from "3d-tiles-renderer";
import { RADIUS, CAMERA_NEAR_PLANE, CAMERA_FAR_PLANE_FACTOR, MIN_ALTITUDE, MAX_ALTITUDE_FACTOR } from "./Constants.js";
import { TileManager } from "./2d/TileManager.js";
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
  CAMERA_NEAR_PLANE,
  RADIUS * CAMERA_FAR_PLANE_FACTOR
);

// Set initial camera position (looking at Earth from space)
camera.position.set(0, 0, RADIUS * 2);
camera.lookAt(0, 0, 0);

// Lights
{
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.9);
  scene.add(hemi);
}

// Managers
const tileManager = new TileManager(scene, camera);
const tiles3DManager = new Tiles3DManager(scene, camera, renderer);

// Controls - will be set after 3D tiles load
let controls = null;
let fallbackControls = null;

// Keep fallback controls for 2D mode
fallbackControls = new Controls(camera, canvas, () => { });

// Initialize 3D Tiles and GlobeControls
(async () => {
  await tiles3DManager.init(KEYS.GOOGLE_MAPS, KEYS.CESIUM_ION);

  if (tiles3DManager.isInitialized && tiles3DManager.tilesRenderer) {
    console.log("3D Tiles loaded, setting up GlobeControls");
    tileManager.setVisible(false);

    // Create GlobeControls - use new API to avoid deprecation warning
    // Pass null for tilesRenderer, then set scene and ellipsoid separately
    controls = new GlobeControls(scene, camera, canvas, null);

    // Use the ellipsoid from the tilesRenderer (WGS84 by default)
    controls.setScene(scene);
    if (tiles3DManager.tilesRenderer.ellipsoid) {
      controls.ellipsoid = tiles3DManager.tilesRenderer.ellipsoid;
    }

    // Configure controls
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;

    // Set zoom limits (minDistance = closest, maxDistance = farthest)
    controls.minDistance = RADIUS + MIN_ALTITUDE;
    controls.maxDistance = RADIUS * (1 + MAX_ALTITUDE_FACTOR);

    console.log("GlobeControls initialized successfully");

  } else {
    console.log("3D Tiles failed to load, using 2D fallback with custom controls");
    controls = fallbackControls;
  }
})();

// UI wiring for Pause
const pauseToggleBtn = document.getElementById("pauseToggle");
if (pauseToggleBtn) {
  pauseToggleBtn.onclick = () => {
    if (tiles3DManager.isInitialized) {
      tiles3DManager.loadingPaused = !tiles3DManager.loadingPaused;
      pauseToggleBtn.textContent = tiles3DManager.loadingPaused
        ? "Resume Loading"
        : "Pause Loading";
    } else {
      tileManager.loadingPaused = !tileManager.loadingPaused;
      pauseToggleBtn.textContent = tileManager.loadingPaused
        ? "Resume Loading"
        : "Pause Loading";
    }
  };
}

// UI wiring for Zoom buttons
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");

if (zoomInBtn) {
  zoomInBtn.onclick = () => {
    if (controls && controls !== fallbackControls) {
      // GlobeControls - zoom by moving camera closer
      const distance = camera.position.length();
      const newDistance = Math.max(RADIUS + MIN_ALTITUDE, distance * 0.8);
      camera.position.normalize().multiplyScalar(newDistance);
    } else if (fallbackControls) {
      // Fallback controls
      fallbackControls.radius = Math.max(RADIUS + MIN_ALTITUDE, fallbackControls.radius * 0.8);
      fallbackControls.updateCamera();
    }
  };
}

if (zoomOutBtn) {
  zoomOutBtn.onclick = () => {
    if (controls && controls !== fallbackControls) {
      // GlobeControls - zoom by moving camera farther
      const distance = camera.position.length();
      const newDistance = Math.min(RADIUS * (1 + MAX_ALTITUDE_FACTOR), distance * 1.25);
      camera.position.normalize().multiplyScalar(newDistance);
    } else if (fallbackControls) {
      // Fallback controls
      fallbackControls.radius = Math.min(RADIUS * (1 + MAX_ALTITUDE_FACTOR), fallbackControls.radius * 1.25);
      fallbackControls.updateCamera();
    }
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

// Animation loop
let frameCount = 0;
let fps = 0;
let lastFpsTime = performance.now();

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

  // Update controls (GlobeControls.update() handles camera movement)
  if (controls && controls.update) {
    controls.update();
  } else if (fallbackControls) {
    fallbackControls.updateCamera();
  }

  // Update tile managers
  tileManager.update();
  tiles3DManager.update();

  // Calculate current zoom based on camera distance
  const cameraDistance = camera.position.length();
  const altitude = Math.max(0.001, cameraDistance - RADIUS);
  const altitudeKm = altitude / 1000; // Convert meters to km
  const currentZoom = tileManager.lodManager.getDesiredZoom(altitudeKm);

  updateInfoDisplay(fps, currentZoom);

  renderer.render(scene, camera);
}

animate();

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
    const tilesRenderer = tiles3DManager.tilesRenderer;
    if (tilesRenderer.lruCache && tilesRenderer.lruCache.itemList) {
      cachedCount = tilesRenderer.lruCache.itemList.length || 0;
    } else if (tilesRenderer.lruCache && typeof tilesRenderer.lruCache.size === 'number') {
      cachedCount = tilesRenderer.lruCache.size;
    } else {
      cachedCount = (tilesRenderer.stats && tilesRenderer.stats.downloaded) || 0;
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
