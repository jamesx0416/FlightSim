export const RADIUS = 6378137;
export const MAX_ZOOM = 19;
export const MIN_ZOOM = 4;
export const LOAD_LIMIT = 20;

export const TEXTURE_SIZE = 256;
export const STARTING_RADIUS = RADIUS * 2;
export const CULLING_BUFFER = 1.3;
export const TILE_SOURCE = 'esri';

// Camera constraints
export const CAMERA_NEAR_PLANE = 1;
export const CAMERA_FAR_PLANE_FACTOR = 10;
export const MIN_ALTITUDE = 10;
export const MAX_ALTITUDE_FACTOR = 4;

// Zoom controls
export const ZOOM_SPEED_BUTTON = 0.2;
export const ZOOM_SPEED_WHEEL = 0.001;

// Horizon culling
export const MAX_TILE_ANGULAR_SIZE = 0.8;  // ~45 degrees in radians
export const HORIZON_BUFFER_FACTOR = 1.5;

// Earth constants
export const WGS84_RADIUS = 6378137;  // Earth radius in meters (WGS84)

// Draco decoder
export const DRACO_DECODER_PATH = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';

// Rendering
export const RENDER_PIXEL_RATIO = window.devicePixelRatio; // Use window.devicePixelRatio for max sharpness
export const TILE_ERROR_TARGET = 6; // Lower = higher quality (more tiles), Higher = better performance

// Lighting
export const SUN_DISTANCE = RADIUS * 20;
export const SUN_INTENSITY = 2.0;
export const AMBIENT_INTENSITY = 0.3;
export const DAY_CYCLE_SPEED = 0.00001;

// Shadows
export const SHADOW_MAP_SIZE = 2048;
export const SHADOW_CAMERA_SIZE = RADIUS * 2;
