import * as THREE from "three";
import { TilesRenderer } from "3d-tiles-renderer";
import { GLTFLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/GLTFLoader.js?external=three";
import { DRACOLoader } from "https://esm.sh/three@0.160.0/examples/jsm/loaders/DRACOLoader.js?external=three";
import { RADIUS } from "./Constants.js";
import { lonLatToVector3 } from "./Utils.js";

export class Tiles3DManager {
    constructor(scene, camera, renderer) {
        this.scene = scene;
        this.camera = camera;
        this.webglRenderer = renderer;
        this.tilesRenderer = null;
        this.group = new THREE.Group();
        this.scene.add(this.group);

        this.isInitialized = false;
        this.activeSession = null;
        this.rootUrl = null;
    }

    async init(apiKey, cesiumToken) {
        this.apiKey = apiKey;
        this.cesiumToken = cesiumToken;

        // Option A: Cesium Ion
        if (this.cesiumToken && this.cesiumToken !== 'YOUR_CESIUM_TOKEN_HERE') {
            try {
                await this.loadFromCesiumIon();
                return;
            } catch (e) {
                console.warn("Cesium Ion load failed, falling back to direct Google API:", e);
            }
        }

        // Option B: Direct Google API
        if (this.apiKey && this.apiKey !== 'YOUR_GOOGLE_MAPS_KEY_HERE') {
            await this.loadFromGoogleDirect();
        } else {
            console.warn("No valid API Keys provided. 3D Tiles will not load.");
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

        // Configure DRACOLoader
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
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
        // v3 uses RADIUS = 63.71.
        // Scale = 63.71 / 6378137 ≈ 0.0000099888
        const scale = RADIUS / 6378137;
        this.tilesRenderer.group.scale.setScalar(scale);

        this.isInitialized = true;
    }

    setTransform(lat, lon, alt, scale = 1.0) {
        // For Google 3D Tiles (Global), we usually don't need this if we are rendering the whole globe.
        // But if we want to position a local tileset, we use this.
        // Keeping it for compatibility.
        if (!this.tilesRenderer) return;

        const position = new THREE.Vector3();
        lonLatToVector3(lon, lat, RADIUS + alt, 1, position);
        const up = position.clone().normalize();

        this.group.position.copy(position);
        this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        this.group.scale.setScalar(scale);
        this.group.updateMatrixWorld(true);
    }

    update() {
        if (this.tilesRenderer) {
            this.tilesRenderer.setCamera(this.camera);
            this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);
            this.tilesRenderer.update();

            // DEBUG: Log stats every 60 frames
            if (!this.frameCount) this.frameCount = 0;
            this.frameCount++;
            if (this.frameCount % 60 === 0) {
                console.log("Tiles3D Stats:", {
                    visible: this.tilesRenderer.visibleTiles.length,
                    downloading: this.tilesRenderer.stats.downloading,
                    downloaded: this.tilesRenderer.stats.downloaded,
                    errorTarget: this.tilesRenderer.errorTarget,
                    scale: this.group.scale.x
                });
            }
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
