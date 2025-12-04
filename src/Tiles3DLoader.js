import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export class Tiles3DLoader {
    constructor(scene, camera, debugOverlay) {
        this.scene = scene;
        this.camera = camera;
        this.debugOverlay = debugOverlay;
        this.renderer = null;
        this.sessionKey = null;
        this.rootUrl = CONFIG.GOOGLE_3D_TILES_URL;
        this.apiKey = CONFIG.GOOGLE_API_KEY;
        this.isInitialized = false;
    }

    async init() {
        // Option A: Cesium Ion
        if (CONFIG.CESIUM_ION_TOKEN) {
            try {
                await this.loadFromCesiumIon();
                return;
            } catch (e) {
                console.error("Cesium Ion load failed, falling back to direct Google API:", e);
                this.debugOverlay.logError("Ion Failed, trying Direct...");
            }
        }

        // Option B: Direct Google API
        if (this.apiKey) {
            await this.loadFromGoogleDirect();
        } else {
            console.warn("No API Keys provided. 3D Tiles will not load.");
            this.debugOverlay.logError("Missing API Key");
        }
    }

    async loadFromCesiumIon() {
        const assetId = CONFIG.CESIUM_ION_ASSET_ID || 2275207;
        const url = `https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${CONFIG.CESIUM_ION_TOKEN}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cesium Ion Error: ${response.statusText}`);

        const data = await response.json();

        // For external tilesets (like Google), the URL is in options.url
        // For native Cesium tilesets, it's in data.url
        let tilesetUrl = data.options?.url || data.url || data.externalUrl;
        const accessToken = data.accessToken;

        if (!tilesetUrl) {
            console.error("Cesium Ion response missing URL:", data);
            throw new Error("Cesium Ion response did not contain a tileset URL");
        }

        // Extract the API key from the URL if present
        const urlObj = new URL(tilesetUrl);
        const apiKey = urlObj.searchParams.get('key');

        this.rootUrl = tilesetUrl; // Store for comparison
        this.renderer = new TilesRenderer(tilesetUrl);
        this.renderer.setCamera(this.camera);
        this.renderer.setResolutionFromRenderer(this.camera, new THREE.WebGLRenderer());

        // Configure DRACOLoader for compressed meshes
        const dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
        this.renderer.manager.addHandler(/\.gltf$/, new GLTFLoader().setDRACOLoader(dracoLoader));
        this.renderer.manager.addHandler(/\.glb$/, new GLTFLoader().setDRACOLoader(dracoLoader));

        // Intercept tile requests
        this.renderer.preprocessURL = (url) => {
            if (!url.includes('tile.googleapis.com')) {
                return url;
            }

            // Don't mess with the root URL (it establishes the session)
            if (url === this.rootUrl || url.includes('root.json')) {
                return url;
            }

            const urlObj = new URL(url);
            let changed = false;

            // 1. Capture or Inject Session
            if (urlObj.searchParams.has('session')) {
                const currentSession = urlObj.searchParams.get('session');
                if (this.activeSession !== currentSession) {
                    this.activeSession = currentSession;
                }
            } else if (this.activeSession) {
                urlObj.searchParams.set('session', this.activeSession);
                changed = true;
            }

            // 2. Ensure API Key is present
            if (apiKey && !urlObj.searchParams.has('key')) {
                urlObj.searchParams.set('key', apiKey);
                changed = true;
            }

            if (changed) {
                return urlObj.toString();
            }

            return url;
        };

        // Attach Cesium Auth Token to requests (only if provided)
        if (accessToken) {
            this.renderer.fetchOptions = this.renderer.fetchOptions || {};
            this.renderer.fetchOptions.headers = this.renderer.fetchOptions.headers || {};
            this.renderer.fetchOptions.headers['Authorization'] = `Bearer ${accessToken}`;
        }

        this.setupRenderer();
    }

    async loadFromGoogleDirect() {
        try {
            // 1. Create Session
            const sessionUrl = `https://tile.googleapis.com/v1/createSession?key=${this.apiKey}`;
            const response = await fetch(sessionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    "mapType": "satellite",
                    "language": "en-US",
                    "region": "US"
                })
            });

            if (!response.ok) {
                throw new Error(`Session creation failed: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            this.sessionKey = data.session;

            // 2. Setup TilesRenderer
            // Google Tiles URL with session key
            const tilesetUrl = `${this.rootUrl}?session=${this.sessionKey}&key=${this.apiKey}`;

            this.renderer = new TilesRenderer(tilesetUrl);
            this.renderer.setCamera(this.camera);
            this.renderer.setResolutionFromRenderer(this.camera, new THREE.WebGLRenderer());

            this.setupRenderer();

        } catch (e) {
            console.error("Failed to initialize Google 3D Tiles:", e);
            this.debugOverlay.logError("Auth Failed: " + e.message);
        }
    }

    setupRenderer() {
        // Rotate to align Z-up (ECEF) to Y-up (Three.js)
        this.renderer.group.rotation.x = -Math.PI / 2;

        this.scene.add(this.renderer.group);
        this.isInitialized = true;
    }

    update() {
        if (!this.isInitialized || !this.renderer) return;

        this.renderer.update();

        // Update debug stats
        if (this.debugOverlay) {
            this.debugOverlay.update({
                tilesLoaded: this.renderer.stats.downloading, // Approximate mapping
                tilesVisible: this.renderer.visibleTiles.length,
                cacheSize: this.renderer.lruCache.itemList.length
            });
        }
    }

}
