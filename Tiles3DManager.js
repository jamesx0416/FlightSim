import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import { TilesRenderer } from 'https://esm.sh/3d-tiles-renderer@0.3.28';
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
    }

    loadTileset(url) {
        if (this.tilesRenderer) {
            this.dispose();
        }

        this.tilesRenderer = new TilesRenderer(url);
        this.tilesRenderer.setCamera(this.camera);
        this.tilesRenderer.setResolutionFromRenderer(this.camera, this.webglRenderer);

        // Add the tileset to our group
        this.group.add(this.tilesRenderer.group);

        // Optional: Debug helpers
        // this.tilesRenderer.onLoadModel = (scene) => {
        //     // Handle loaded models if needed
        // };
    }

    // Load a tileset from Cesium Ion
    async loadCesiumIonAsset(assetId, accessToken) {
        // Fetch asset metadata from Cesium Ion
        console.log(accessToken);
        const metadataUrl = `https://api.cesium.com/v1/assets/${assetId}/endpoint?access_token=${accessToken}`;

        try {
            const response = await fetch(metadataUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch Cesium Ion asset ${assetId}: ${response.statusText}`);
            }

            const data = await response.json();

            // Construct the tileset URL
            // Note: We do NOT append the access token to the URL for 3D Tiles assets
            const tilesetUrl = data.url;

            // Load the tileset
            this.loadTileset(tilesetUrl);

            // Ensure the access token is sent via Authorization header with all requests
            if (this.tilesRenderer) {
                this.tilesRenderer.fetchOptions = {
                    headers: {
                        'Authorization': `Bearer ${data.accessToken}`
                    }
                };
            }

            console.log(`Loaded Cesium Ion asset ${assetId}`);
        } catch (error) {
            console.error('Error loading Cesium Ion asset:', error);
        }
    }

    // Position the tileset on the globe
    setTransform(lat, lon, alt, scale = 1.0) {
        if (!this.tilesRenderer) return;

        // 1. Calculate position on globe
        const position = new THREE.Vector3();
        lonLatToVector3(lon, lat, RADIUS + alt, 1, position);

        // 2. Orient the tileset to be upright on the globe surface
        // The "up" vector at this position is the normalized position vector
        const up = position.clone().normalize();

        // Create a rotation matrix to align the tileset's Y (or Z) up with the globe normal
        // 3D Tiles usually have Z up or Y up. 3d-tiles-renderer handles rotation adjustments 
        // but we need to place the root group correctly.

        this.group.position.copy(position);

        // Align Y-up (common in 3D) to the globe normal
        this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);

        // Apply scale
        this.group.scale.setScalar(scale);

        // Update the matrices
        this.group.updateMatrixWorld(true);
    }

    update() {
        if (this.tilesRenderer) {
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
    }
}
