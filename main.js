import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";

const canvas = document.getElementById("renderCanvas");

// Core constants (mirroring Babylon setup)
const RADIUS = 63.71;
const MAX_ZOOM = 15;
const MIN_ZOOM = 4;
const LOAD_LIMIT = 5;        // Max concurrent tile loads
const UPDATE_INTERVAL = 100; // ms between visibility updates
const GRID_SIZE = 48;
const TEXTURE_SIZE = 256;
const STARTING_RADIUS = RADIUS * 2;

// Esri imagery endpoint
const esriTileURL = (z, y, x) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Tile helpers (same math as Babylon version)
const tileXToLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;

const tileYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

function lonLatToVector3(lon, lat, radius = RADIUS, offset = 1) {
  const latR = (lat * Math.PI) / 180;
  const lonR = (lon * Math.PI) / 180;
  const cosLat = Math.cos(latR);

  // Flip X to correct horizontal orientation relative to original Babylon implementation
  return new THREE.Vector3(
    -radius * cosLat * Math.cos(lonR) * offset,
    radius * Math.sin(latR) * offset,
    radius * cosLat * Math.sin(lonR) * offset
  );
}

function patchCenterVector(z, x, y) {
  const lon = (tileXToLon(x, z) + tileXToLon(x + 1, z)) / 2;
  const lat = (tileYToLat(y, z) + tileYToLat(y + 1, z)) / 2;
  return lonLatToVector3(lon, lat, 1).normalize();
}

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

// Position camera similar to Babylon ArcRotateCamera initial state
const initialPhi = Math.PI / 2.4; // polar
const initialTheta = Math.PI / 2; // azimuthal
camera.position.copy(
  new THREE.Vector3(
    STARTING_RADIUS * Math.cos(initialPhi) * Math.cos(initialTheta),
    STARTING_RADIUS * Math.sin(initialPhi),
    STARTING_RADIUS * Math.cos(initialPhi) * Math.sin(initialTheta)
  )
);
camera.lookAt(0, 0, 0);

// Basic controls (manual orbit + wheel zoom)
let isDragging = false;
let lastMouseX = 0;
let lastMouseY = 0;
let theta = initialTheta;
let phi = initialPhi;
let radius = STARTING_RADIUS;

const target = new THREE.Vector3(0, 0, 0);

// Lights
{
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 0.9);
  scene.add(hemi);
}

// Tile caches and state
const tileImageCache = new Map();    // key -> HTMLImageElement
const tileMeshCache = new Map();     // key -> THREE.Mesh
const tileMaterialCache = new Map(); // key -> THREE.MeshStandardMaterial or MeshBasicMaterial
const visibleTilesSet = new Set();   // keys currently enabled

let currentTileZoom = 4;
let loadingPaused = false;
let lastUpdate = 0;
let currentLoads = 0;

// Create tile mesh (Three.js equivalent of Babylon version)
function createTileMesh(z, x, y, baseGrid = GRID_SIZE) {
  const key = `${z}/${x}/${y}`;
  if (tileMeshCache.has(key)) return tileMeshCache.get(key);

  // Dynamic grid resolution based on zoom
  const grid = Math.max(8, Math.floor(baseGrid * (z / MAX_ZOOM)));

  const lonMin = tileXToLon(x, z);
  const lonMax = tileXToLon(x + 1, z);
  const latMax = tileYToLat(y, z);
  const latMin = tileYToLat(y + 1, z);

  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const rowVerts = grid + 1;

  // Slightly inset UVs at higher zooms to avoid edge bleeding between tiles.
  // At lower zooms keep full 0..1 for accuracy.
  const uvInset = z >= 5 ? (0.5 / TEXTURE_SIZE) : 0.0;

  for (let j = 0; j <= grid; j++) {
    const v = j / grid;
    const lat = latMax + (latMin - latMax) * v;
    for (let i = 0; i <= grid; i++) {
      const u = i / grid;
      const lon = lonMin + (lonMax - lonMin) * u;

      const pos = lonLatToVector3(lon, lat, RADIUS, 1);
      positions.push(pos.x, pos.y, pos.z);

      const n = pos.clone().normalize();
      normals.push(n.x, n.y, n.z);

      // Apply inset only when enabled to keep shared edges aligned and reduce seams
      const uu = uvInset ? THREE.MathUtils.lerp(uvInset, 1 - uvInset, u) : u;
      const vv = uvInset ? THREE.MathUtils.lerp(uvInset, 1 - uvInset, 1 - v) : 1 - v;
      uvs.push(uu, vv);
    }
  }

  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      const a = j * rowVerts + i;
      const b = a + 1;
      const c = a + rowVerts;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3)
  );
  geometry.setAttribute(
    "normal",
    new THREE.Float32BufferAttribute(normals, 3)
  );
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();

  // Base material + dynamic texture via canvas
  const canvasTex = document.createElement("canvas");
  canvasTex.width = TEXTURE_SIZE;
  canvasTex.height = TEXTURE_SIZE;
  const ctx = canvasTex.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  const texture = new THREE.CanvasTexture(canvasTex);
  // Use clamp-to-edge + mipmaps to reduce sampling from neighbouring tiles
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;

  inheritFromParentTile(z, x, y, canvasTex);

  // Use front side: lonLatToVector3 already flipped X so tiles face outward correctly
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  scene.add(mesh);
  tileMeshCache.set(key, mesh);
  tileMaterialCache.set(key, { material, texture, canvas: canvasTex });

  return mesh;
}

// Inherit from parent tile (similar to Babylon dynamicTexture approach)
function inheritFromParentTile(z, x, y, childCanvas) {
  const parentZoom = z - 1;
  if (parentZoom < 0) return;

  const parentX = Math.floor(x / 2);
  const parentY = Math.floor(y / 2);
  const parentKey = `${parentZoom}/${parentX}/${parentY}`;
  const parentRec = tileMaterialCache.get(parentKey);
  if (!parentRec || !parentRec.canvas) return;

  const parentCanvas = parentRec.canvas;
  const parentSize = parentCanvas.width;
  const sx = (x % 2) * (parentSize / 2);
  const sy = (y % 2) * (parentSize / 2);
  const sWidth = parentSize / 2;
  const sHeight = parentSize / 2;

  const ctx = childCanvas.getContext("2d");
  ctx.drawImage(
    parentCanvas,
    sx,
    sy,
    sWidth,
    sHeight,
    0,
    0,
    childCanvas.width,
    childCanvas.height
  );
}

// Visibility checks
function tileIsVisible(z, x, y) {
  const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
  const tileRadius = (RADIUS * Math.PI) / Math.pow(2, z);

  camera.updateMatrix();
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();

  const projScreenMatrix = new THREE.Matrix4();
  projScreenMatrix.multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse
  );

  const frustum = new THREE.Frustum();
  frustum.setFromProjectionMatrix(projScreenMatrix);

  if (!frustum.containsPoint(center)) {
    // quick reject using bounding sphere
    const distance = center.distanceTo(camera.position);
    if (distance > tileRadius + RADIUS * 5) {
      return false;
    }
  }

  // Back-face culling for globe: only tiles on camera-facing hemisphere
  const cameraDir = camera.position.clone().normalize();
  const tileCenterNorm = patchCenterVector(z, x, y);
  const dot = cameraDir.dot(tileCenterNorm);
  return dot > 0;
}

// Tile image loading
async function loadTileImage(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileImageCache.has(key)) return tileImageCache.get(key);

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = esriTileURL(z, y, x);
  });
}

// Apply image to tile material
async function loadAndApplyTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (tileImageCache.has(key)) return;
  if (currentLoads >= LOAD_LIMIT) return;

  currentLoads++;
  const img = await loadTileImage(z, x, y);
  currentLoads--;

  if (!img) return;
  tileImageCache.set(key, img);

  const rec = tileMaterialCache.get(key);
  if (!rec) return;

  const { canvas, texture } = rec;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  texture.needsUpdate = true;
}

// Base zoom initialization (z=4 tiles persistent)
async function loadBaseZoomTiles() {
  const z = 4;
  const n = Math.pow(2, z);

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const key = `${z}/${x}/${y}`;
      const mesh = createTileMesh(z, x, y);
      mesh.visible = true;
      visibleTilesSet.add(key);

      if (!tileImageCache.has(key)) {
        // Fire and forget
        loadAndApplyTile(z, x, y);
      }
    }
  }
}

// Helper: hide base zoom tiles when higher zoom tiles are active to avoid co-planar shells
function setBaseTilesVisibility(visible) {
  const baseZoom = 4;
  const shouldBeVisible = !!visible;

  for (const key of visibleTilesSet) {
    const parts = key.split("/").map(Number);
    const tileZ = parts[0];
    if (tileZ === baseZoom) {
      const mesh = tileMeshCache.get(key);
      if (mesh) {
        mesh.visible = shouldBeVisible;
      }
    }
  }
}

// Update info UI
function updateInfoDisplay(z) {
  const infoElement = document.getElementById("info");
  if (!infoElement) return;

  infoElement.textContent =
    `tile zoom ${z}, visible ${visibleTilesSet.size}, ` +
    `cached ${tileImageCache.size}, concurrent ${currentLoads}`;
}

// Compute visible tiles and update scene
async function updateVisibleTiles() {
  if (loadingPaused) return;

  const z = currentTileZoom;
  const baseZoom = 4;
  const n = Math.pow(2, z);

  const camNorm = camera.position.clone().normalize();
  const desired = [];

  // When we move beyond base zoom, hide the base-zoom shell to avoid co-planar overlap
  if (z > baseZoom) {
    setBaseTilesVisibility(false);
  } else {
    setBaseTilesVisibility(true);
  }

  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      if (z > baseZoom) {
        if (!tileIsVisible(z, x, y)) continue;
      }

      const key = `${z}/${x}/${y}`;
      const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
      const dist = center.distanceTo(camera.position);
      const dot = patchCenterVector(z, x, y).dot(camNorm);
      desired.push({ z, x, y, key, dot, dist });
    }
  }

  desired.sort((a, b) => b.dot - a.dot);
  const newKeys = new Set(desired.map((t) => t.key));

  // Debug logging: inspect tile positions/UV consistency at zoom 5 to confirm seam source
  if (z === 5) {
    const sampleKeys = Array.from(newKeys).slice(0, 20);
    console.groupCollapsed("Zoom5 Tile Debug");
    console.log("Total desired tiles:", desired.length, "sample keys:", sampleKeys);

    for (const key of sampleKeys) {
      const mesh = tileMeshCache.get(key);
      const matRec = tileMaterialCache.get(key);
      if (!mesh || !mesh.geometry || !matRec) continue;

      const posAttr = mesh.geometry.getAttribute("position");
      const uvAttr = mesh.geometry.getAttribute("uv");

      if (!posAttr || !uvAttr) continue;

      // Log first/last row/column UVs to detect full 0..1 usage and potential bleed
      const vertexCount = posAttr.count;
      const dim = Math.sqrt(vertexCount);
      if (Number.isInteger(dim)) {
        const lastIndex = dim - 1;

        const uv = (ix, iy) => {
          const idx = iy * dim + ix;
          return [uvAttr.getX(idx), uvAttr.getY(idx)];
        };

        console.log(
          `Tile ${key} UV corners`,
          {
            topLeft: uv(0, 0),
            topRight: uv(lastIndex, 0),
            bottomLeft: uv(0, lastIndex),
            bottomRight: uv(lastIndex, lastIndex),
          }
        );
      }

      // Also check that a couple of edge positions line up on the sphere radius
      const p0 = new THREE.Vector3(
        posAttr.getX(0),
        posAttr.getY(0),
        posAttr.getZ(0)
      );
      const p1 = new THREE.Vector3(
        posAttr.getX(vertexCount - 1),
        posAttr.getY(vertexCount - 1),
        posAttr.getZ(vertexCount - 1)
      );

      console.log(`Tile ${key} edge radii`, {
        r0: p0.length(),
        r1: p1.length(),
      });
    }
    console.groupEnd();
  }

  // Hide tiles no longer visible for zoom > baseZoom
  for (const key of [...visibleTilesSet]) {
    const parts = key.split("/").map(Number);
    const tileZ = parts[0];
    if (tileZ > baseZoom && !newKeys.has(key)) {
      visibleTilesSet.delete(key);
      const mesh = tileMeshCache.get(key);
      if (mesh) mesh.visible = false;
    }
  }

  // Show required tiles
  for (const tile of desired) {
    const mesh = createTileMesh(tile.z, tile.x, tile.y);
    mesh.visible = true;
    visibleTilesSet.add(tile.key);

    if (!tileImageCache.has(tile.key)) {
      loadAndApplyTile(tile.z, tile.x, tile.y);
    }
  }

  updateInfoDisplay(z);
}

// UI wiring
function setupEventHandlers() {
  const zoomInBtn = document.getElementById("zoomIn");
  const zoomOutBtn = document.getElementById("zoomOut");
  const pauseToggleBtn = document.getElementById("pauseToggle");

  if (zoomInBtn) {
    zoomInBtn.onclick = () => {
      currentTileZoom = Math.min(MAX_ZOOM, currentTileZoom + 1);
      updateVisibleTiles();
    };
  }

  if (zoomOutBtn) {
    zoomOutBtn.onclick = () => {
      currentTileZoom = Math.max(MIN_ZOOM, currentTileZoom - 1);
      updateVisibleTiles();
    };
  }

  if (pauseToggleBtn) {
    pauseToggleBtn.onclick = () => {
      loadingPaused = !loadingPaused;
      pauseToggleBtn.textContent = loadingPaused
        ? "Resume Loading"
        : "Pause Loading";
    };
  }

  // Mouse drag for orbit
  canvas.addEventListener("mousedown", (e) => {
    isDragging = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  window.addEventListener("mouseup", () => {
    isDragging = false;
  });

  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;

    // Invert horizontal drag so rotation direction feels natural
    const deltaX = lastMouseX - e.clientX;
    // Use standard orbit feel for vertical: dragging up moves camera toward north pole (decrease phi)
    const deltaY = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    const ROTATE_SPEED = 0.005;
    theta -= deltaX * ROTATE_SPEED;
    // Standard orbit feel:
    // - Drag up (deltaY < 0) -> move toward north pole -> decrease phi
    // - Drag down (deltaY > 0) -> move toward south pole -> increase phi
    phi -= deltaY * ROTATE_SPEED;

    // Clamp vertical angle:
    // Measure phi from north pole: allow from just off north pole down into southern hemisphere.
    const PHI_MIN = 0.001;       // just below exact north pole
    const PHI_MAX = Math.PI; // deep into south, but not exactly antipodal to avoid issues
    phi = Math.max(PHI_MIN, Math.min(PHI_MAX, phi));
  });

  // Wheel zoom (similar to ArcRotateCamera bounds)
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY;
      const ZOOM_SPEED = 0.002;
      radius *= 1 + delta * ZOOM_SPEED;
      radius = Math.max(RADIUS + 0.007, Math.min(RADIUS * 5, radius));
    },
    { passive: false }
  );
}

// Update camera from spherical coords
// phi is measured from the +Y axis (north pole):
//   phi = 0       -> directly above north pole
//   phi = PI/2    -> equator
//   phi -> PI     -> southern hemisphere
function updateCameraFromControls() {
  const x = radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);

  camera.position.set(x, y, z);
  camera.lookAt(target);
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
  await loadBaseZoomTiles();
  await updateVisibleTiles();
  setupEventHandlers();

  function animate(timestamp) {
    requestAnimationFrame(animate);

    updateCameraFromControls();

    if (!lastUpdate || timestamp - lastUpdate > UPDATE_INTERVAL) {
      updateVisibleTiles().catch(console.error);
      lastUpdate = timestamp;
    }

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
})().catch(console.error);
