// WGS84 Ellipsoid Constants
export const WGS84_A = 6378137.0; // Semi-major axis
export const WGS84_B = 6356752.314245; // Semi-minor axis
export const WGS84_E2 = 0.00669437999014; // First eccentricity squared

/**
 * Converts Geodetic coordinates (Lat, Lon, Alt) to ECEF (Earth-Centered, Earth-Fixed).
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {number} alt - Altitude in meters
 * @returns {Object} {x, y, z}
 */
export function latLonToECEF(lat, lon, alt = 0) {
    const radLat = (lat * Math.PI) / 180;
    const radLon = (lon * Math.PI) / 180;

    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(radLat) ** 2);

    const x = (N + alt) * Math.cos(radLat) * Math.cos(radLon);
    const y = (N + alt) * Math.cos(radLat) * Math.sin(radLon);
    const z = (N * (1 - WGS84_E2) + alt) * Math.sin(radLat);

    return { x, y, z };
}

/**
 * Converts ECEF coordinates to Geodetic (Lat, Lon, Alt).
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Object} {lat, lon, alt}
 */
export function ecefToLatLon(x, y, z) {
    const p = Math.sqrt(x * x + y * y);
    const theta = Math.atan2(z * WGS84_A, p * WGS84_B);

    const lon = Math.atan2(y, x);
    const lat = Math.atan2(
        z + WGS84_E2 * WGS84_B * Math.sin(theta) ** 3,
        p - WGS84_E2 * WGS84_A * Math.cos(theta) ** 3
    );

    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    const alt = p / Math.cos(lat) - N;

    return {
        lat: (lat * 180) / Math.PI,
        lon: (lon * 180) / Math.PI,
        alt
    };
}

/**
 * Converts ECEF to ENU (East-North-Up) relative to a reference point.
 * @param {Object} ecef - Target ECEF {x, y, z}
 * @param {Object} refLatLon - Reference point {lat, lon, alt}
 * @returns {Object} {x, y, z} (East, North, Up)
 */
export function ecefToENU(ecef, refLat, refLon, refAlt = 0) {
    const refECEF = latLonToECEF(refLat, refLon, refAlt);
    const dx = ecef.x - refECEF.x;
    const dy = ecef.y - refECEF.y;
    const dz = ecef.z - refECEF.z;

    const radLat = (refLat * Math.PI) / 180;
    const radLon = (refLon * Math.PI) / 180;

    const sinLat = Math.sin(radLat);
    const cosLat = Math.cos(radLat);
    const sinLon = Math.sin(radLon);
    const cosLon = Math.cos(radLon);

    const x = -sinLon * dx + cosLon * dy;
    const y = -sinLat * cosLon * dx - sinLat * sinLon * dy + cosLat * dz;
    const z = cosLat * cosLon * dx + cosLat * sinLon * dy + sinLat * dz;

    return { x, y, z };
}

/**
 * Converts ENU to ECEF relative to a reference point.
 * @param {Object} enu - Target ENU {x, y, z}
 * @param {number} refLat
 * @param {number} refLon
 * @param {number} refAlt
 * @returns {Object} {x, y, z} ECEF
 */
export function enuToECEF(enu, refLat, refLon, refAlt = 0) {
    const refECEF = latLonToECEF(refLat, refLon, refAlt);
    const radLat = (refLat * Math.PI) / 180;
    const radLon = (refLon * Math.PI) / 180;

    const sinLat = Math.sin(radLat);
    const cosLat = Math.cos(radLat);
    const sinLon = Math.sin(radLon);
    const cosLon = Math.cos(radLon);

    const dx = -sinLon * enu.x - sinLat * cosLon * enu.y + cosLat * cosLon * enu.z;
    const dy = cosLon * enu.x - sinLat * sinLon * enu.y + cosLat * sinLon * enu.z;
    const dz = cosLat * enu.y + sinLat * enu.z;

    return {
        x: refECEF.x + dx,
        y: refECEF.y + dy,
        z: refECEF.z + dz
    };
}

/**
 * Converts Web Mercator tile coordinates to Lat/Lon bounds.
 * @param {number} x - Tile X
 * @param {number} y - Tile Y
 * @param {number} z - Zoom level
 * @returns {Object} { north, south, east, west } in degrees
 */
export function tileToLatLonBounds(x, y, z) {
    const n = Math.pow(2, z);
    const lon1 = (x / n) * 360.0 - 180.0;
    const lon2 = ((x + 1) / n) * 360.0 - 180.0;

    const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180.0) / Math.PI;
    const lat2 = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 1) / n))) * 180.0) / Math.PI;

    return {
        north: lat1,
        south: lat2,
        east: lon2,
        west: lon1
    };
}

/**
 * Converts Lat/Lon to Web Mercator tile coordinates.
 * @param {number} lat - Latitude in degrees
 * @param {number} lon - Longitude in degrees
 * @param {number} z - Zoom level
 * @returns {Object} { x, y } Tile coordinates
 */
export function latLonToTile(lat, lon, z) {
    const n = Math.pow(2, z);
    const x = Math.floor((lon + 180.0) / 360.0 * n);
    const latRad = lat * Math.PI / 180.0;
    const y = Math.floor((1.0 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2.0 * n);
    return { x, y };
}

