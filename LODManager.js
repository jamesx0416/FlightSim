import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import { MAX_ZOOM, MIN_ZOOM, RADIUS } from "./Constants.js";
import { patchCenterVector } from "./Utils.js";

export class LODManager {
    constructor() {
        // Configuration for LOD distances (in km, relative to Earth radius)
        // These thresholds determine when to switch to the next lower zoom level.
        // Distance is from camera to tile center.
        this.lodThresholds = {
            15: 25,    // Reduced for lower quality
            14: 50,
            13: 100,
            12: 200,
            11: 400,
            10: 800,
            9: 1500,
            8: 2500,
            7: 4000,
            6: 6000,
            5: 8000,   // Kept as is ("Level 5 is fine")
            4: Infinity
        };

        // Reusable vectors to avoid GC
        this._center = new THREE.Vector3();
        this._tileNormal = new THREE.Vector3();
        this._viewVector = new THREE.Vector3();
    }

    // Determine the target zoom level for a given distance (km)
    getDesiredZoom(distanceKm) {
        for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
            if (distanceKm < this.lodThresholds[z]) {
                return z;
            }
        }
        return MIN_ZOOM;
    }

    // Check if a tile should be split (quadtree descent)
    shouldSplit(z, x, y, cameraPosition) {
        if (z >= MAX_ZOOM) return false;

        // Use reusable vectors
        patchCenterVector(z, x, y, this._center).multiplyScalar(RADIUS);
        const distance = this._center.distanceTo(cameraPosition);

        // Convert World Units to Kilometers
        // RADIUS = 63.71 units = 6371 km (approx Earth Radius)
        // Therefore 1 unit = 100 km
        const distanceKm = distance * 100;

        // Grazing Angle Falloff
        // Calculate dot product between View Vector and Tile Normal
        patchCenterVector(z, x, y, this._tileNormal); // Already normalized

        // viewVector = center - cameraPosition
        this._viewVector.copy(this._center).sub(cameraPosition).normalize();

        const dot = Math.abs(this._viewVector.dot(this._tileNormal));

        // Effective Distance Calculation
        // If looking straight down (dot ~ 1.0), effective distance = actual distance
        // If looking at horizon (dot ~ 0.0), effective distance increases significantly

        // Dampen the effect at high zoom levels (close to ground)
        // User requested to remove grazing angle effect for level 10+
        let adjustedDot = 1.0;
        if (z < 10) {
            adjustedDot = Math.max(0.5, dot);
        }

        const effectiveDistanceKm = distanceKm / adjustedDot;

        const desired = this.getDesiredZoom(effectiveDistanceKm);
        return z < desired;
    }
}