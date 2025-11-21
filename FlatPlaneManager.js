import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";
import { RADIUS, GRID_SIZE } from "./Constants.js";
import { lonLatToVector3 } from "./Utils.js";

export class FlatPlaneManager {
    constructor(scene) {
        this.scene = scene;
        this.mesh = null;
        this.visible = false;
        this.init();
    }

    init() {
        // Create a decent sized plane
        // Size should be enough to cover the view at high zoom
        // At zoom 12, visible area is small.
        // Let's make it 1 unit size (100km) for now.
        const geometry = new THREE.PlaneGeometry(1, 1, GRID_SIZE, GRID_SIZE);

        // Simple grid material for now
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            wireframe: true,
            side: THREE.DoubleSide
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.visible = false;
        this.scene.add(this.mesh);
    }

    update(visible, cameraParams) {
        this.visible = visible;
        this.mesh.visible = visible;

        if (visible && cameraParams) {
            const { phi, theta, radius } = cameraParams;

            // Position the plane at the surface point below the camera
            // Camera is at (phi, theta, radius)
            // Surface point is at (phi, theta, RADIUS)

            // Convert spherical to cartesian
            const x = RADIUS * Math.sin(phi) * Math.cos(theta);
            const y = RADIUS * Math.cos(phi);
            const z = RADIUS * Math.sin(phi) * Math.sin(theta);

            this.mesh.position.set(x, y, z);

            // Orient the plane to be tangent to the sphere
            // The normal of the sphere at (x,y,z) is (x,y,z) normalized.
            // We want the plane normal to match the sphere normal.
            this.mesh.lookAt(0, 0, 0); // Plane looks at center, so its normal points to center?
            // PlaneGeometry normal is (0,0,1).
            // lookAt makes the object's +Z axis point to target.
            // So if we lookAt(0,0,0), the normal points to center.
            // This is correct for a tangent plane (facing OUT)?
            // Wait, if normal points to center, it's facing IN.
            // We want it to face OUT.
            // So lookAt(2*x, 2*y, 2*z)?
            this.mesh.lookAt(2 * x, 2 * y, 2 * z);
        }
    }
}
