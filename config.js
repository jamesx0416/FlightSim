// config.js
console.log("=== CONFIG.JS LOADING ===");
export const CONFIG = {
    // GOOGLE_API_KEY: 'YOUR_API_KEY_HERE', // User must provide this
    // TILESET_URL: 'https://tile.googleapis.com/v1/3dtiles/root.json',

    // For testing without a key (fallback mode), or replace with real key
    GOOGLE_API_KEY: '',

    // Google 3D Tiles Root URL (requires key)
    GOOGLE_3D_TILES_URL: 'https://tile.googleapis.com/v1/3dtiles/root.json',

    // Fallback imagery (e.g., a free satellite layer or just a color)
    // Using a placeholder grid or low-res earth texture for now
    FALLBACK_IMAGERY_URL: 'https://unpkg.com/three-globe/example/img/earth-blue-marble.jpg',

    // Cesium Ion Configuration
    // If CESIUM_ION_TOKEN is provided, it will attempt to load the asset defined by CESIUM_ION_ASSET_ID
    // Default Asset ID 2275207 is "Google Photorealistic 3D Tiles" on Cesium Ion
    CESIUM_ION_TOKEN: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2NmU2NTRlNC05MTBkLTRjMWMtYjA2Ny03OGQ4ZTMzYTlhYTMiLCJpZCI6MzUxNTIwLCJpYXQiOjE3NjA3MDQzMDJ9.VX86TPLi2ZSPLmhiRtrzPtaEU98t5XNGREa2BLPeKYs',
    CESIUM_ION_ASSET_ID: 2275207,

    // Camera / Control settings
    INITIAL_LAT: 40.7128, // NYC
    INITIAL_LON: -74.0060,
    INITIAL_ALT: 10000000, // Start high up

    // LOD Settings
    FOCUS_RADIUS: 5000, // Meters
    MAX_CONCURRENT_FETCHES: 8,
};
