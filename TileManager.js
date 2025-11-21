import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import {
    RADIUS,
    MAX_ZOOM,
    GRID_SIZE,
    TEXTURE_SIZE,
    LOAD_LIMIT
} from "./Constants.js";
import {
    tileXToLon,
    tileYToLat,
    lonLatToVector3,
    patchCenterVector,
    lonToTileX,
    latToTileY,
    esriTileURL
} from "./Utils.js";

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
  uniform float uOpacity;
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
    gl_FragColor.a *= uOpacity;
  }
`;

export class TileManager {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;

        this.tileImageCache = new Map();    // key -> HTMLImageElement
        this.tileMeshCache = new Map();     // key -> THREE.Mesh
        this.tileMaterialCache = new Map(); // key -> { material, texture, canvas, ... }
        this.visibleTilesSet = new Set();   // keys currently enabled
        this.fadingTiles = new Set();       // Tiles currently cross-fading

        this.currentLoads = 0;
        this.loadingPaused = false;
        this.pendingTileCreation = [];
        this.MAX_CREATIONS_PER_FRAME = 3;
    }

    // Create tile mesh (Three.js equivalent of Babylon version)
    createTileMesh(z, x, y, baseGrid = GRID_SIZE) {
        const key = `${z}/${x}/${y}`;
        if (this.tileMeshCache.has(key)) return this.tileMeshCache.get(key);

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

        this.inheritFromParentTile(z, x, y, canvasTex);

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
                uOpacity: { value: 1.0 },
                uHasNew: { value: 0 }
            },
            vertexShader: tileVertexShader,
            fragmentShader: tileFragmentShader,
            side: THREE.FrontSide,
            transparent: true,
            depthWrite: false, // Important for layering
            depthTest: true
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;

        this.scene.add(mesh);
        this.tileMeshCache.set(key, mesh);
        this.tileMaterialCache.set(key, { material, texture, canvas: canvasTex });

        return mesh;
    }

    // Recursive inheritance from parent tile
    inheritFromParentTile(z, x, y, childCanvas) {
        // Walk up the tree until we find a loaded parent or hit base zoom
        let pZ = z - 1;
        let pX = Math.floor(x / 2);
        let pY = Math.floor(y / 2);

        while (pZ >= 4) { // Base zoom is 4
            const parentKey = `${pZ}/${pX}/${pY}`;
            const parentRec = this.tileMaterialCache.get(parentKey);

            // Check if parent has a valid image loaded (not just a black placeholder)
            // We use tileImageCache as a proxy for "has content"
            if (parentRec && parentRec.canvas && this.tileImageCache.has(parentKey)) {
                // Found a parent!
                const scale = Math.pow(2, z - pZ);
                const tileSize = TEXTURE_SIZE;

                const offsetX = x - pX * scale;
                const offsetY = y - pY * scale;

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

    // Tile image loading
    async loadTileImage(z, x, y) {
        const key = `${z}/${x}/${y}`;
        if (this.tileImageCache.has(key)) return this.tileImageCache.get(key);

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = esriTileURL(z, y, x);
        });
    }

    // Apply image to tile material
    async loadAndApplyTile(z, x, y) {
        const key = `${z}/${x}/${y}`;
        if (this.tileImageCache.has(key)) return;
        if (this.currentLoads >= LOAD_LIMIT) return;

        this.currentLoads++;
        const img = await this.loadTileImage(z, x, y);
        this.currentLoads--;

        if (!img) return;
        this.tileImageCache.set(key, img);

        const rec = this.tileMaterialCache.get(key);
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

        this.fadingTiles.add(key);
    }

    // Visibility checks
    tileIsVisible(z, x, y) {
        const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
        const tileRadius = (RADIUS * Math.PI) / Math.pow(2, z);

        this.camera.updateMatrix();
        this.camera.updateMatrixWorld();
        this.camera.updateProjectionMatrix();

        const projScreenMatrix = new THREE.Matrix4();
        projScreenMatrix.multiplyMatrices(
            this.camera.projectionMatrix,
            this.camera.matrixWorldInverse
        );

        const frustum = new THREE.Frustum();
        frustum.setFromProjectionMatrix(projScreenMatrix);

        if (!frustum.containsPoint(center)) {
            // quick reject using bounding sphere
            const distance = center.distanceTo(this.camera.position);
            if (distance > tileRadius + RADIUS * 5) {
                return false;
            }
        }

        // Back-face culling for globe: only tiles on camera-facing hemisphere
        const cameraDir = this.camera.position.clone().normalize();
        const tileCenterNorm = patchCenterVector(z, x, y);
        const dot = cameraDir.dot(tileCenterNorm);
        return dot > 0;
    }

    // Helper: hide base zoom tiles when higher zoom tiles are active to avoid co-planar shells
    setBaseTilesVisibility(visible) {
        const baseZoom = 4;
        const shouldBeVisible = !!visible;

        for (const key of this.visibleTilesSet) {
            const parts = key.split("/").map(Number);
            const tileZ = parts[0];
            if (tileZ === baseZoom) {
                const mesh = this.tileMeshCache.get(key);
                if (mesh) {
                    mesh.visible = shouldBeVisible;
                }
            }
        }
    }

    async updateVisibleTiles(fractionalZoom, cameraParams) {
        if (this.loadingPaused) return;

        const lowerZoom = Math.floor(fractionalZoom);
        const upperZoom = Math.ceil(fractionalZoom);
        const mix = fractionalZoom - lowerZoom;

        // Determine which zoom levels we need to render
        const activeZooms = [];
        activeZooms.push({ z: lowerZoom, opacity: 1.0 });

        if (upperZoom > lowerZoom && mix > 0.001) {
            // We are transitioning.
            // Lower zoom stays at opacity 1.0 (background)
            // Upper zoom fades in (opacity = mix)
            activeZooms.push({ z: upperZoom, opacity: mix });
        }

        const baseZoom = 4;

        // Hide base tiles if our lowest active zoom is higher than base
        if (lowerZoom > baseZoom) {
            this.setBaseTilesVisibility(false);
        } else {
            this.setBaseTilesVisibility(true);
        }

        const camNorm = this.camera.position.clone().normalize();
        const desired = [];

        // Helper to gather tiles for a specific zoom level
        const gatherTiles = (z, opacity) => {
            const n = Math.pow(2, z);
            let xMin = 0, xMax = n - 1;
            let yMin = 0, yMax = n - 1;

            if (z > 6 && cameraParams) {
                const { phi, theta, radius } = cameraParams;
                const camLat = 90 - (phi * 180) / Math.PI;
                let camLon = 180 - (theta * 180) / Math.PI;
                while (camLon > 180) camLon -= 360;
                while (camLon < -180) camLon += 360;

                const safeRadius = Math.max(RADIUS + 0.001, radius);
                const alphaRad = Math.acos(RADIUS / safeRadius);
                const alphaDeg = (alphaRad * 180) / Math.PI;

                const buffer = 1.5;
                const latSpan = alphaDeg * buffer;

                if (Math.abs(camLat) + latSpan > 85) {
                    yMin = Math.max(0, latToTileY(Math.min(85, camLat + latSpan), z));
                    yMax = Math.min(n - 1, latToTileY(Math.max(-85, camLat - latSpan), z));
                } else {
                    const latMin = camLat - latSpan;
                    const latMax = camLat + latSpan;
                    const maxAbsLat = Math.max(Math.abs(latMin), Math.abs(latMax));
                    const cosLat = Math.cos((maxAbsLat * Math.PI) / 180);
                    const lonSpan = latSpan / Math.max(0.1, cosLat);

                    const lonMin = camLon - lonSpan;
                    const lonMax = camLon + lonSpan;

                    yMin = Math.max(0, latToTileY(latMax, z));
                    yMax = Math.min(n - 1, latToTileY(latMin, z));

                    xMin = lonToTileX(lonMin, z);
                    xMax = lonToTileX(lonMax, z);
                }
            }

            for (let y = yMin; y <= yMax; y++) {
                for (let xRaw = xMin; xRaw <= xMax; xRaw++) {
                    const x = ((xRaw % n) + n) % n;

                    if (z > baseZoom) {
                        if (!this.tileIsVisible(z, x, y)) continue;
                    }

                    const key = `${z}/${x}/${y}`;
                    const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
                    const dist = center.distanceTo(this.camera.position);
                    const dot = patchCenterVector(z, x, y).dot(camNorm);
                    desired.push({ z, x, y, key, dot, dist, opacity });
                }
            }
        };

        // Gather for all active zooms
        for (const level of activeZooms) {
            if (level.z < 4) continue; // Skip tiles lower than base zoom 4 (handled by Globe.gl)
            gatherTiles(level.z, level.opacity);
        }

        desired.sort((a, b) => b.dot - a.dot);
        const newKeys = new Set(desired.map((t) => t.key));
        const tilesToKeep = new Set(newKeys);
        let needBaseTiles = false;

        // Fallback logic: if a desired tile is not ready, keep its parent visible
        for (const tile of desired) {
            if (!this.tileMeshCache.has(tile.key)) {
                // Tile needs creation. Check if we have a visible parent to keep.
                let pZ = tile.z - 1;
                let pX = Math.floor(tile.x / 2);
                let pY = Math.floor(tile.y / 2);

                while (pZ >= baseZoom) {
                    const parentKey = `${pZ}/${pX}/${pY}`;
                    if (this.visibleTilesSet.has(parentKey)) {
                        tilesToKeep.add(parentKey);
                        if (pZ === baseZoom) {
                            needBaseTiles = true;
                        }
                        break; // Found the immediate visible parent, keep it
                    }
                    pZ--;
                    pX = Math.floor(pX / 2);
                    pY = Math.floor(pY / 2);
                }

                // If we didn't find a visible parent in visibleTilesSet, 
                // check if we need base tiles (implicit fallback)
                if (pZ < baseZoom) {
                    needBaseTiles = true;
                }
            }
        }

        // Re-evaluate base visibility based on fallback needs
        if (lowerZoom > baseZoom && !needBaseTiles) {
            this.setBaseTilesVisibility(false);
        } else {
            this.setBaseTilesVisibility(true);
        }

        // Cleanup old tiles
        for (const key of [...this.visibleTilesSet]) {
            const parts = key.split("/").map(Number);
            const tileZ = parts[0];
            // Only delete if not in tilesToKeep
            // And ensure we don't delete base tiles if we decided to keep them visible via setBaseTilesVisibility
            // (But setBaseTilesVisibility only toggles visibility property, doesn't remove from set. 
            //  Here we remove from set if it's a high-res tile that is no longer needed)

            if (tileZ > baseZoom && !tilesToKeep.has(key)) {
                this.visibleTilesSet.delete(key);
                const mesh = this.tileMeshCache.get(key);
                if (mesh) mesh.visible = false;
            }
        }

        // Create/Update new tiles
        for (const tile of desired) {
            if (this.tileMeshCache.has(tile.key)) {
                const mesh = this.tileMeshCache.get(tile.key);
                mesh.visible = true;
                mesh.renderOrder = tile.z; // Ensure higher zoom draws on top

                // Update opacity
                const rec = this.tileMaterialCache.get(tile.key);
                if (rec && rec.material) {
                    rec.material.uniforms.uOpacity.value = tile.opacity;
                }

                this.visibleTilesSet.add(tile.key);

                if (!this.tileImageCache.has(tile.key)) {
                    this.loadAndApplyTile(tile.z, tile.x, tile.y);
                }
            } else {
                this.pendingTileCreation.push({
                    z: tile.z,
                    x: tile.x,
                    y: tile.y,
                    key: tile.key,
                    opacity: tile.opacity
                });
            }
        }
    }

    processTileQueue() {
        if (this.pendingTileCreation.length === 0) return;

        let created = 0;
        while (created < this.MAX_CREATIONS_PER_FRAME && this.pendingTileCreation.length > 0) {
            const req = this.pendingTileCreation.shift();

            if (!this.tileMeshCache.has(req.key)) {
                const mesh = this.createTileMesh(req.z, req.x, req.y);
                mesh.visible = true;
                mesh.renderOrder = req.z;

                const rec = this.tileMaterialCache.get(req.key);
                if (rec && rec.material) {
                    rec.material.uniforms.uOpacity.value = req.opacity !== undefined ? req.opacity : 1.0;
                }

                this.visibleTilesSet.add(req.key);

                if (!this.tileImageCache.has(req.key)) {
                    this.loadAndApplyTile(req.z, req.x, req.y);
                }
            }
            created++;
        }
    }

    async loadBaseZoomTiles() {
        const z = 4;
        const n = Math.pow(2, z);

        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                const key = `${z}/${x}/${y}`;
                const mesh = this.createTileMesh(z, x, y);
                mesh.visible = true;
                this.visibleTilesSet.add(key);

                if (!this.tileImageCache.has(key)) {
                    this.loadAndApplyTile(z, x, y);
                }
            }
        }
    }

    updateFadingTiles() {
        // Process fading tiles
        const FADE_SPEED = 0.05;
        for (const key of this.fadingTiles) {
            const rec = this.tileMaterialCache.get(key);
            if (!rec) {
                this.fadingTiles.delete(key);
                continue;
            }

            const { material } = rec;
            if (material.uniforms.uHasNew.value === 1) {
                material.uniforms.uMix.value += FADE_SPEED;
                if (material.uniforms.uMix.value >= 1.0) {
                    material.uniforms.uMix.value = 1.0;
                    // Swap textures
                    material.uniforms.uTexture.value = material.uniforms.uNewTexture.value;
                    material.uniforms.uNewTexture.value = null;
                    material.uniforms.uHasNew.value = 0;
                    this.fadingTiles.delete(key);
                }
            }
        }
    }
}
