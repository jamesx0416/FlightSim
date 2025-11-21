import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import ThreeGlobe from "https://esm.sh/three-globe";
import {
  RADIUS,
  MAX_ZOOM,
  MIN_ZOOM,
  STARTING_RADIUS,
  UPDATE_INTERVAL
} from "./Constants.js";
import { TileManager } from "./TileManager.js";
import { Controls } from "./Controls.js";
import { FlatPlaneManager } from "./FlatPlaneManager.js";

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
  const ambientLight = new THREE.AmbientLight(0xbbbbbb);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
  directionalLight.position.set(1, 1, 1);
  scene.add(directionalLight);
}

// Globe.gl setup
const Globe = new ThreeGlobe()
  .bumpImageUrl('https://unpkg.com/three-globe/example/img/earth-topology.png')
  .showAtmosphere(false)
  .atmosphereAltitude(0);

// ThreeGlobe default radius is 100. Scale to match our RADIUS, but slightly smaller to avoid z-fighting.
Globe.scale.setScalar((RADIUS * 0.99) / 100);

scene.add(Globe);

// State
let currentTileZoom = 4;
let lastUpdate = 0;

// Managers
const tileManager = new TileManager(scene, camera);
const flatPlaneManager = new FlatPlaneManager(scene);

// Zoom update logic
function getZoomFromAltitude(altitude) {
  // altitude is in units (1 unit = 100km)
  // Further adjusted formula for much earlier detail
  // Formula: zoom = -1.4 * log2(altitude) + 11.0
  // 
  // Mapping:
  // 1000km (10.0) -> ~6.4
  // 100km (1.0)   -> 11.0
  // 10km (0.1)    -> ~15.6 (Clamped to 15)

  // Prevent log(0)
  const safeAlt = Math.max(0.000001, altitude);

  const rawZoom = -1.4 * Math.log2(safeAlt) + 11.0;

  return rawZoom;
}

function updateZoomLevel(radius) {
  const altitude = Math.max(0.00001, radius - RADIUS);
  const fractionalZoom = getZoomFromAltitude(altitude);

  // Clamp to supported range
  const clampedZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fractionalZoom));

  if (Math.abs(clampedZoom - currentTileZoom) > 0.01) {
    currentTileZoom = clampedZoom;
    // Clear pending queue when zoom changes significantly
    // tileManager.pendingTileCreation.length = 0; // Keep queue for smoothness?
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
  // await tileManager.loadBaseZoomTiles(); // Disabled in favor of Globe.gl base
  await tileManager.updateVisibleTiles(currentTileZoom, controls.getCameraParams());

  // Initial zoom check
  updateZoomLevel(controls.radius);

  function animate(timestamp) {
    requestAnimationFrame(animate);

    controls.updateCamera();

    // Continuous update
    if (timestamp - lastUpdate > UPDATE_INTERVAL) {
      tileManager.updateVisibleTiles(currentTileZoom, controls.getCameraParams());
      lastUpdate = timestamp;
    }

    // Mode switching logic
    const FLAT_THRESHOLD = 12;
    const isFlatMode = currentTileZoom > FLAT_THRESHOLD;

    if (isFlatMode) {
      Globe.visible = false;
      tileManager.visibleTilesSet.forEach(key => {
        const mesh = tileManager.tileMeshCache.get(key);
        if (mesh) mesh.visible = false;
      });
      flatPlaneManager.update(true, controls.getCameraParams());
    } else {
      Globe.visible = true;
      // TileManager manages its own visibility in updateVisibleTiles, 
      // but we forced them hidden above, so updateVisibleTiles will restore them next frame?
      // Actually updateVisibleTiles sets .visible = true.
      // So we just need to ensure FlatPlane is hidden.
      flatPlaneManager.update(false, controls.getCameraParams());

      // We might need to force tile visibility restore if we just switched back
      // But updateVisibleTiles runs every UPDATE_INTERVAL.
      // For smoothness, we should probably let tileManager handle it.
    }

    tileManager.processTileQueue();
    tileManager.updateFadingTiles();

    updateInfoDisplay(currentTileZoom);

    renderer.render(scene, camera);
  }

  animate();
})();
