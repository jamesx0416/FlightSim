export default class LODManager {
    constructor({ camera, globeRadius, onZoomLevelChanged }) {
        this.camera = camera;
        this.globeRadius = globeRadius || 6371; // km, but usually in world units
        this.onZoomLevelChanged = onZoomLevelChanged;
        this.currentZoom = 0;
        this.minZoom = 2;
        this.maxZoom = 19;

        // Altitude thresholds (approximate, in world units assuming radius ~6371)
        // These need tuning based on the actual scale used in GlobeManager
        this.zoomThresholds = [
            10000, // Zoom 2
            5000,  // Zoom 3
            2500,  // Zoom 4
            1200,  // Zoom 5
            600,   // Zoom 6
            300,   // Zoom 7
            150,   // Zoom 8
            80,    // Zoom 9
            40,    // Zoom 10
            20,    // Zoom 11
            10,    // Zoom 12
            5,     // Zoom 13
            2.5,   // Zoom 14
            1.2,   // Zoom 15
            0.6,   // Zoom 16
            0.3,   // Zoom 17
            0.15,  // Zoom 18
            0.07   // Zoom 19
        ];
    }

    update() {
        if (!this.camera) return;

        // Calculate distance to surface
        // Assuming camera is looking at center or near it, and world is centered at 0,0,0
        const dist = this.camera.position.length();
        const altitude = dist - this.globeRadius;

        // Convert altitude to "Earth km" for the thresholds
        // If globeRadius is 100, and real radius is 6371, then scale is 6371/100 = 63.71
        const altitudeKm = altitude * (6371 / this.globeRadius);

        let newZoom = this.minZoom;

        // Simple threshold check
        // In a real app, we might use a more continuous function or check screen-space error
        for (let i = 0; i < this.zoomThresholds.length; i++) {
            if (altitudeKm < this.zoomThresholds[i]) {
                newZoom = i + 2; // +2 because array starts at zoom 2
            } else {
                break;
            }
        }

        newZoom = Math.min(Math.max(newZoom, this.minZoom), this.maxZoom);

        if (newZoom !== this.currentZoom) {
            this.currentZoom = newZoom;
            if (this.onZoomLevelChanged) {
                this.onZoomLevelChanged(newZoom);
            }
        }
    }

    getCurrentZoom() {
        return this.currentZoom;
    }

    getAltitude() {
        if (!this.camera) return 0;
        const dist = this.camera.position.length();
        return dist - this.globeRadius;
    }
}
