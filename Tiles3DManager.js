import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
    RADIUS,
    MAX_TILE_ANGULAR_SIZE,
    HORIZON_BUFFER_FACTOR,
    WGS84_RADIUS,
    DRACO_DECODER_PATH
} from "./Constants.js";

// Reusable objects to avoid GC pressure
const _tileCenter = new THREE.Vector3();
const _cameraPos = new THREE.Vector3();
const _toTile = new THREE.Vector3();
const _cameraDir = new THREE.Vector3();
const _boundingBox = new THREE.Box3();
const _boundingSphere = new THREE.Sphere();

/**
 * Manages the loading and rendering of Google Photorealistic 3D Tiles.
 * 
 * Handles authentication with Cesium Ion or Google Maps API directly,
 * tile loading with DRACO compression support, and horizon culling
 * for optimal performance.
 * 
 * @example
 * const manager = new Tiles3DManager(scene, camera, renderer);
 * await manager.init(googleApiKey, cesiumToken);
 * // In animation loop:
 * manager.update();
 */
export class Tiles3DManager {
    /**
     * Creates a new Tiles3DManager instance.
     * 
     * @param {THREE.Scene} scene - The Three.js scene to add tiles to
     * @param {THREE.PerspectiveCamera} camera - The camera used for LOD and culling decisions
     * @param {THREE.WebGLRenderer} renderer - The WebGL renderer for resolution calculations
     */
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.webglRenderer = renderer;
        this.tilesRenderer = null;
        this.group = new THREE.Group();
        this.scene.add(this.group);

        /** @type {boolean} Whether tiles have been successfully initialized */
        this.isInitialized = false;
        /** @type {string|null} Active Google session token for tile requests */
        this.activeSession = null;
        /** @type {string|null} Root tileset URL */
        this.rootUrl = null;
        /** @type {boolean} Whether tile loading is paused */
        this.loadingPaused = false;

        // Horizon culling parameters (updated each frame)
        this.horizonCosAngle = 0;
        this.cameraHeight = 0;
    }

    /**
     * Calculate the cosine of the angle to the horizon from the camera.
     * This is used for efficient horizon culling without trig operations per tile.
     * 
     * For a camera at height h above a sphere of radius R:
     * - The angle θ from camera-to-center to the horizon tangent line is: cos(θ) = R / (R + h)
     * - A point is below the horizon if the angle from camera-to-center to camera-to-point is > θ
     */
    updateHorizonParameters() {
        // Get camera position in world space
        this.camera.getWorldPosition(_cameraPos);

        // Camera height above Earth center (in world units)
        // Note: The 3D tiles are scaled, so we work in the scaled coordinate system
        this.cameraHeight = _cameraPos.length();

        // For horizon culling, we need R / (R + h) where R is Earth radius in scaled coords
        // The tiles are scaled by RADIUS / 6378137, so scaled Earth radius = RADIUS
        const scaledRadius = RADIUS;

        // Cosine of angle from nadir to horizon
        // cos(θ) = R / d where d is distance from camera to Earth center
        if (this.cameraHeight > scaledRadius) {
            this.horizonCosAngle = scaledRadius / this.cameraHeight;
        } else {
            // Camera is inside Earth (shouldn't happen), disable culling
            this.horizonCosAngle = -1;
        }
    }

    /**
     * Check if a tile's bounding sphere is potentially visible above the horizon.
     * Uses proper geometric horizon occlusion based on Earth's curvature.
     * 
     * @param {THREE.Sphere} boundingSphere - The tile's bounding sphere in world coords
     * @returns {boolean} - True if tile is above horizon, false if occluded
     */
    isTileAboveHorizon(boundingSphere) {
        if (!boundingSphere || this.horizonCosAngle < 0) {
            return true; // No culling if no bounding sphere or invalid state
        }

        // Get camera position
        this.camera.getWorldPosition(_cameraPos);
        const distToCenter = _cameraPos.length();

        // If we are inside the earth (or very close), show everything
        if (distToCenter <= RADIUS) return true;

        // Get tile center
        _tileCenter.copy(boundingSphere.center);
        const tileCenterDist = _tileCenter.length();

        // Safety: if tile center is at/near origin or has invalid radius, show it
        if (tileCenterDist < 1 || boundingSphere.radius <= 0 || !isFinite(tileCenterDist)) {
            return true;
        }

        // Normalized camera direction (from Earth center towards camera)
        _cameraDir.copy(_cameraPos).normalize();

        // Normalized tile direction (from Earth center towards tile)
        _toTile.copy(_tileCenter).normalize();

        // Dot product = cos(angle between camera and tile, measured from Earth center)
        const dot = _cameraDir.dot(_toTile);

        // Safety check for NaN
        if (!isFinite(dot)) {
            return true;
        }

        // Calculate the horizon angle: cos(theta) = R / D
        const horizonCos = RADIUS / distToCenter;
        const horizonAngle = Math.acos(horizonCos);

        // Tile angular size (buffer) based on bounding sphere radius
        // Cap to reasonable maximum to prevent over-buffering
        const rawTileAngularSize = Math.atan2(boundingSphere.radius, tileCenterDist);
        const tileAngularSize = Math.min(rawTileAngularSize, MAX_TILE_ANGULAR_SIZE);

        // Max visible angle = horizon angle + generous buffer
        const maxVisibleAngle = horizonAngle + (tileAngularSize * HORIZON_BUFFER_FACTOR);

        // Calculate minimum allowed dot product
        // Since cos is decreasing in [0, PI], angle < maxVisibleAngle means dot > cos(maxVisibleAngle)
        const minAllowedDot = Math.cos(maxVisibleAngle);

        // Tile is visible if dot >= minAllowedDot
        return dot >= minAllowedDot;
    }

    /**
     * Initialize the 3D tiles system with API credentials.
     * 
     * Attempts to load tiles via Cesium Ion first, falling back to direct
     * Google API if Cesium fails or no Cesium token is provided.
     * 
     * @param {string} apiKey - Google Maps API key
     * @param {string} cesiumToken - Cesium Ion access token
     * @returns {Promise<void>}
     */
    async init(apiKey, cesiumToken) {
        this.apiKey = apiKey;
        this.cesiumToken = cesiumToken;

        const hasCesiumToken = cesiumToken && cesiumToken !== 'YOUR_CESIUM_TOKEN_HERE';
        const hasGoogleKey = apiKey && apiKey !== 'YOUR_GOOGLE_MAPS_KEY_HERE';

        if (!hasCesiumToken && !hasGoogleKey) {
            console.error("Tiles3DManager: No valid API keys provided. 3D Tiles will not load.");
            return;
        }

        // Option A: Cesium Ion
        if (hasCesiumToken) {
            try {
                await this.loadFromCesiumIon();
                return;
            } catch (e) {
                console.warn("Cesium Ion load failed, falling back to direct Google API:", e);
            }
        }

        // Option B: Direct Google API
        if (hasGoogleKey) {
            await this.loadFromGoogleDirect();
        }
    }

    async loadFromCesiumIon() {
        const assetId = 2275207; // Google Photorealistic 3D Tiles via Cesium
        const url = `https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${this.cesiumToken}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cesium Ion Error: ${response.statusText}`);

        const data = await response.json();
        let tilesetUrl = data.options?.url || data.url || data.externalUrl;
        const accessToken = data.accessToken;

        if (!tilesetUrl) throw new Error("Cesium Ion response did not contain a tileset URL");

        // Extract the API key from the URL if present (Google tiles via Cesium often have it)
        const urlObj = new URL(tilesetUrl);
        const keyFromUrl = urlObj.searchParams.get('key');
        if (keyFromUrl) this.apiKey = keyFromUrl;

        this.rootUrl = tilesetUrl;
        this.setupTilesRenderer(tilesetUrl, accessToken);
    }

    async loadFromGoogleDirect() {
        try {
            // 1. Create Session
            const sessionUrl = `https://tile.googleapis.com/v1/createSession?key=${this.apiKey}`;
            const response = await fetch(sessionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    "mapType": "satellite",
                    "language": "en-US",
                    "region": "US"
                })
            });

            if (!response.ok) throw new Error(`Session creation failed: ${response.status}`);

            const data = await response.json();
            this.activeSession = data.session;

            // 2. Setup TilesRenderer
            const tilesetUrl = `https://tile.googleapis.com/v1/3dtiles/root.json?session=${this.activeSession}&key=${this.apiKey}`;
            this.rootUrl = tilesetUrl;

            this.setupTilesRenderer(tilesetUrl, null);

        } catch (e) {
            console.error("Failed to initialize Google 3D Tiles:", e);
        }
    }

    setupTilesRenderer(url, accessToken) {
        if (this.tilesRenderer) {
            this.dispose();
        }

        this.tilesRenderer = new TilesRenderer(url);
        this.tilesRenderer.setCamera(this.camera);
        this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);

        // LOD Configuration
        // errorTarget: Target screenspace error in pixels. Lower = higher quality.
        // Setting to 0.5 for maximum quality (forces highest resolution tiles)
        this.tilesRenderer.errorTarget = 0.5;

        // Optional: Limit max depth for performance (comment out for full detail)
        // this.tilesRenderer.maxDepth = 15;
        this.tilesRenderer.maxDepth = 30; // Guard against infinite depth

        // Debug: Listen for tile processing
        this.tilesRenderer.onLoadTileSet = (tileset) => {
            console.log("Tiles3D: Tileset loaded", tileset);
            if (tileset.root) {
                console.log("Tiles3D: Root geometric error:", tileset.root.geometricError);
            }
        };
        this.tilesRenderer.onTileError = (err) => {
            console.warn("Tiles3D: Tile Load Error:", err);
        };

        // Configure DRACOLoader
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        this.tilesRenderer.manager.addHandler(/\.gltf$/, new GLTFLoader().setDRACOLoader(dracoLoader));
        this.tilesRenderer.manager.addHandler(/\.glb$/, new GLTFLoader().setDRACOLoader(dracoLoader));

        // Intercept tile requests for session handling
        this.tilesRenderer.preprocessURL = (uri) => {

            if (!uri.includes('tile.googleapis.com')) return uri;
            if (uri === this.rootUrl || uri.includes('root.json')) return uri;

            const urlObj = new URL(uri);
            let changed = false;

            // Inject Session
            if (this.activeSession) {
                if (!urlObj.searchParams.has('session')) {
                    urlObj.searchParams.set('session', this.activeSession);
                    changed = true;
                }
            } else if (urlObj.searchParams.has('session')) {
                // Capture session if we don't have one (e.g. from Cesium URL)
                this.activeSession = urlObj.searchParams.get('session');
            }

            // Inject Key
            if (this.apiKey && !urlObj.searchParams.has('key')) {
                urlObj.searchParams.set('key', this.apiKey);
                changed = true;
            }

            return changed ? urlObj.toString() : uri;
        };

        // Auth Header for Cesium
        if (accessToken) {
            this.tilesRenderer.fetchOptions = {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            };
        }

        // Add to group and rotate
        this.group.add(this.tilesRenderer.group);

        // Rotate to align Z-up (ECEF) to Y-up (Three.js)
        // Google Tiles are ECEF (Z-up). Three.js is Y-up.
        // We rotate the container group -90 deg around X.
        this.tilesRenderer.group.rotation.x = -Math.PI / 2;

        // SCALE CORRECTION:
        // Google 3D Tiles are in meters (Radius ~6,378,137).
        // Our RADIUS constant is also 6378137, so scale = 1.0 (no scaling).
        const scale = RADIUS / WGS84_RADIUS;
        this.tilesRenderer.group.scale.setScalar(scale);

        this.isInitialized = true;
    }



    update() {
        if (this.tilesRenderer) {
            // Update horizon culling parameters based on camera position
            this.updateHorizonParameters();

            // CRITICAL: Ensure camera and group matrices are up to date for SSE calculation
            this.camera.updateMatrixWorld();
            this.group.updateMatrixWorld(true);

            // Log debug info periodically
            const cameraAltitude = this.cameraHeight - RADIUS;
            // if (Math.random() < 0.01) console.log("Tiles3D Update - Alt:", cameraAltitude.toFixed(1), "ErrorTarget:", this.tilesRenderer.errorTarget);

            // Use the main camera for tile loading decisions
            this.tilesRenderer.setCamera(this.camera);
            this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);

            // Only update tile loading if not paused
            if (!this.loadingPaused) {
                this.tilesRenderer.update();
            }

            // Apply horizon culling to all loaded tiles
            this.applyHorizonCulling();
        }
    }

    /**
     * Apply horizon culling to all loaded tile models.
     * This is called every frame to update visibility as camera moves.
     */
    applyHorizonCulling() {
        this.tilesRenderer.forEachLoadedModel((scene, tile) => {
            // Get the tile's world bounding sphere using reusable objects
            _boundingBox.setFromObject(scene);

            if (_boundingBox.isEmpty()) {
                scene.visible = true;
                return;
            }

            _boundingBox.getBoundingSphere(_boundingSphere);

            // Apply horizon culling - hide tiles below the horizon
            scene.visible = this.isTileAboveHorizon(_boundingSphere);
        });
    }

    dispose() {
        if (this.tilesRenderer) {
            this.group.remove(this.tilesRenderer.group);
            this.tilesRenderer.dispose();
            this.tilesRenderer = null;
        }
        this.isInitialized = false;
    }
}
