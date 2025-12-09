import * as THREE from "three";
import { RADIUS, STARTING_RADIUS } from "./Constants.js";

export class Controls {
    constructor(camera, canvas, onZoomChange) {
        this.camera = camera;
        this.canvas = canvas;
        this.onZoomChange = onZoomChange; // Callback when zoom/radius changes

        this.isDragging = false;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        // Initial position
        this.initialPhi = Math.PI / 2.4;
        this.initialTheta = Math.PI / 2;

        this.theta = this.initialTheta;
        this.phi = this.initialPhi;
        this.radius = STARTING_RADIUS;
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
                const ZOOM_SPEED = 0.2;
                this.radius = Math.max(RADIUS + 100, this.radius * (1 - ZOOM_SPEED));
                this.onZoomChange();
            };
        }

        if (zoomOutBtn) {
            zoomOutBtn.onclick = () => {
                const ZOOM_SPEED = 0.2;
                this.radius = Math.min(RADIUS * 5, this.radius * (1 + ZOOM_SPEED));
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
                const ZOOM_SPEED = 0.001;

                let altitude = this.radius - RADIUS;
                const factor = 1 + delta * ZOOM_SPEED;
                altitude *= factor;

                const MIN_ALT = 100;
                const MAX_ALT = RADIUS * 4;
                altitude = Math.max(MIN_ALT, Math.min(MAX_ALT, altitude));

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
