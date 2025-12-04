// src/LODManager.js
import { CONFIG } from '../config.js';

export class LODManager {
    constructor(camera, scene) {
        this.camera = camera;
        this.scene = scene;
        this.globeRadius = 6378137; // Earth radius in meters

        // State
        this.currentAltitude = Infinity;
        this.shouldShowTiles = false;

        // Config
        this.focusRadius = CONFIG.FOCUS_RADIUS || 5000;
        this.minAltitudeForTiles = 100; // Show tiles when below this altitude (if we had a strict cutoff)
        this.maxAltitudeForTiles = 200000; // Hide tiles when above 200km (performance/clarity)
    }

    update() {
        // Calculate altitude (approximate, assuming 0,0,0 is Earth center)
        const dist = this.camera.position.length();
        this.currentAltitude = dist - this.globeRadius;

        // Simple logic: Show tiles if we are close enough to the surface
        if (this.currentAltitude < this.maxAltitudeForTiles && this.currentAltitude > 10) {
            this.shouldShowTiles = true;
        } else {
            this.shouldShowTiles = false;
        }

        return {
            altitude: this.currentAltitude,
            showTiles: this.shouldShowTiles
        };
    }

    // Helper to get distance from camera to a point on the globe
    getDistanceToPoint(point) {
        return this.camera.position.distanceTo(point);
    }
}
