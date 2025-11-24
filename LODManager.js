import { MAX_ZOOM, MIN_ZOOM, RADIUS } from "./Constants.js";
import { patchCenterVector } from "./Utils.js";

export class LODManager {
    constructor() {
        // Configuration for LOD distances (in km, relative to Earth radius)
        // These thresholds determine when to switch to the next lower zoom level.
        // Distance is from camera to tile center.
        this.lodThresholds = {
            15: 30,
            14: 60,
            13: 120,
            12: 250,
            11: 500,
            10: 1000,
            9: 1800,
            8: 2800,
            7: 4000,
            6: 5500,
            5: 7500,
            4: Infinity
        };
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

        const center = patchCenterVector(z, x, y).multiplyScalar(RADIUS);
        const distance = center.distanceTo(cameraPosition);

        // Convert World Units to Kilometers
        // RADIUS = 63.71 units = 6371 km (approx Earth Radius)
        // Therefore 1 unit = 100 km
        const distanceKm = distance * 100;

        // Grazing Angle Falloff
        // Calculate dot product between View Vector and Tile Normal
        const tileNormal = patchCenterVector(z, x, y); // Already normalized
        const viewVector = center.clone().sub(cameraPosition).normalize();
        const dot = Math.abs(viewVector.dot(tileNormal));

        // Effective Distance Calculation
        // If looking straight down (dot ~ 1.0), effective distance = actual distance
        // If looking at horizon (dot ~ 0.0), effective distance increases significantly

        // Dampen the effect at high zoom levels (close to ground)
        // At zoom 15, we want less penalty for grazing angles because the horizon is close
        const grazingFactor = z > 10 ? 0.5 : 1.0;
        const adjustedDot = Math.max(0.2, dot * grazingFactor + (1 - grazingFactor));

        const effectiveDistanceKm = distanceKm / adjustedDot;

        const desired = this.getDesiredZoom(effectiveDistanceKm);
        return z < desired;
    }
}