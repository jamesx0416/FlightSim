import { MAX_ZOOM, MIN_ZOOM, RADIUS } from "./Constants.js";
import { patchCenterVector } from "./Utils.js";

export class LODManager {
    constructor() {
        // Configuration for LOD distances (in km, relative to Earth radius)
        // These thresholds determine when to switch to the next lower zoom level.
        // Distance is from camera to tile center.
        this.lodThresholds = {
            15: 20,
            14: 50,
            13: 100,
            12: 200,
            11: 400,
            10: 800,
            9: 1500,
            8: 2500,
            7: 4000,
            6: 6000,
            5: 8000,
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

        const desired = this.getDesiredZoom(distanceKm);
        return z < desired;
    }
}
