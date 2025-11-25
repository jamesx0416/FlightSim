import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import {
    RADIUS,
    MAX_ZOOM,
    MIN_ZOOM,
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

        // Web Worker for LOD calculations
        this.worker = new Worker("LODWorker.js", { type: "module" });
        this.workerBusy = false;
        this.worker.onmessage = (e) => {
            if (e.data.type === 'result') {
                this.workerBusy = false;
                // Convert plain objects back to Map for reconcileTiles
                const desiredTiles = new Map();
                for (const t of e.data.desiredTiles) {
                    desiredTiles.set(t.key, t);
                }
                this.reconcileTiles(desiredTiles);
            }
        };

        this.tileCache = new TileCache(5000, (mesh) => {
            if (mesh) {
                this.scene.remove(mesh);
                // Notify worker that this tile is gone
                if (mesh.userData.key) {
                    this.worker.postMessage({ type: 'tileEvicted', key: mesh.userData.key });
                }
            }
        });

        this.currentLoads = 0;
        this.loadingPaused = false;



        // Track currently rendered tiles to avoid flickering
        this.activeTiles = new Set();

        // Reusable objects for render loop
        this.frustum = new THREE.Frustum();
        this.projScreenMatrix = new THREE.Matrix4();
        this._center = new THREE.Vector3();
        this._sphere = new THREE.Sphere();
        this._cameraDir = new THREE.Vector3();
        this._tileCenterNorm = new THREE.Vector3();

        // Throttling
        this.frameCount = 0;
        this.lastSortFrame = 0;
        this.lastCameraPosition = new THREE.Vector3();
        this.cameraMovementThreshold = 1.0; // Units of movement before re-sorting
    }

    // Main update loop called from animation frame
    update() {
        if (this.loadingPaused) return;

        this.frameCount++;

        // Update Frustum once per frame (still useful for other things)
        this.projScreenMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.projScreenMatrix);

        // Offload traversal to worker
        if (!this.workerBusy) {
            this.workerBusy = true;
            this.camera.getWorldDirection(this._cameraDir);

            // Serialize Frustum Planes
            const planes = this.frustum.planes.map(p => [p.normal.x, p.normal.y, p.normal.z, p.constant]);

            this.worker.postMessage({
                type: 'update',
                cameraPosition: this.camera.position,
                cameraDirection: this._cameraDir,
                frustumPlanes: planes
            });
        }

        // 3. Process loading (Stateless)
        this.updateLoading();
    }

    // Recursive Quadtree traversal
    processTile(z, x, y, desiredTiles) {
        this.tilesProcessed++;
        if (this.tilesProcessed > this.MAX_TILES_PER_FRAME) return;

        // 1. Frustum Culling
        if (!this.tileIsVisible(z, x, y)) return;

        // 2. LOD Check
        let shouldSplit = this.lodManager.shouldSplit(z, x, y, this.camera.position);

        // Progressive Loading: Ensure we have SOME tile to show before diving deeper
        // If we don't have a loaded ancestor, we shouldn't split, because the children will be black.
        // We force the system to stop here and load this tile (or a parent) first.
        if (shouldSplit) {
            if (!this.isVisuallyReady(z, x, y)) {
                shouldSplit = false;
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

    // Check if this tile is loaded and ready to display
    // Strict check: Only return true if THIS specific tile is loaded.
    // This forces the traversal to stop at the first unloaded layer, ensuring we load
    // layer 4, then 5, then 6... sequentially (Progressive Loading).
    isVisuallyReady(z, x, y) {
        const key = `${z}/${x}/${y}`;
        const mesh = this.tileCache.get(key);
        return mesh && mesh.userData.loaded;
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

                    // Mesh exists in cache (revived)
                    // No need to queue explicitly, updateLoading will pick it up if !loaded

                }

                mesh.visible = true;
                this.activeTiles.add(key);
            }
        }
    }

    updateLoading() {
        if (this.currentLoads >= LOAD_LIMIT) return;

        // Find candidates
        const candidates = [];
        this.camera.getWorldDirection(this._cameraDir);
        const cameraPos = this.camera.position;

        for (const key of this.activeTiles) {
            const mesh = this.tileCache.get(key);
            if (!mesh) continue;

            // If not loaded and not currently loading, it's a candidate
            if (!mesh.userData.loaded && !mesh.userData.loading) {
                // Calculate Priority
                // 1. Zoom Level (Lower Z = Higher Priority)
                // 2. Center Bias
                // 3. Distance

                // Extract Z from key (format "z/x/y")
                const parts = key.split('/');
                const z = parseInt(parts[0]);
                const x = parseInt(parts[1]);
                const y = parseInt(parts[2]);

                patchCenterVector(z, x, y, this._center).multiplyScalar(RADIUS);
                const dist = this._center.distanceTo(cameraPos);

                this._tileCenterNorm.copy(this._center).sub(cameraPos).normalize();
                const dot = this._cameraDir.dot(this._tileCenterNorm);

                const zoomScore = (MAX_ZOOM - z) * 10000;
                const centerScore = Math.max(0, dot) * 5000;
                const priority = zoomScore + centerScore - dist;

                candidates.push({ key, z, x, y, priority });
            }
        }

        // Sort by priority (highest first)
        candidates.sort((a, b) => b.priority - a.priority);

        // Fill available slots
        while (this.currentLoads < LOAD_LIMIT && candidates.length > 0) {
            const req = candidates.shift();
            const mesh = this.tileCache.get(req.key);
            if (mesh) {
                mesh.userData.loading = true;
                this.loadAndApplyTile(req.z, req.x, req.y);
            }
        }
    }

    // Initialize shared geometry if not exists
    getSharedGeometry() {
        if (!this.sharedGeometry) {
            // 64x64 segments is a good balance for sphere curvature
            this.sharedGeometry = new THREE.PlaneGeometry(1, 1, 64, 64);
            // Rotate to face Z (standard for our projection)
            // Actually, PlaneGeometry is X-Y by default.
        }
        return this.sharedGeometry;
    }

    createTileMesh(z, x, y) {
        const geometry = this.getSharedGeometry();

        const lonMin = tileXToLon(x, z);
        const lonMax = tileXToLon(x + 1, z);
        const latMax = tileYToLat(y, z);
        const latMin = tileYToLat(y + 1, z);

        // Custom Shader Material
        const material = new THREE.ShaderMaterial({
            uniforms: {
                u_texture: { value: null }, // Will be set later
                u_minLon: { value: lonMin },
                u_maxLon: { value: lonMax },
                u_minLat: { value: latMin }, // Bottom
                u_maxLat: { value: latMax }, // Top
                u_radius: { value: RADIUS }
            },
            vertexShader: `
                uniform float u_minLon;
                uniform float u_maxLon;
                uniform float u_minLat;
                uniform float u_maxLat;
                uniform float u_radius;

                varying vec2 vUv;

                const float PI = 3.14159265359;

                void main() {
                    vUv = uv;

                    // Interpolate Lat/Lon based on UV
                    // uv.x goes 0->1 (minLon -> maxLon)
                    // uv.y goes 0->1 (minLat -> maxLat) - Check orientation!
                    // Usually texture Y is 0 at bottom, 1 at top.
                    // LatMin is bottom, LatMax is top.
                    
                    float lon = mix(u_minLon, u_maxLon, uv.x);
                    float lat = mix(u_minLat, u_maxLat, uv.y);

                    // Convert to Radians
                    float latRad = radians(lat);
                    float lonRad = radians(lon);

                    // Spherical Projection (matches Utils.js)
                    // x = -r * cos(lat) * cos(lon)
                    // y = r * sin(lat)
                    // z = r * cos(lat) * sin(lon)
                    
                    float cosLat = cos(latRad);
                    float sinLat = sin(latRad);
                    float cosLon = cos(lonRad);
                    float sinLon = sin(lonRad);

                    vec3 pos = vec3(
                        -u_radius * cosLat * cosLon,
                        u_radius * sinLat,
                        u_radius * cosLat * sinLon
                    );

                    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D u_texture;
                varying vec2 vUv;

                void main() {
                    vec4 color = texture2D(u_texture, vUv);
                    gl_FragColor = color;
                    #include <colorspace_fragment>
                }
            `,
            side: THREE.FrontSide,
            wireframe: false
        });

        // Create a temporary canvas texture so we don't crash
        const canvasTex = document.createElement("canvas");
        canvasTex.width = TEXTURE_SIZE;
        canvasTex.height = TEXTURE_SIZE;
        const ctx = canvasTex.getContext("2d");
        ctx.fillStyle = "#111";
        ctx.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);

        // Inherit from parent
        this.inheritFromParentTile(z, x, y, canvasTex);

        const texture = new THREE.CanvasTexture(canvasTex);
        texture.colorSpace = THREE.SRGBColorSpace;

        // Assign texture to uniform
        material.uniforms.u_texture.value = texture;
        // Also set .map for compatibility with inheritFromParentTile logic which checks material.map
        material.map = texture;

        const mesh = new THREE.Mesh(geometry, material);
        mesh.visible = false;
        const key = `${z}/${x}/${y}`;
        mesh.userData = { loaded: false, loading: false, key: key };

        // Important: Frustum culling might fail if the bounding sphere of the flat plane 
        // doesn't match the curved surface.
        // We should manually set the bounding sphere or disable culling for the mesh 
        // (we do our own culling anyway).
        mesh.frustumCulled = false;

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
                const parentImage = parentMesh.material.map.image;

                const scale = Math.pow(2, z - pZ);
                const tileSize = TEXTURE_SIZE;

                // Calculate which quadrant of the parent this child represents
                const offsetX = x - pX * scale;
                const offsetY = y - pY * scale;

                const sWidth = tileSize / scale;
                const sHeight = tileSize / scale;
                const sx = offsetX * sWidth;
                const sy = offsetY * sHeight;

                const ctx = childCanvas.getContext("2d");

                // Disable image smoothing for pixel-perfect inheritance
                ctx.imageSmoothingEnabled = false;

                try {
                    // Draw from parent source - works with Image, Canvas, or ImageBitmap
                    ctx.drawImage(parentImage, sx, sy, sWidth, sHeight, 0, 0, tileSize, tileSize);
                } catch (e) {
                    console.warn("Failed to inherit from parent tile", e);
                }

                // Re-enable smoothing for future operations
                ctx.imageSmoothingEnabled = true;
                return;
            }

            pZ--;
            pX = Math.floor(pX / 2);
            pY = Math.floor(pY / 2);
        }
    }

    async loadTileImage(z, x, y) {
        const url = esriTileURL(z, y, x);
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) return null;
            const blob = await response.blob();
            // createImageBitmap decodes the image off the main thread!
            return await createImageBitmap(blob);
        } catch (e) {
            // console.warn("Failed to load tile", z, x, y);
            return null;
        }
    }

    async loadAndApplyTile(z, x, y) {
        const key = `${z}/${x}/${y}`;

        this.currentLoads++;
        const img = await this.loadTileImage(z, x, y);
        this.currentLoads--;

        // Fetch mesh
        const mesh = this.tileCache.get(key);
        if (!mesh) return; // Tile was evicted

        // Always clear loading flag when done (success or fail)
        mesh.userData.loading = false;

        if (!img) return;

        // Update texture
        const texture = mesh.material.map;

        // For ImageBitmap, we need to update the canvas
        if (texture.image instanceof HTMLCanvasElement) {
            const canvas = texture.image;
            const ctx = canvas.getContext("2d");
            ctx.imageSmoothingEnabled = false;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            ctx.imageSmoothingEnabled = true;
        } else {
            // Fallback: direct image replacement
            texture.image = img;
        }

        texture.needsUpdate = true;
        mesh.userData.loaded = true;

        // Notify worker
        this.worker.postMessage({ type: 'tileLoaded', key: key });
    }

    tileIsVisible(z, x, y) {
        patchCenterVector(z, x, y, this._center).multiplyScalar(RADIUS);
        const tileRadius = (RADIUS * Math.PI) / Math.pow(2, z);

        // Better Frustum Check: intersectsSphere
        // This correctly accounts for tile size and provides a scalable buffer.
        // We expand the sphere by a factor (e.g. 1.2) to create the "just off-screen" buffer.
        // Reduced from 1.5 to 1.2 to cull more aggressively and save traversal budget
        const bufferFactor = 1.2;
        this._sphere.center.copy(this._center);
        this._sphere.radius = tileRadius * bufferFactor;

        if (!this.frustum.intersectsSphere(this._sphere)) {
            // If the expanded sphere is not in the frustum, cull it.
            // But we might want to keep tiles VERY close to camera even if "behind" (to avoid clipping when rotating fast)
            // So we keep the simple distance check but make it very tight (e.g. 2x tile radius)
            const dist = this._center.distanceTo(this.camera.position);
            if (dist > tileRadius * 2.0) {
                return false;
            }
        }

        // Back-face culling
        this._cameraDir.copy(this.camera.position).normalize();
        patchCenterVector(z, x, y, this._tileCenterNorm);
        const dot = this._cameraDir.dot(this._tileCenterNorm);
        return dot > -0.2; // Allow slightly back-facing tiles for horizon correctness
    }

    // Helper for init
    async loadBaseZoomTiles() {
        // No-op in new system, update() handles everything
    }
}
