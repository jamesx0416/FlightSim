import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import { RADIUS } from "./Constants.js";

// Esri imagery endpoint
export const esriTileURL = (z, y, x) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Tile helpers (same math as Babylon version)
export const tileXToLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;

export const tileYToLat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export function lonLatToVector3(lon, lat, radius = RADIUS, offset = 1, target = new THREE.Vector3()) {
    const latR = (lat * Math.PI) / 180;
    const lonR = (lon * Math.PI) / 180;
    const cosLat = Math.cos(latR);

    // Flip X to correct horizontal orientation relative to original Babylon implementation
    target.set(
        -radius * cosLat * Math.cos(lonR) * offset,
        radius * Math.sin(latR) * offset,
        radius * cosLat * Math.sin(lonR) * offset
    );
    return target;
}

export function patchCenterVector(z, x, y, target = new THREE.Vector3()) {
    const lon = (tileXToLon(x, z) + tileXToLon(x + 1, z)) / 2;
    const lat = (tileYToLat(y, z) + tileYToLat(y + 1, z)) / 2;
    return lonLatToVector3(lon, lat, 1, 1, target).normalize();
}

// Inverse helpers for tile selection
export function lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

export function latToTileY(lat, z) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, z);
    // Inverse of the tileYToLat math:
    // y = (N / 2) * (1 - asinh(tan(lat)) / PI)
    // asinh(x) = log(x + sqrt(x^2 + 1))
    const val = Math.tan(latRad);
    const asinh = Math.log(val + Math.sqrt(val * val + 1));
    return Math.floor((n / 2) * (1 - asinh / Math.PI));
}
