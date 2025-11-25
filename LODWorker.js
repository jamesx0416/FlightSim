import { RADIUS, MAX_ZOOM, MIN_ZOOM } from "./Constants.js";
import { patchCenterVector } from "./Utils.js";

// Minimal vector class to avoid Three.js dependency in worker if possible, 
// but since we use modules we can import Three.js if needed. 
// However, let's keep it lightweight.
class Vector3 {
    constructor(x = 0, y = 0, z = 0) {
        this.x = x; this.y = y; this.z = z;
    }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    length() { return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z); }
    distanceTo(v) {
        const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    normalize() {
        const l = this.length();
        if (l > 0) this.multiplyScalar(1 / l);
        return this;
    }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
}

// State
let cameraPosition = new Vector3();
let cameraDirection = new Vector3(); // For center bias
let loadedTiles = new Set(); // Set of "z/x/y" strings
let loadQueue = [];
let activeTiles = new Set();

// Configuration
const LOD_THRESHOLDS = {
    15: 25, 14: 50, 13: 100, 12: 200, 11: 400, 10: 800,
    9: 1500, 8: 2500, 7: 4000, 6: 6000, 5: 8000, 4: Infinity
};

// Utils
const _center = new Vector3();
const _tileNormal = new Vector3();
const _viewVector = new Vector3();

function getDesiredZoom(distanceKm) {
    for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
        if (distanceKm < LOD_THRESHOLDS[z]) return z;
    }
    return MIN_ZOOM;
}

function shouldSplit(z, x, y) {
    if (z >= MAX_ZOOM) return false;

    patchCenterVector(z, x, y, _center).multiplyScalar(RADIUS);
    const distance = _center.distanceTo(cameraPosition);
    const distanceKm = distance * 100;

    // Grazing angle check
    patchCenterVector(z, x, y, _tileNormal);
    _viewVector.copy(_center).sub(cameraPosition).normalize();
    const dot = Math.abs(_viewVector.dot(_tileNormal));

    let adjustedDot = 1.0;
    if (z < 10) adjustedDot = Math.max(0.5, dot);

    const effectiveDistanceKm = distanceKm / adjustedDot;
    return z < getDesiredZoom(effectiveDistanceKm);
}

function isVisuallyReady(z, x, y) {
    // Strict progressive loading check
    // Worker needs to know if the tile is loaded.
    // We rely on 'loadedTiles' set synced from main thread.
    const key = `${z}/${x}/${y}`;
    return loadedTiles.has(key);
}

let frustumPlanes = [];

function isTileVisible(z, x, y) {
    patchCenterVector(z, x, y, _center).multiplyScalar(RADIUS);
    const tileRadius = (RADIUS * Math.PI) / Math.pow(2, z);
    const bufferFactor = 1.2;
    const radius = tileRadius * bufferFactor;

    // Check against all 6 planes
    for (let i = 0; i < 6; i++) {
        const plane = frustumPlanes[i];
        // Plane equation: Ax + By + Cz + D = 0
        // Distance from center to plane = dot(N, center) + constant
        const dist = plane[0] * _center.x + plane[1] * _center.y + plane[2] * _center.z + plane[3];

        // If distance < -radius, sphere is completely behind plane (culled)
        if (dist < -radius) {
            return false;
        }
    }
    return true;
}

function processTile(z, x, y, desiredTiles, tilesProcessed) {
    if (tilesProcessed.count > 20000) return;
    tilesProcessed.count++;

    // Frustum Culling
    if (frustumPlanes.length > 0 && !isTileVisible(z, x, y)) return;

    let split = shouldSplit(z, x, y);

    if (split) {
        if (!isVisuallyReady(z, x, y)) {
            split = false;
        }
    }

    if (split) {
        const nextZ = z + 1;
        const nextX = x * 2;
        const nextY = y * 2;
        processTile(nextZ, nextX, nextY, desiredTiles, tilesProcessed);
        processTile(nextZ, nextX + 1, nextY, desiredTiles, tilesProcessed);
        processTile(nextZ, nextX, nextY + 1, desiredTiles, tilesProcessed);
        processTile(nextZ, nextX + 1, nextY + 1, desiredTiles, tilesProcessed);
    } else {
        const key = `${z}/${x}/${y}`;
        patchCenterVector(z, x, y, _center).multiplyScalar(RADIUS);
        const dist = _center.distanceTo(cameraPosition);
        desiredTiles.push({ z, x, y, dist, key });
    }
}

self.onmessage = function (e) {
    const type = e.data.type;

    if (type === 'tileLoaded') {
        loadedTiles.add(e.data.key);
        return;
    }

    if (type === 'tileEvicted') {
        loadedTiles.delete(e.data.key);
        return;
    }

    if (type === 'update') {
        // Update state
        const camPos = e.data.cameraPosition;
        cameraPosition.set(camPos.x, camPos.y, camPos.z);

        const camDir = e.data.cameraDirection;
        if (camDir) cameraDirection.set(camDir.x, camDir.y, camDir.z);

        if (e.data.frustumPlanes) {
            frustumPlanes = e.data.frustumPlanes;
        }

        // Run Traversal
        const desiredTiles = [];
        const tilesProcessed = { count: 0 };

        // Start traversal from roots
        const baseZoom = 4;
        const n = Math.pow(2, baseZoom);

        for (let x = 0; x < n; x++) {
            for (let y = 0; y < n; y++) {
                processTile(baseZoom, x, y, desiredTiles, tilesProcessed);
            }
        }

        // Sort Load Queue Logic (can be done here too!)
        // ...

        self.postMessage({
            type: 'result',
            desiredTiles: desiredTiles
        });
    }
};
