import * as THREE from "three";
import { MAX_ZOOM, MIN_ZOOM, RADIUS } from "../Constants.js";
import { patchCenterVector } from "./Utils.js";
import { LOD_THRESHOLDS, GRAZING_ANGLE_THRESHOLD, MIN_GRAZING_DOT } from "./LODConfig.js";

/**
 * Manages Level of Detail (LOD) calculations for 2D tile rendering.
 * 
 * Determines when tiles should be split into higher-resolution children
 * based on camera distance and viewing angle. Uses grazing angle compensation
 * to provide less detail for tiles viewed at steep angles (near horizon).
 * 
 * @example
 * const lod = new LODManager();
 * const zoom = lod.getDesiredZoom(distanceKm);
 * const shouldSplit = lod.shouldSplit(z, x, y, cameraPosition);
 */
export class LODManager {
    /**
     * Creates a new LODManager instance.
     */
    constructor() {
        /** @type {Object} Distance thresholds (km) for each zoom level */
        this.lodThresholds = LOD_THRESHOLDS;

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
        let adjustedDot = 1.0;
        if (z < GRAZING_ANGLE_THRESHOLD) {
            adjustedDot = Math.max(MIN_GRAZING_DOT, dot);
        }

        const effectiveDistanceKm = distanceKm / adjustedDot;

        const desired = this.getDesiredZoom(effectiveDistanceKm);
        return z < desired;
    }
}