import * as THREE from 'three';

export class GlobeControls {
    constructor(camera, domElement, globeMesh) {
        this.camera = camera;
        this.domElement = domElement;
        this.globeMesh = globeMesh; // The object to rotate (usually a group containing globe + tiles)

        this.isDragging = false;
        this.previousPoint = new THREE.Vector3();
        this.currentPoint = new THREE.Vector3();

        this.raycaster = new THREE.Raycaster();

        // Temporary variables to avoid allocation
        this._tempVector = new THREE.Vector3();
        this._tempQuaternion = new THREE.Quaternion();

        this.enabled = true;

        // Bind events
        this.onMouseDown = this.onMouseDown.bind(this);
        this.onMouseMove = this.onMouseMove.bind(this);
        this.onMouseUp = this.onMouseUp.bind(this);

        this.domElement.addEventListener('mousedown', this.onMouseDown);
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
    }

    getIntersection(event) {
        const rect = this.domElement.getBoundingClientRect();
        const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        const y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera({ x, y }, this.camera);

        // Raycast against a perfect sphere for consistent rotation
        // (Assuming globe is at 0,0,0 with radius ~100)
        // We can use a mathematical sphere intersection instead of mesh intersection for performance and smoothness

        // Sphere center in world space
        const sphereCenter = new THREE.Vector3(0, 0, 0);
        if (this.globeMesh) {
            this.globeMesh.getWorldPosition(sphereCenter);
        }

        // Assume radius 100 for interaction (matches GlobeManager)
        const radius = 100;

        // Ray-Sphere intersection
        const ray = this.raycaster.ray;
        const target = this._tempVector.subVectors(ray.origin, sphereCenter);

        const a = ray.direction.dot(ray.direction);
        const b = 2 * target.dot(ray.direction);
        const c = target.dot(target) - radius * radius;

        const delta = b * b - 4 * a * c;

        if (delta < 0) return null; // No intersection

        const t = (-b - Math.sqrt(delta)) / (2 * a);

        if (t < 0) return null; // Behind camera

        const intersectionPoint = new THREE.Vector3().copy(ray.origin).addScaledVector(ray.direction, t);

        // Convert to local space of the globe mesh (if it were rotated, but we want the point on the "ideal" sphere)
        // Actually, we want the vector from center to intersection
        return intersectionPoint.sub(sphereCenter);
    }

    onMouseDown(event) {
        if (!this.enabled) return;
        if (event.button !== 0) return; // Only left click

        const point = this.getIntersection(event);
        if (point) {
            this.isDragging = true;
            this.previousPoint.copy(point);
            this.domElement.style.cursor = 'grabbing';
        }
    }

    onMouseMove(event) {
        if (!this.enabled || !this.isDragging) return;

        const point = this.getIntersection(event);
        if (point) {
            this.currentPoint.copy(point);

            // Calculate rotation from previousPoint to currentPoint
            // We want to rotate the globe such that the point under the mouse *stays* under the mouse.
            // So if the mouse moved from A to B, we want to rotate the globe so that the point that WAS at A is now at B?
            // Wait.
            // If I click at A (on screen), the point on the globe is P.
            // If I move mouse to B (on screen), I want P to move to B.
            // So I need to rotate the globe by the rotation that takes A (projected on sphere) to B (projected on sphere).
            // Let v1 = previousPoint (on sphere surface)
            // Let v2 = currentPoint (on sphere surface)
            // We need a rotation R such that R * v1 = v2?
            // No, if we rotate the globe, the point P moves.
            // We want the point P to be at v2.
            // Currently P is at v1.
            // So yes, we apply the rotation that takes v1 to v2.

            // Axis of rotation: v1 x v2
            // Angle: acos(v1 . v2 / (|v1|*|v2|))

            const v1 = this.previousPoint.normalize();
            const v2 = this.currentPoint.normalize();

            const axis = new THREE.Vector3().crossVectors(v1, v2).normalize();
            const angle = Math.acos(Math.min(1, Math.max(-1, v1.dot(v2)))); // Clamp for safety

            if (angle > 0.0001) {
                const q = this._tempQuaternion.setFromAxisAngle(axis, angle);

                // Apply rotation to globe
                // Note: We are calculating the rotation in WORLD space (since camera/ray are world).
                // So we should apply it in world space.
                // this.globeMesh.quaternion.premultiply(q); // Apply world rotation

                // Wait, if we use premultiply, it applies rotation relative to parent?
                // If parent is scene (identity), then world == local.
                // Yes.

                this.globeMesh.applyQuaternion(q);

                // Update previous point to be the current point (since we moved the globe, the point P is now at v2)
                // But wait.
                // If we rotate the globe, P moves to v2.
                // The mouse is at v2.
                // So for the NEXT frame, the "previous" mouse position corresponds to v2.
                // So yes, update previousPoint to currentPoint.
                this.previousPoint.copy(this.currentPoint);
            }
        } else {
            // Mouse went off-globe.
            // We can either stop dragging or project to edge.
            // For now, just stop updating previousPoint, but keep isDragging true?
            // Or stop dragging?
            // Let's just do nothing this frame.
        }
    }

    onMouseUp(event) {
        this.isDragging = false;
        this.domElement.style.cursor = 'auto';
    }

    dispose() {
        this.domElement.removeEventListener('mousedown', this.onMouseDown);
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
    }
}
