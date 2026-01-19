import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GlobeControls } from "3d-tiles-renderer";
import {
  RADIUS, CAMERA_NEAR_PLANE, CAMERA_FAR_PLANE_FACTOR,
  MIN_ALTITUDE, MAX_ALTITUDE_FACTOR,
  SUN_DISTANCE, SUN_INTENSITY, AMBIENT_INTENSITY, DAY_CYCLE_SPEED,
  SHADOW_MAP_SIZE, SHADOW_CAMERA_SIZE,
  RENDER_PIXEL_RATIO
} from "./Constants.js";
import { TileManager } from "./2d/TileManager.js";
import { Tiles3DManager } from "./Tiles3DManager.js";
import { KEYS } from "./Keys.js";
import { Atmosphere } from "./atmosphere/Atmosphere.js";

// DOM Elements
const canvas = document.getElementById("renderCanvas");
const pauseBtn = document.getElementById("pauseToggle");
const zoomInBtn = document.getElementById("zoomIn");
const zoomOutBtn = document.getElementById("zoomOut");
const infoEl = document.getElementById("info");

// Renderer with shadows
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  logarithmicDepthBuffer: true
});
// Performance: Force 1x pixel ratio to uncap FPS on high-DPI displays (Retina)
renderer.setPixelRatio(RENDER_PIXEL_RATIO);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x000000, 1);  // Black - atmosphere will provide sky color
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

// Scene & Camera
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  CAMERA_NEAR_PLANE,
  RADIUS * CAMERA_FAR_PLANE_FACTOR
);
camera.position.set(0, 0, RADIUS * 2);
camera.lookAt(0, 0, 0);

// Atmosphere (sky dome with atmospheric scattering)
const atmosphere = new Atmosphere(scene, camera);

// Lighting - Ambient (for night side)
const ambientLight = new THREE.AmbientLight(0x404080, AMBIENT_INTENSITY);
scene.add(ambientLight);

// Lighting - Sun (Directional Light)
const sunLight = new THREE.DirectionalLight(0xfffaed, SUN_INTENSITY);
sunLight.position.set(SUN_DISTANCE, 0, 0);
sunLight.castShadow = true;

// Shadow camera configuration - adjusted for planetary scale
// Note: Shadows at planetary scale are challenging; this provides basic coverage
sunLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
sunLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
sunLight.shadow.camera.near = 0.5;
sunLight.shadow.camera.far = SUN_DISTANCE * 2;
sunLight.shadow.camera.left = -SHADOW_CAMERA_SIZE;
sunLight.shadow.camera.right = SHADOW_CAMERA_SIZE;
sunLight.shadow.camera.top = SHADOW_CAMERA_SIZE;
sunLight.shadow.camera.bottom = -SHADOW_CAMERA_SIZE;
sunLight.shadow.bias = -0.0001;
sunLight.shadow.normalBias = 0.5;

scene.add(sunLight);
scene.add(sunLight.target); // Target at origin (Earth center)

// Sun direction vector (used by atmosphere)
const sunDirection = new THREE.Vector3();

// Tile Managers
const tileManager2D = new TileManager(scene, camera);
const tiles3D = new Tiles3DManager(scene, camera, renderer);

// State
let controls = null;
let using3D = false;
let sunAngle = 0;  // Current angle of the sun (radians)

// Initialize
(async () => {
  await tiles3D.init(KEYS.GOOGLE_MAPS, KEYS.CESIUM_ION);

  if (tiles3D.isInitialized && tiles3D.tilesRenderer) {
    using3D = true;
    tileManager2D.setVisible(false);
    
    // Use GlobeControls for 3D Tiles
    controls = new GlobeControls(scene, camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    
    // Set up GlobeControls specific settings
    // We attach it to the tiles group so it knows what to collide/interact with
    controls.setScene(tiles3D.group); 
    
    // If available, set the ellipsoid for better navigation
    if (tiles3D.tilesRenderer.ellipsoid) {
       controls.setEllipsoid(tiles3D.tilesRenderer.ellipsoid);
    }

    console.log("3D Tiles ready (GlobeControls active)");
  } else {
    using3D = false;
    // Fallback to OrbitControls for 2D mode
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.minDistance = RADIUS + MIN_ALTITUDE;
    controls.maxDistance = RADIUS * (1 + MAX_ALTITUDE_FACTOR);
    controls.target.set(0, 0, 0);
    console.log("2D Tiles ready (OrbitControls active)");
  }
})();

// UI Handlers
pauseBtn?.addEventListener("click", () => {
  if (using3D) {
    tiles3D.loadingPaused = !tiles3D.loadingPaused;
    pauseBtn.textContent = tiles3D.loadingPaused ? "Resume" : "Pause";
  } else {
    tileManager2D.loadingPaused = !tileManager2D.loadingPaused;
    pauseBtn.textContent = tileManager2D.loadingPaused ? "Resume" : "Pause";
  }
});

zoomInBtn?.addEventListener("click", () => {
  const dist = camera.position.length();
  const newDist = Math.max(RADIUS + MIN_ALTITUDE, dist * 0.8);
  camera.position.normalize().multiplyScalar(newDist);
});

zoomOutBtn?.addEventListener("click", () => {
  const dist = camera.position.length();
  const newDist = Math.min(RADIUS * (1 + MAX_ALTITUDE_FACTOR), dist * 1.25);
  camera.position.normalize().multiplyScalar(newDist);
});

// Resize
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Animation Loop
let frameCount = 0, fps = 0, lastFpsTime = performance.now(), lastTime = performance.now();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const deltaTime = now - lastTime;
  lastTime = now;

  // FPS
  frameCount++;
  if (now - lastFpsTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsTime = now;
  }

  // Update sun position (day/night cycle)
  sunAngle += DAY_CYCLE_SPEED * deltaTime;
  sunLight.position.x = Math.cos(sunAngle) * SUN_DISTANCE;
  sunLight.position.z = Math.sin(sunAngle) * SUN_DISTANCE;
  // Add slight tilt for seasonal variation feel
  sunLight.position.y = Math.sin(sunAngle * 0.1) * SUN_DISTANCE * 0.3;
  
  // Update sun direction for atmosphere
  sunDirection.copy(sunLight.position).normalize();

  // Update controls
  controls?.update();

  // Update tiles
  if (using3D) {
    tiles3D.update();
  } else {
    tileManager2D.update();
  }

  // Update camera matrices before atmosphere update
  camera.updateMatrixWorld();
  
  // Update atmosphere with current sun direction (after camera update)
  atmosphere.update(sunDirection);

  // Stats display
  updateStats(fps);

  renderer.render(scene, camera);
}

function updateStats(fps) {
  if (!infoEl) return;

  const alt = Math.max(0, camera.position.length() - RADIUS);
  const altKm = (alt / 1000).toFixed(1);

  if (using3D && tiles3D.tilesRenderer) {
    const tr = tiles3D.tilesRenderer;
    // Some plugins might affect stats or cache structure, safe access:
    const visible = tr.visibleTiles?.size ?? tr.visibleTiles?.length ?? 0;
    const loading = tr.stats?.downloading ?? 0;
    const downloaded = tr.stats?.downloaded ?? 0;
    
    infoEl.textContent = `FPS: ${fps} | Alt: ${altKm}km | Tiles: ${visible} | Loading: ${loading}`;
  } else {
    const zoom = tileManager2D.lodManager.getDesiredZoom(alt / 1000);
    infoEl.textContent = `FPS: ${fps} | Alt: ${altKm}km | Zoom: ${zoom} | Active: ${tileManager2D.activeTiles.size}`;
  }
}

animate();
