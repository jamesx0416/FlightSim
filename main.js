import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GlobeManager from './globe/GlobeManager.js';
import LODManager from './lod/LODManager.js';
import TileCache from './tiles/TileCache.js';
import { GlobeControls } from './globe/GlobeControls.js';
import { Profiler } from './perf/Profiler.js';

console.log('Flight Sim Initializing...');

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100000);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// Lighting
const ambientLight = new THREE.AmbientLight(0xbbbbbb);
scene.add(ambientLight);
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.6);
directionalLight.position.set(1, 1, 1);
scene.add(directionalLight);

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.enableRotate = false; // Disable OrbitControls rotation to use GlobeControls
controls.enablePan = false; // Usually good to disable pan for globe view

// Managers
const tileCache = new TileCache({ maxEntries: 256, concurrency: 8 });
const profiler = new Profiler();

const globeManager = new GlobeManager({
    scene,
    renderer,
    // Using a public tile server for testing (OpenStreetMap or similar, but we need spherical projection support ideally)
    // Esri Satellite is good.
    tileServerUrl: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
});

await globeManager.init();

// Setup LOD Manager
const lodManager = new LODManager({
    camera,
    globeRadius: globeManager.radius,
    onZoomLevelChanged: (newZoom) => {
        console.log(`Zoom level changed to ${newZoom}`);
        globeManager.setTargetZoom(newZoom);
    }
});

// Camera initial position
camera.position.z = 200; // Start further out
camera.position.y = 100;
camera.lookAt(0, 0, 0);

// Globe Controls (Absolute Drag)
const globeControls = new GlobeControls(camera, renderer.domElement, globeManager.globeGroup);

let lastTime = performance.now();

function animate() {
    requestAnimationFrame(animate);

    const now = performance.now();
    const dt = (now - lastTime) / 1000;
    lastTime = now;

    lodManager.update();

    // Dynamic control speeds based on altitude
    const alt = lodManager.getAltitude();
    // Base speed factors - tune these
    // At high altitude (e.g. 20000), we want fast zoom/rotate
    // At low altitude (e.g. 1), we want slow zoom/rotate
    // Radius is ~100.

    // Normalize altitude by radius for a scale factor
    const minAlt = 0.1; // Prevent 0
    const normalizedAlt = Math.max(alt, minAlt) / globeManager.radius;

    // Zoom speed: proportional to altitude
    controls.zoomSpeed = normalizedAlt * 1.0;

    // Rotate speed: proportional to altitude to keep 1:1 feeling
    // Default rotateSpeed is 1.0.
    // We want dragging the mouse X pixels to move the globe surface X pixels.
    // Arc length s = r * theta.
    // We want s to match mouse movement.
    // OrbitControls rotation is in radians.
    // If we move mouse 100px, that's a fraction of screen width.
    // Roughly, we want lower speed at lower altitude.
    // controls.rotateSpeed = normalizedAlt * 0.5; // Tune this factor -- DISABLED for GlobeControls

    controls.update();

    // Update globe (and tiles)
    // We pass tileCache so it can load textures
    globeManager.update(camera, tileCache);

    // Update profiler
    profiler.update({
        zoom: lodManager.getCurrentZoom(),
        tilesLoaded: globeManager.tilesGroup ? globeManager.tilesGroup.children.length : 0,
        activeRequests: tileCache.activeRequests,
        memory: 'TODO'
    });

    renderer.render(scene, camera);
}

animate();

// Window resize handler
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});
