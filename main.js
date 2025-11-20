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
const tileMaterialCache = new Map(); // key -> { material, texture, canvas, ... }
const visibleTilesSet = new Set();   // keys currently enabled
const fadingTiles = new Set();       // Tiles currently cross-fading

let currentTileZoom = 4;
let loadingPaused = false;
let lastUpdate = 0;
let currentLoads = 0;

// Shader for cross-fading
const tileVertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const tileFragmentShader = `
  uniform sampler2D uTexture;
  uniform sampler2D uNewTexture;
  uniform float uMix;
  uniform int uHasNew;
  varying vec2 vUv;

  void main() {
    vec4 tex1 = texture2D(uTexture, vUv);
    if (uHasNew == 1) {
      vec4 tex2 = texture2D(uNewTexture, vUv);
      gl_FragColor = mix(tex1, tex2, uMix);
    } else {
      gl_FragColor = tex1;
    }
  }
`;

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

  // Initialize with black, but immediately try to inherit
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

  inheritFromParentTile(z, x, y, canvasTex);

  const texture = new THREE.CanvasTexture(canvasTex);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;

  // Shader Material for cross-fading
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTexture: { value: texture },
      uNewTexture: { value: null },
      uMix: { value: 0.0 },
      uHasNew: { value: 0 }
    },
    vertexShader: tileVertexShader,
    fragmentShader: tileFragmentShader,
    side: THREE.FrontSide
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.visible = false;

  scene.add(mesh);
  tileMeshCache.set(key, mesh);
  tileMaterialCache.set(key, { material, texture, canvas: canvasTex });

  return mesh;
}

// Recursive inheritance from parent tile
function inheritFromParentTile(z, x, y, childCanvas) {
  // Walk up the tree until we find a loaded parent or hit base zoom
  let pZ = z - 1;
  let pX = Math.floor(x / 2);
  let pY = Math.floor(y / 2);

  // Track the sub-region we need from the parent
  // At each step up, we are one of 4 quadrants.
  // We need to accumulate the offset and scale.
  // Let's do it simply: find the nearest ancestor, then compute the relative crop.

  while (pZ >= 4) { // Base zoom is 4
    const parentKey = `${pZ}/${pX}/${pY}`;
    const parentRec = tileMaterialCache.get(parentKey);

    // Check if parent has a valid image loaded (not just a black placeholder)
    // We use tileImageCache as a proxy for "has content"
    if (parentRec && parentRec.canvas && tileImageCache.has(parentKey)) {
      // Found a parent!
      // Calculate the crop rect.
      // The child (z, x, y) covers a portion of the parent (pZ, pX, pY).
      // The scale factor is 2^(z - pZ).
      const scale = Math.pow(2, z - pZ);
      const tileSize = TEXTURE_SIZE;

      // The child's global coordinates relative to the parent's origin at zoom z:
      // Parent's range at zoom z is [pX * scale, (pX+1) * scale]
      // Child is at x.
      // So offset is (x - pX * scale).
      const offsetX = x - pX * scale;
      const offsetY = y - pY * scale;

      // Source rect in parent canvas (which is 256x256)
      // The parent represents 1 unit. The child represents 1/scale units.
      // So we take a chunk of size (tileSize / scale).
      const sWidth = tileSize / scale;
      const sHeight = tileSize / scale;
      const sx = offsetX * sWidth;
      const sy = offsetY * sHeight;

      const ctx = childCanvas.getContext("2d");
      ctx.drawImage(
        parentRec.canvas,
        sx,
        sy,
        sWidth,
        sHeight,
        0,
        0,
        tileSize,
        tileSize
      );
      return;
    }

    pZ--;
    pX = Math.floor(pX / 2);
    pY = Math.floor(pY / 2);
  }
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

  // Create a new texture for the loaded image
  const newTexture = new THREE.Texture(img);
  newTexture.needsUpdate = true;
  // Match settings
  newTexture.wrapS = THREE.ClampToEdgeWrapping;
  newTexture.wrapT = THREE.ClampToEdgeWrapping;
  newTexture.minFilter = THREE.LinearMipmapLinearFilter;
  newTexture.magFilter = THREE.LinearFilter;
  newTexture.generateMipmaps = true;

  // Start cross-fade
  const { material } = rec;
  material.uniforms.uNewTexture.value = newTexture;
  material.uniforms.uHasNew.value = 1;
  material.uniforms.uMix.value = 0.0;

  fadingTiles.add(key);
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
// Inverse helpers for tile selection
function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

function latToTileY(lat, z) {
  const latRad = (lat * Math.PI) / 180;
  const n = Math.pow(2, z);
  // Inverse of the tileYToLat math:
  // y = (N / 2) * (1 - asinh(tan(lat)) / PI)
  // asinh(x) = log(x + sqrt(x^2 + 1))
  const val = Math.tan(latRad);
  const asinh = Math.log(val + Math.sqrt(val * val + 1));
  return Math.floor((n / 2) * (1 - asinh / Math.PI));
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

  // Optimization: Only check tiles within the visible horizon
  // If z is low, just check everything (it's cheap and math might be unstable for full globe)
  let xMin = 0, xMax = n - 1;
  let yMin = 0, yMax = n - 1;

  if (z > 6) {
    // 1. Calculate camera lat/lon
    // phi is angle from North Pole (Y axis)
    const camLat = 90 - (phi * 180) / Math.PI;
    // theta is angle around Y axis. 
    // Based on lonLatToVector3 and updateCameraFromControls correlation:
    // Camera: x = r sin(phi) cos(theta), z = r sin(phi) sin(theta)
    // Tile:   x = -r cos(lat) cos(lon),  z = r cos(lat) sin(lon)
    // (where sin(phi) ~ cos(lat))
    // So we need: cos(theta) = -cos(lon) AND sin(theta) = sin(lon)
    // This implies lon = 180 - theta (in degrees)
    let camLon = 180 - (theta * 180) / Math.PI;
    // Normalize lon to -180..180
    while (camLon > 180) camLon -= 360;
    while (camLon < -180) camLon += 360;

    // 2. Calculate horizon angle (alpha)
    // cos(alpha) = R / (R + h) = R / radius
    // Clamp radius to avoid NaN if somehow inside earth
    const safeRadius = Math.max(RADIUS + 0.001, radius);
    const alphaRad = Math.acos(RADIUS / safeRadius);
    const alphaDeg = (alphaRad * 180) / Math.PI;

    // 3. Determine lat/lon bounds with a safety buffer (1.5x horizon)
    const buffer = 1.5;
    const latSpan = alphaDeg * buffer;

    // If we are too close to poles, the longitude span blows up, so just check all X
    if (Math.abs(camLat) + latSpan > 85) {
      // Near pole: check all X, restrict Y
      yMin = Math.max(0, latToTileY(Math.min(85, camLat + latSpan), z));
      yMax = Math.min(n - 1, latToTileY(Math.max(-85, camLat - latSpan), z));
    } else {
      // Normal case
      const latMin = camLat - latSpan;
      const latMax = camLat + latSpan;

      // Longitude span depends on latitude (1/cos(lat))
      // Use the max latitude involved (closest to pole) for conservative bound
      const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax));
      const cosLat = Math.cos((maxAbsLat * Math.PI) / 180);
      const lonSpan = latSpan / Math.max(0.1, cosLat); // avoid div by zero

      const lonMin = camLon - lonSpan;
      const lonMax = camLon + lonSpan;

      // Convert to tile coords
      // Note: yMin corresponds to latMax (North), yMax to latMin (South)
      yMin = Math.max(0, latToTileY(latMax, z));
      yMax = Math.min(n - 1, latToTileY(latMin, z));

      // X can wrap, so we don't clamp yet. We handle wrapping in the loop.
      xMin = lonToTileX(lonMin, z);
      xMax = lonToTileX(lonMax, z);
    }
  }

  // Iterate over the bounded range
  // Note: xMax can be smaller than xMin if we wrap around date line? 
  // Actually lonToTileX is monotonic for -180..180? 
  // No, if lonMin < -180, lonToTileX gives negative.
  // We should normalize loop logic.

  let checked = 0;
  for (let y = yMin; y <= yMax; y++) {
    for (let xRaw = xMin; xRaw <= xMax; xRaw++) {
      checked++;
      // Handle wrapping
      const x = ((xRaw % n) + n) % n;

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
    // If already exists, just ensure visible
    if (tileMeshCache.has(tile.key)) {
      const mesh = tileMeshCache.get(tile.key);
      mesh.visible = true;
      visibleTilesSet.add(tile.key);

      if (!tileImageCache.has(tile.key)) {
        loadAndApplyTile(tile.z, tile.x, tile.y);
      }
    } else {
      // Queue for creation
      // Avoid adding duplicates to queue
      // (Simple check: if we just cleared queue on zoom change, it's fine. 
      // If we are just panning, we might re-add. 
      // Let's check if it's already in queue? For performance, maybe just a Set of pending keys?)
      // For now, simple push. processTileQueue checks cache before creating.

      // Only queue if not already queued? 
      // We can assume `desired` is unique. 
      // But `updateVisibleTiles` runs every 100ms. 
      // If queue is backing up, we might re-queue same tiles.
      // Let's add a `pendingKeys` set for O(1) check.

      // Actually, let's just check if it's already in visibleTilesSet (which means it's active or being created? No, visibleTilesSet is only added when mesh exists).
      // Let's just push. The `processTileQueue` has a check `if (!tileMeshCache.has(req.key))`.
      // But we don't want the queue to grow infinitely with duplicates.

      // Optimization: Check if already in queue? 
      // `pendingTileCreation` is an array.
      // Let's just trust the `updateVisibleTiles` frequency isn't too high relative to processing speed.
      // Or better, use a Set for pending.

      // Let's use a Set for pending lookups in the global scope?
      // For this iteration, I'll just push and rely on the `processTileQueue` check. 
      // But to avoid queue explosion, I'll limit queue size or clear it?
      // Actually, `updateVisibleTiles` is called every 100ms. 
      // If we process 3 per frame (60fps) -> 180 per second.
      // We should be fine.

      pendingTileCreation.push({ z: tile.z, x: tile.x, y: tile.y, key: tile.key });
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
      // Move camera closer (zoom in)
      const ZOOM_SPEED = 0.2;
      radius = Math.max(RADIUS + 0.007, radius * (1 - ZOOM_SPEED));
    };
  }

  if (zoomOutBtn) {
    zoomOutBtn.onclick = () => {
      // Move camera away (zoom out)
      const ZOOM_SPEED = 0.2;
      radius = Math.min(RADIUS * 5, radius * (1 + ZOOM_SPEED));
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

    const deltaX = lastMouseX - e.clientX;
    const deltaY = e.clientY - lastMouseY;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;

    // Calculate rotation speed for 1:1 drag-to-ground movement
    // 1. Get altitude (distance from surface)
    const altitude = Math.max(0.001, radius - RADIUS);

    // 2. Calculate visible ground height at this altitude
    //    visibleHeight = 2 * altitude * tan(fov / 2)
    const fovRad = (camera.fov * Math.PI) / 180;
    const visibleHeight = 2 * altitude * Math.tan(fovRad / 2);

    // 3. Calculate radians per pixel
    //    angularSize = visibleHeight / RADIUS
    //    radiansPerPixel = angularSize / window.innerHeight
    const radiansPerPixel = visibleHeight / (RADIUS * window.innerHeight);

    theta -= deltaX * radiansPerPixel / Math.sin(phi);
    phi -= deltaY * radiansPerPixel;

    // Clamp vertical angle
    const PHI_MIN = 0.001;
    const PHI_MAX = Math.PI - 0.001;
    phi = Math.max(PHI_MIN, Math.min(PHI_MAX, phi));
  });

  // Wheel zoom (altitude-based)
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const delta = e.deltaY;
      const ZOOM_SPEED = 0.001; // Slower base speed for smoother control

      // Scale altitude instead of total radius
      let altitude = radius - RADIUS;

      // Apply zoom to altitude
      // Using exponential scaling for smooth feel: newAlt = oldAlt * (1 + speed)
      // But for wheel delta which can be large, we might want: newAlt = oldAlt * exp(delta * speed)
      // or just simple multiplication if delta is small. 
      // Let's use simple multiplication but clamped to avoid exploding.

      // Note: delta is usually +/- 100 for mouse wheels, or smaller for trackpads.
      // Normalize delta roughly? 
      // Let's just use the factor approach.

      const factor = 1 + delta * ZOOM_SPEED;
      altitude *= factor;

      // Clamp altitude
      const MIN_ALT = 0.007;
      const MAX_ALT = RADIUS * 4;
      altitude = Math.max(MIN_ALT, Math.min(MAX_ALT, altitude));

      radius = RADIUS + altitude;
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

// Tile creation queue to prevent frame drops
const pendingTileCreation = [];
const MAX_CREATIONS_PER_FRAME = 3;

function processTileQueue() {
  if (pendingTileCreation.length === 0) return;

  // Sort by distance to camera so closest tiles load first
  // (Optional optimization, but good for UX)
  // For now, just FIFO or simple stack is fine, but let's do a quick sort if queue is large?
  // Actually, updateVisibleTiles sorts 'desired' by dot product (visibility), 
  // so if we push in that order, we are good.

  let created = 0;
  while (created < MAX_CREATIONS_PER_FRAME && pendingTileCreation.length > 0) {
    const req = pendingTileCreation.shift();
    // Check if still needed (might have zoomed out while in queue)
    // A simple check is if it's still in visibleTilesSet? 
    // No, visibleTilesSet is for *active* meshes. 
    // We can check if the zoom level is still relevant or if it's far away.
    // For simplicity, just create it. `updateVisibleTiles` runs frequently and will hide/remove it if not needed.

    // Double check we haven't created it yet (race condition?)
    if (!tileMeshCache.has(req.key)) {
      const mesh = createTileMesh(req.z, req.x, req.y);
      mesh.visible = true;
      visibleTilesSet.add(req.key);

      if (!tileImageCache.has(req.key)) {
        loadAndApplyTile(req.z, req.x, req.y);
      }
    }
    created++;
  }
}

// Init sequence
(async function init() {
  await loadBaseZoomTiles();
  await updateVisibleTiles();
  setupEventHandlers();

  function animate(timestamp) {
    requestAnimationFrame(animate);

    updateCameraFromControls();

    // Calculate altitude and update zoom level dynamically
    const altitude = Math.max(0.001, radius - RADIUS);
    // Formula derived to map:
    // Altitude ~64 (Start) -> Zoom 4
    // Altitude ~0.007 (Min) -> Zoom 15
    // z = -1.2 * log(altitude) + 9
    const rawZoom = -1.2 * Math.log(altitude) + 9;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(rawZoom)));

    if (newZoom !== currentTileZoom) {
      currentTileZoom = newZoom;
      // Clear pending queue when zoom changes significantly to avoid backlog of wrong-zoom tiles
      pendingTileCreation.length = 0;

      // Force update if zoom changed
      updateVisibleTiles().catch(console.error);
      lastUpdate = timestamp;
    } else if (!lastUpdate || timestamp - lastUpdate > UPDATE_INTERVAL) {
      updateVisibleTiles().catch(console.error);
      lastUpdate = timestamp;
    }

    // Update fading tiles
    const FADE_SPEED = 0.05; // Adjust for speed
    for (const key of fadingTiles) {
      const rec = tileMaterialCache.get(key);
      if (!rec) {
        fadingTiles.delete(key);
        continue;
      }

      const { material, canvas, texture } = rec;
      material.uniforms.uMix.value += FADE_SPEED;

      if (material.uniforms.uMix.value >= 1.0) {
        // Fade complete
        material.uniforms.uMix.value = 1.0;
        material.uniforms.uHasNew.value = 0;
        fadingTiles.delete(key);

        // Commit the new texture to the canvas so children can inherit it
        // We need to draw the image from uNewTexture back to the canvas.
        // But uNewTexture is a texture, we need the original image.
        // We can get it from tileImageCache.
        const img = tileImageCache.get(key);
        if (img) {
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          // Update the base texture to match the new image
          // We can just update the canvas texture.
          // But wait, uTexture is bound to canvasTex.
          // So updating canvas and setting needsUpdate=true updates uTexture.
          texture.needsUpdate = true;

          // We can dispose the uNewTexture to save memory?
          // Yes, good idea.
          const newTex = material.uniforms.uNewTexture.value;
          if (newTex) newTex.dispose();
          material.uniforms.uNewTexture.value = null;
        }
      }
    }

    processTileQueue();

    renderer.render(scene, camera);
  }

  requestAnimationFrame(animate);
})().catch(console.error);
