import * as THREE from "three";
import {
    RADIUS,
    STARTING_RADIUS,
    ZOOM_SPEED_BUTTON,
    ZOOM_SPEED_WHEEL,
    MIN_ALTITUDE,
    MAX_ALTITUDE_FACTOR
} from "./Constants.js";

/**
 * Orbital camera controls for navigating around the globe.
 * 
 * Supports:
 * - Mouse drag for latitude/longitude rotation
 * - Mouse wheel for altitude zoom
 * - Button controls for zoom in/out
 * 
 * The camera orbits around the Earth's center (origin) using spherical coordinates.
 * 
 * @example
 * const controls = new Controls(camera, canvas, () => console.log('Zoom changed'));
 * // In animation loop:
 * controls.updateCamera();
 */
export class Controls {
    /**
     * Creates orbital camera controls.
     * 
     * @param {THREE.PerspectiveCamera} camera - The camera to control
     * @param {HTMLCanvasElement} canvas - The canvas element for mouse events
     * @param {Function} onZoomChange - Callback invoked when zoom/radius changes
     */
    constructor(camera, canvas, onZoomChange) {
        this.camera = camera;
        this.canvas = canvas;
        /** @type {Function} Callback when zoom/radius changes */
        this.onZoomChange = onZoomChange;

        /** @type {boolean} Whether a drag operation is in progress */
        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Initial position
        this.initialPhi = Math.PI / 2.4;
        this.initialTheta = Math.PI / 2;

        /** @type {number} Horizontal angle (longitude) in radians */
        this.theta = this.initialTheta;
        /** @type {number} Vertical angle (latitude) in radians */
        this.phi = this.initialPhi;
        /** @type {number} Distance from Earth center */
        this.radius = STARTING_RADIUS;
        /** @type {THREE.Vector3} Point the camera looks at (Earth center) */
        this.target = new THREE.Vector3(0, 0, 0);

        // Initialize camera
        this.updateCamera();

        this.setupEventHandlers();
    }

    setupEventHandlers() {
        const zoomInBtn = document.getElementById("zoomIn");
        const zoomOutBtn = document.getElementById("zoomOut");

        if (zoomInBtn) {
            zoomInBtn.onclick = () => {
                this.radius = Math.max(RADIUS + MIN_ALTITUDE, this.radius * (1 - ZOOM_SPEED_BUTTON));
                this.onZoomChange();
            };
        }

        if (zoomOutBtn) {
            zoomOutBtn.onclick = () => {
                this.radius = Math.min(RADIUS * (1 + MAX_ALTITUDE_FACTOR), this.radius * (1 + ZOOM_SPEED_BUTTON));
                this.onZoomChange();
            };
        }

        this.canvas.addEventListener("mousedown", (e) => {
            this.isDragging = true;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;
        });

        window.addEventListener("mouseup", () => {
            this.isDragging = false;
        });

        window.addEventListener("mousemove", (e) => {
            if (!this.isDragging) return;

            const deltaX = this.lastMouseX - e.clientX;
            const deltaY = e.clientY - this.lastMouseY;
            this.lastMouseX = e.clientX;
            this.lastMouseY = e.clientY;

            const altitude = Math.max(10, this.radius - RADIUS);
            const fovRad = (this.camera.fov * Math.PI) / 180;
            const visibleHeight = 2 * altitude * Math.tan(fovRad / 2);
            const radiansPerPixel = visibleHeight / (RADIUS * window.innerHeight);

            this.theta -= deltaX * radiansPerPixel / Math.sin(this.phi);
            this.phi -= deltaY * radiansPerPixel;

            const PHI_MIN = 0.01;
            const PHI_MAX = Math.PI - 0.01;
            this.phi = Math.max(PHI_MIN, Math.min(PHI_MAX, this.phi));

            this.updateCamera();
        });

        this.canvas.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                const delta = e.deltaY;

                let altitude = this.radius - RADIUS;
                const factor = 1 + delta * ZOOM_SPEED_WHEEL;
                altitude *= factor;

                altitude = Math.max(MIN_ALTITUDE, Math.min(RADIUS * MAX_ALTITUDE_FACTOR, altitude));

                this.radius = RADIUS + altitude;
                this.onZoomChange();
                this.updateCamera();
            },
            { passive: false }
        );
    }

    updateCamera() {
        const x = this.radius * Math.sin(this.phi) * Math.cos(this.theta);
        const y = this.radius * Math.cos(this.phi);
        const z = this.radius * Math.sin(this.phi) * Math.sin(this.theta);

        this.camera.position.set(x, y, z);
        this.camera.lookAt(this.target);
    }


}
