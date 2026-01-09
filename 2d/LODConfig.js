/**
 * Shared LOD configuration used by both main thread and web worker.
 * Defines thresholds for zoom level transitions based on camera distance.
 */
export const LOD_THRESHOLDS = {
    15: 25,    // 25km for zoom 15
    14: 50,    // 50km for zoom 14
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

/**
 * Grazing angle dampening threshold.
 * Below this zoom level, grazing angle affects LOD calculations.
 */
export const GRAZING_ANGLE_THRESHOLD = 10;

/**
 * Minimum dot product for grazing angle calculation.
 */
export const MIN_GRAZING_DOT = 0.5;
