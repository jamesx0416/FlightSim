import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import {
    CesiumIonAuthPlugin,
    TileCompressionPlugin,
    UpdateOnChangePlugin,
    UnloadTilesPlugin,
    TilesFadePlugin,
    GLTFExtensionsPlugin
} from "3d-tiles-renderer/plugins";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import {
    RADIUS,
    WGS84_RADIUS,
    DRACO_DECODER_PATH,
    TILE_ERROR_TARGET
} from "./Constants.js";

/**
 * Manages the loading and rendering of Google Photorealistic 3D Tiles.
 * Refactored to use 3d-tiles-renderer plugins for optimized performance.
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
        /** @type {boolean} Whether tile loading is paused */
        this.loadingPaused = false;
    }

    /**
     * Initialize the 3D tiles system with API credentials.
     *
     * @param {string} apiKey - Google Maps API key (unused in this implementation, kept for compatibility)
     * @param {string} cesiumToken - Cesium Ion access token
     * @returns {Promise<void>}
     */
    async init(apiKey, cesiumToken) {
        if (!cesiumToken || cesiumToken === 'YOUR_CESIUM_TOKEN_HERE') {
            console.warn("Tiles3DManager: No valid Cesium Ion token provided.");
            // We could fallback to GoogleCloudAuthPlugin if we had it, but for now we rely on Cesium
            // If explicit Google Key support is needed without Cesium, we'd need GoogleCloudAuthPlugin
            return;
        }

        // Create tiles renderer
        // The URL is set by the CesiumIonAuthPlugin
        this.tilesRenderer = new TilesRenderer();
        this.tilesRenderer.setCamera(this.camera);
        this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);

        // Performance: Set errorTarget (default 6) - Lower = higher quality
        this.tilesRenderer.errorTarget = TILE_ERROR_TARGET;

        // 1. Auth Plugin
        this.tilesRenderer.registerPlugin(new CesiumIonAuthPlugin({
            apiToken: cesiumToken,
            assetId: '2275207', // Google Photorealistic 3D Tiles
            autoRefreshToken: true,
        }));

        // 2. GLTF / Draco Plugin
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        this.tilesRenderer.registerPlugin(new GLTFExtensionsPlugin({
            dracoLoader
        }));

        // 3. Optimization Plugins
        this.tilesRenderer.registerPlugin(new TileCompressionPlugin());
        this.tilesRenderer.registerPlugin(new UpdateOnChangePlugin());
        this.tilesRenderer.registerPlugin(new UnloadTilesPlugin());
        this.tilesRenderer.registerPlugin(new TilesFadePlugin());

        // Add to group
        this.group.add(this.tilesRenderer.group);

        // Rotate to align Z-up (ECEF) to Y-up (Three.js)
        this.tilesRenderer.group.rotation.x = -Math.PI / 2;

        // SCALE CORRECTION:
        // Google 3D Tiles are in meters (Radius ~6,378,137).
        // Our RADIUS constant is also 6378137, so scale = 1.0 (no scaling).
        // But we apply it just in case RADIUS changes.
        const scale = RADIUS / WGS84_RADIUS;
        this.tilesRenderer.group.scale.setScalar(scale);

        this.isInitialized = true;
    }

    update() {
        if (this.tilesRenderer && !this.loadingPaused) {
            this.tilesRenderer.setCamera(this.camera);
            this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);
            this.tilesRenderer.update();
        }
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
