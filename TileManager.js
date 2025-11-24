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
    esriTileURL
} from "./Utils.js";
import { LODManager } from "./LODManager.js";
import { TileCache } from "./TileCache.js";


export class TileManager {
    constructor(scene, camera) {
        this.scene = scene;
        this.camera = camera;

        this.lodManager = new LODManager();
        this.tileCache = new TileCache(5000, (mesh) => {
            if (mesh) {
                this.scene.remove(mesh);
            }
        });

        this.currentLoads = 0;
        this.loadingPaused = false;

        // Priority Queue for loading: Array of { priority, action }
        this.loadQueue = [];
        this.MAX_LOADS_PER_FRAME = 2; // Process a few loads per frame

        // Track currently rendered tiles to avoid flickering
        this.activeTiles = new Set();
    }

    // Main update loop called from animation frame
    update() {
        if (this.loadingPaused) return;

        // 1. Determine which tiles should be visible
        const desiredTiles = new Map(); // key -> { z, x, y, dist }

        // Start from base zoom level (4)
        const baseZoom = 4;
        const n = Math.pow(2, baseZoom);

        // Safety: Limit total tiles to prevent infinite recursion/hangs
        this.tilesProcessed = 0;
        this.MAX_TILES_PER_FRAME = 5000; // Increased limit

        // We can optimize this by only checking base tiles in frustum, 
        // but for now iterating all base tiles (16x16=256) is fast enough.
        let traversalComplete = true;
        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                this.processTile(baseZoom, x, y, desiredTiles);
                if (this.tilesProcessed > this.MAX_TILES_PER_FRAME) {
                    traversalComplete = false;
                    break;
                }
            }
            if (!traversalComplete) break;
        }

        // 2. Reconcile with active scene
        // CRITICAL: Only reconcile if we completed the traversal.
        // Otherwise we might wipe out the whole scene because desiredTiles is incomplete.
        if (traversalComplete) {
            this.reconcileTiles(desiredTiles);
        } else {
            console.warn("Tile limit reached, skipping update to prevent black tiles.");
        }

        // 3. Process load queue
        this.processLoadQueue();
    }

    // Recursive Quadtree traversal
    processTile(z, x, y, desiredTiles) {
        this.tilesProcessed++;
        if (this.tilesProcessed > this.MAX_TILES_PER_FRAME) return;

        // 1. Frustum Culling
        if (!this.tileIsVisible(z, x, y)) return;

        // 2. LOD Check
        let shouldSplit = this.lodManager.shouldSplit(z, x, y, this.camera.position);

        // Progressive Loading: Enforce checkpoints
        // Don't split further until the current level is loaded.
        // We skip every other level (step = 2) to speed up the dive while maintaining visuals.
        if (shouldSplit) {
            const PROGRESSIVE_STEP = 2;
            if (z % PROGRESSIVE_STEP === 0) {
                const key = `${z}/${x}/${y}`;
                // We need to check the cache directly. 
                // Note: We don't use this.tileCache.get(key) because it promotes the tile (LRU side effect),
                // which is fine, but we strictly want to know if it's *loaded*.
                const mesh = this.tileCache.get(key);

                // If the tile isn't in memory OR isn't fully loaded yet, stop splitting.
                // This forces us to render THIS tile and queue it for loading.
                if (!mesh || !mesh.userData.loaded) {
                    shouldSplit = false;
                }
            }
        }

        if (shouldSplit) {
            // Split into 4 children
            const nextZ = z + 1;
            const nextX = x * 2;
            const nextY = y * 2;

            this.processTile(nextZ, nextX, nextY, desiredTiles);
            this.processTile(nextZ, nextX + 1, nextY, desiredTiles);
            this.processTile(nextZ, nextX, nextY + 1, desiredTiles);
            this.processTile(nextZ, nextX + 1, nextY + 1, desiredTiles);
        } else {
            // Leaf node: this tile should be rendered
            const key = `${z}/${x}/${y}`;
            const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
            const dist = center.distanceTo(this.camera.position);
            desiredTiles.set(key, { z, x, y, dist, key });
        }
    }

    reconcileTiles(desiredTiles) {
        // Remove tiles that are no longer desired
        for (const key of this.activeTiles) {
            if (!desiredTiles.has(key)) {
                const mesh = this.tileCache.get(key);
                if (mesh) {
                    mesh.visible = false;
                    // We don't dispose immediately, let cache handle eviction
                }
                this.activeTiles.delete(key);
            }
        }

        // Add new tiles
        for (const [key, data] of desiredTiles) {
            if (!this.activeTiles.has(key)) {
                let mesh = this.tileCache.get(key);

                if (!mesh) {
                    // Create mesh if not in cache
                    mesh = this.createTileMesh(data.z, data.x, data.y);
                    this.tileCache.add(key, mesh);

                    // Queue texture load
                    this.queueLoad(data.z, data.x, data.y, data.dist);
                }

                mesh.visible = true;
                this.activeTiles.add(key);
            }
        }
    }

    queueLoad(z, x, y, dist) {
        const key = `${z}/${x}/${y}`;
        // Priority: smaller distance = higher priority
        this.loadQueue.push({
            key,
            z, x, y,
            dist,
            priority: -dist
        });
    }

    processLoadQueue() {
        if (this.loadQueue.length === 0) return;

        // Recalculate priorities based on current camera position
        // This fixes the "stale priority" issue where tiles queued long ago (when close)
        // retain high priority even after moving away.
        const cameraPos = this.camera.position;
        for (const req of this.loadQueue) {
            const center = patchCenterVector(req.z, req.x, req.y).multiplyScalar(RADIUS);
            const dist = center.distanceTo(cameraPos);
            req.priority = -dist; // Closer = Higher Priority
        }

        // Sort by priority (closest first)
        this.loadQueue.sort((a, b) => b.priority - a.priority);

        let loads = 0;
        // Increased load limit to prevent stalls
        const MAX_LOADS = 6;

        // We only start new loads if we are under the global limit
        while (this.currentLoads < LOAD_LIMIT && loads < MAX_LOADS && this.loadQueue.length > 0) {
            const req = this.loadQueue.shift();

            // Check if tile is still needed (might have been culled while waiting)
            if (!this.activeTiles.has(req.key)) continue;

            // Check if already loaded (might be in cache from previous session)
            const mesh = this.tileCache.get(req.key);
            if (mesh && mesh.userData.loaded) continue;

            this.loadAndApplyTile(req.z, req.x, req.y);
            loads++;
        }
    }

    // Create tile mesh (Three.js equivalent of Babylon version)
    createTileMesh(z, x, y, baseGrid = GRID_SIZE) {
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
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
        geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
        geometry.setIndex(indices);
        geometry.computeBoundingSphere();

        // Base material + dynamic texture via canvas
        const canvasTex = document.createElement("canvas");
        canvasTex.width = TEXTURE_SIZE;
        canvasTex.height = TEXTURE_SIZE;
        const ctx = canvasTex.getContext("2d");

        // Initialize with black/placeholder
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

        // Try to inherit from parent
        this.inheritFromParentTile(z, x, y, canvasTex);

        const texture = new THREE.CanvasTexture(canvasTex);
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        texture.minFilter = THREE.LinearMipmapLinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = true;
        texture.colorSpace = THREE.SRGBColorSpace;

        const material = new THREE.MeshBasicMaterial({
            map: texture,
            side: THREE.FrontSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        mesh.userData = { loaded: false }; // Track if real image is loaded

        this.scene.add(mesh);
        return mesh;
    }

    // Recursive inheritance from parent tile
    inheritFromParentTile(z, x, y, childCanvas) {
        let pZ = z - 1;
        let pX = Math.floor(x / 2);
        let pY = Math.floor(y / 2);

        while (pZ >= 4) {
            const parentKey = `${pZ}/${pX}/${pY}`;
            const parentMesh = this.tileCache.get(parentKey);

            if (parentMesh && parentMesh.userData.loaded && parentMesh.material.map.image) {
                // Found a parent with a loaded image
                const parentImage = parentMesh.material.map.image; // This is likely the HTMLImageElement or Canvas

                const scale = Math.pow(2, z - pZ);
                const tileSize = TEXTURE_SIZE;

                const offsetX = x - pX * scale;
                const offsetY = y - pY * scale;

                const sWidth = tileSize / scale;
                const sHeight = tileSize / scale;
                const sx = offsetX * sWidth;
                const sy = offsetY * sHeight;

                const ctx = childCanvas.getContext("2d");
                // Draw from parent source
                // Note: parentImage might be a CanvasTexture's image (canvas) or a loaded Image
                ctx.drawImage(parentImage, sx, sy, sWidth, sHeight, 0, 0, tileSize, tileSize);
                return;
            }

            pZ--;
            pX = Math.floor(pX / 2);
            pY = Math.floor(pY / 2);
        }
    }

    async loadTileImage(z, x, y) {
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = esriTileURL(z, y, x);
        });
    }

    async loadAndApplyTile(z, x, y) {
        const key = `${z}/${x}/${y}`;

        this.currentLoads++;
        const img = await this.loadTileImage(z, x, y);
        this.currentLoads--;

        if (!img) return;

        // Re-fetch mesh from cache (it might have been evicted while loading!)
        const mesh = this.tileCache.get(key);
        if (!mesh) return; // Tile was evicted, discard result

        // Update texture
        const texture = mesh.material.map;
        texture.image = img; // Replace canvas with actual image
        texture.needsUpdate = true;
        mesh.userData.loaded = true;
    }

    tileIsVisible(z, x, y) {
        const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
        const tileRadius = (RADIUS * Math.PI) / Math.pow(2, z);

        // Simple frustum check
        // Note: camera matrices should be updated by main loop before calling update()
        const frustum = new THREE.Frustum();
        const projScreenMatrix = new THREE.Matrix4();
        projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        frustum.setFromProjectionMatrix(projScreenMatrix);

        // Better Frustum Check: intersectsSphere
        // This correctly accounts for tile size and provides a scalable buffer.
        // We expand the sphere by a factor (e.g. 1.5) to create the "just off-screen" buffer.
        const bufferFactor = 1.5;
        const sphere = new THREE.Sphere(center, tileRadius * bufferFactor);

        if (!frustum.intersectsSphere(sphere)) {
            // If the expanded sphere is not in the frustum, cull it.
            // But we might want to keep tiles VERY close to camera even if "behind" (to avoid clipping when rotating fast)
            // So we keep the simple distance check but make it very tight (e.g. 2x tile radius)
            const dist = center.distanceTo(this.camera.position);
            if (dist > tileRadius * 2.0) {
                return false;
            }
        }

        // Back-face culling
        const cameraDir = this.camera.position.clone().normalize();
        const tileCenterNorm = patchCenterVector(z, x, y);
        const dot = cameraDir.dot(tileCenterNorm);
        return dot > -0.2; // Allow slightly back-facing tiles for horizon correctness
    }

    // Helper for init
    async loadBaseZoomTiles() {
        // No-op in new system, update() handles everything
    }
}
