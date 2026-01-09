import * as THREE from "three";
import { RADIUS, TILE_SOURCE } from "../Constants.js";
import { KEYS } from "../Keys.js";

/**
 * Tile source URL generators for different imagery providers.
 * @type {Object<string, function(number, number, number): string>}
 */
const TILE_SOURCES = {
    // Esri World Imagery - Good global coverage, updated regularly
    esri: (z, y, x) =>
        `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,

    // EOX Sentinel-2 Cloudless 2020 - Beautiful cloud-free imagery
    // Note: Uses WebMercator (3857), may have slight distortion at poles
    eox: (z, y, x) =>
        `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`,

    // MapTiler Satellite - High quality, requires API key
    maptiler: (z, y, x) =>
        `https://api.maptiler.com/tiles/satellite-v2/${z}/${x}/${y}.jpg?key=${KEYS.MAPTILER}`,
};

/**
 * Get the tile URL for the currently configured tile source.
 * @type {function(number, number, number): string}
 */
export const esriTileURL = TILE_SOURCES[TILE_SOURCE];

/**
 * Convert tile X coordinate to longitude.
 * 
 * @param {number} x - Tile X coordinate
 * @param {number} z - Zoom level
 * @returns {number} Longitude in degrees (-180 to 180)
 */
export const tileXToLon = (x, z) => (x / Math.pow(2, z)) * 360 - 180;

/**
 * Convert tile Y coordinate to latitude using Web Mercator projection.
 * 
 * @param {number} y - Tile Y coordinate
 * @param {number} z - Zoom level
 * @returns {number} Latitude in degrees (~-85.05 to ~85.05)
 */
export const tileYToLat = (y, z) => {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * Convert longitude/latitude to a 3D position on the globe.
 * 
 * @param {number} lon - Longitude in degrees
 * @param {number} lat - Latitude in degrees
 * @param {number} [radius=RADIUS] - Sphere radius
 * @param {number} [offset=1] - Radial offset multiplier
 * @param {THREE.Vector3} [target=new THREE.Vector3()] - Target vector to store result
 * @returns {THREE.Vector3} 3D position on the sphere
 */
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

/**
 * Get the center point of a tile as a normalized direction vector.
 * 
 * @param {number} z - Zoom level
 * @param {number} x - Tile X coordinate
 * @param {number} y - Tile Y coordinate
 * @param {THREE.Vector3} [target=new THREE.Vector3()] - Target vector to store result
 * @returns {THREE.Vector3} Normalized direction vector to tile center
 */
export function patchCenterVector(z, x, y, target = new THREE.Vector3()) {
    const lon = (tileXToLon(x, z) + tileXToLon(x + 1, z)) / 2;
    const lat = (tileYToLat(y, z) + tileYToLat(y + 1, z)) / 2;
    return lonLatToVector3(lon, lat, 1, 1, target).normalize();
}

/**
 * Convert longitude to tile X coordinate.
 * 
 * @param {number} lon - Longitude in degrees
 * @param {number} z - Zoom level
 * @returns {number} Tile X coordinate (floored integer)
 */
export function lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}

/**
 * Convert latitude to tile Y coordinate using Web Mercator projection.
 * 
 * @param {number} lat - Latitude in degrees
 * @param {number} z - Zoom level
 * @returns {number} Tile Y coordinate (floored integer)
 */
export function latToTileY(lat, z) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.pow(2, z);
    const val = Math.tan(latRad);
    const asinh = Math.log(val + Math.sqrt(val * val + 1));
    return Math.floor((n / 2) * (1 - asinh / Math.PI));
}

