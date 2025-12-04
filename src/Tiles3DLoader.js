// src/Tiles3DLoader.js
import * as THREE from 'three';
import { CONFIG } from '../config.js';

// We assume '3d-tiles-renderer' is loaded globally via CDN import map or script tag
// But since we used import map "3d-tiles-renderer", we can try importing it.
// If the CDN export is named, we use that. The unpkg link exports 'TilesRenderer' usually.
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
        // DEBUG: Log what keys we have
        console.log("=== Tiles3DLoader Init ===");
        console.log("CESIUM_ION_TOKEN present:", !!CONFIG.CESIUM_ION_TOKEN);
        console.log("CESIUM_ION_TOKEN (first 20 chars):", CONFIG.CESIUM_ION_TOKEN?.substring(0, 20));
        console.log("GOOGLE_API_KEY present:", !!CONFIG.GOOGLE_API_KEY);

        // Option A: Cesium Ion
        if (CONFIG.CESIUM_ION_TOKEN) {
            console.log("Attempting Cesium Ion load...");
            try {
                await this.loadFromCesiumIon();
                console.log("Cesium Ion load successful!");
                return;
            } catch (e) {
                console.error("Cesium Ion load failed, falling back to direct Google API:", e);
                this.debugOverlay.logError("Ion Failed, trying Direct...");
            }
        } else {
            console.log("No Cesium Ion token, skipping...");
        }

        // Option B: Direct Google API
        if (this.apiKey) {
            console.log("Attempting Google Direct API load...");
            await this.loadFromGoogleDirect();
        } else {
            console.warn("No API Keys provided. 3D Tiles will not load.");
            this.debugOverlay.logError("Missing API Key");
        }
    }

    async loadFromCesiumIon() {
        const assetId = CONFIG.CESIUM_ION_ASSET_ID || 2275207;
        const url = `https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${CONFIG.CESIUM_ION_TOKEN}`;

        console.log("Fetching Cesium Ion endpoint:", url);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Cesium Ion Error: ${response.statusText}`);

        const data = await response.json();
        console.log("Cesium Ion Response:", JSON.stringify(data, null, 2));

        // For external tilesets (like Google), the URL is in options.url
        // For native Cesium tilesets, it's in data.url
        let tilesetUrl = data.options?.url || data.url || data.externalUrl;
        const accessToken = data.accessToken;

        if (!tilesetUrl) {
            console.error("Cesium Ion response missing URL:", data);
            throw new Error("Cesium Ion response did not contain a tileset URL");
        }

        console.log("Original tileset URL:", tilesetUrl);

        // Extract the API key from the URL if present
        const urlObj = new URL(tilesetUrl);
        const apiKey = urlObj.searchParams.get('key');

        // DEBUG: Fetch and log root.json to see what's inside
        try {
            const rootResponse = await fetch(tilesetUrl);
            if (rootResponse.ok) {
                const rootJson = await rootResponse.json();
                console.log("ROOT JSON CONTENT:", JSON.stringify(rootJson, null, 2));
            }
        } catch (e) {
            console.error("Failed to fetch root.json for debug:", e);
        }

        console.log("Access Token:", accessToken ? `Present (${accessToken.substring(0, 20)}...)` : "Not needed (external tileset)");

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
                    // console.log("Captured new Google Session ID:", this.activeSession);
                }
            } else if (this.activeSession) {
                urlObj.searchParams.set('session', this.activeSession);
                changed = true;
                // console.log("Injected sticky session into URL");
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
            console.log("Setting up Authorization header with Cesium token");
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
            console.log("Google 3D Tiles Session created:", this.sessionKey);

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
        // Align Google Tiles (ECEF) to our Globe
        // Google 3D Tiles are in ECEF. If our globe is also ECEF (Z-up or Y-up), we might need rotation.
        // Three.js is Y-up. ECEF is usually Z-up.
        // We'll need to rotate the tileset to match Three.js coordinate system if we are using standard Earth.
        // For now, let's assume we align our camera/globe to ECEF or rotate the group.

        // Rotate to align Z-up (ECEF) to Y-up (Three.js)
        this.renderer.group.rotation.x = -Math.PI / 2;

        this.scene.add(this.renderer.group);
        this.isInitialized = true;

        // Optional: Debug
        // this.renderer.onLoadTileSet = (tileset) => { console.log("Tileset loaded", tileset); };
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

    setResolution(width, height) {
        if (this.renderer) {
            // The renderer needs to know screen size for SSE (Screen Space Error)
            // But the library handles it via camera usually. 
            // If we need to pass the renderer, we can do it in init or update.
        }
    }
}
