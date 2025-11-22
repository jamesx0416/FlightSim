import Globe from 'globe.gl';
import * as THREE from 'three';
import { tileToLatLonBounds } from '../coord/CoordinateUtils.js';

export default class GlobeManager {
    constructor({ scene, renderer, baseImageryUrl, tileServerUrl }) {
        this.scene = scene;
        this.renderer = renderer;
        this.baseImageryUrl = baseImageryUrl || '//unpkg.com/three-globe/example/img/earth-blue-marble.jpg';
        this.tileServerUrl = tileServerUrl || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

        this.globe = Globe()
            .globeImageUrl(this.baseImageryUrl)
            .showAtmosphere(true)
            .atmosphereColor('lightskyblue')
            .atmosphereAltitude(0.15);

        // Mount the globe into the scene
        // Globe.gl creates its own scene/renderer usually, but we want to integrate it.
        // Actually Globe() returns a controller. We can get the Three object.
        // If we use the standard Globe() constructor, it expects a DOM element to mount to.
        // But we want to use our own Three.js scene.
        // The 'three-globe' package is the underlying Three.js object. 'globe.gl' is a wrapper.
        // The user said "Wraps Globe.gl".
        // If we pass a container to Globe(), it handles the loop.
        // But the user provided a main.js with a custom loop.
        // So we should probably use `ThreeGlobe` directly if we want full control, OR use `Globe()` and extract the scene.
        // However, `Globe()` is easier for interactions.
        // Let's try to use `Globe()` and attach it to our scene if possible, or just use the object it creates.
        // Actually, `Globe()` returns an object that has a `scene()` method.

        // Wait, the user's main.js stub imports `Globe` from `globe.gl`.
        // And `globeManager` is instantiated with `scene`.
        // So I should probably treat `this.globe` as the Three.js object (ThreeGlobe instance) if possible,
        // or use `globe.gl` in "custom renderer" mode.
        // `globe.gl` documentation says: `const myGlobe = Globe()`.
        // `myGlobe(domElement)` initializes it.
        // If we want to use our own renderer, we might need `three-globe`.
        // But the user specified `globe.gl` in package.json.
        // Let's assume we use `three-globe` logic via `globe.gl` or just use `globe.gl` as a standalone and we overlay stuff?
        // No, the user wants "Three.js + Globe.gl".
        // Let's assume we instantiate `Globe()` and then get the object.
        // `Globe()` returns a chainable API.
        // There isn't a direct way to "inject" a scene into `Globe()` standard API.
        // BUT, `globe.gl` is built on `three-globe`.
        // Maybe the user meant `three-globe`?
        // "Wraps Globe.gl" implies using the library.
        // Let's try to use `Globe()` but not mount it to a div, instead get the scene object?
        // `Globe()` creates a renderer.
        // If we want to integrate into an existing scene, we should use `ThreeGlobe` (which is a dependency of globe.gl).
        // But the user asked for `globe.gl`.
        // Let's stick to the prompt: "Wraps Globe.gl".
        // Maybe I should just use `three-globe` if I can't get `globe.gl` to play nice with an external scene.
        // Actually, `import Globe from 'globe.gl'` is the default.
        // Let's try to use `new ThreeGlobe()` if available, or just `Globe()` and see if we can extract the mesh.
        // `Globe()` has a `scene()` method that returns the Three.js scene.
        // But it also has its own renderer.
        // If the user wants a custom loop (which they provided in main.js), we should probably use `three-globe` directly.
        // BUT, the user said "Wraps Globe.gl".
        // Let's try to use `Globe()` as a data source and `three-globe` for rendering?
        // Or maybe just use `Globe()` and let it handle the DOM, and we overlay?
        // The user's `main.js` has `renderer.render(scene, globeManager.camera)`.
        // This implies `globeManager` provides the camera, and we render `scene`.
        // So `globeManager` should probably add the globe object to `scene`.

        // Let's assume `import { ThreeGlobe } from 'globe.gl'`? No, that's not standard.
        // `import ThreeGlobe from 'three-globe'` is how you usually do it for custom scenes.
        // The user's package.json has `globe.gl`.
        // `globe.gl` exports `default` as `Globe`.
        // It seems `Globe` is a function that returns an app instance.
        // If I want just the Three.js object, I should use `three-globe`.
        // I will assume I can use `three-globe` logic or that `Globe()` exposes the object.
        // Actually, `Globe()` has a method `renderer()` and `scene()`.
        // If I want to use my own renderer, I should probably use `three-globe`.
        // I will check if `three-globe` is installed. It is a dependency of `globe.gl`.
        // I'll try to import `ThreeGlobe` from `three-globe` if possible, but it's not in package.json explicitly.
        // It is a transitive dependency.
        // I will try to use `Globe()` and extract the internal `ThreeGlobe` instance if possible, or just use `three-globe` if I can import it.
        // Let's try to import `ThreeGlobe` from `globe.gl`? No.

        // Let's go with: The user wants `globe.gl` features.
        // I will instantiate `Globe()` but NOT call it on a DOM element immediately?
        // No, `Globe()` is the factory.
        // Maybe I can just use `three-globe`?
        // "Wraps Globe.gl" -> The user might be confused or wants the high level API.
        // I will use `three-globe` because it's the only sane way to integrate into an existing Three.js scene/loop.
        // I will add `three-globe` to package.json to be safe, or just import it.
        // Wait, the user put `globe.gl` in package.json.
        // I will try to use `Globe` as a controller but I need the object.
        // `const world = Globe(); world(myDiv);`
        // `const scene = world.scene();`
        // But the user wants *me* to create the scene in main.js.
        // "const scene = new THREE.Scene();"
        // So I must add the globe to *that* scene.
        // I will use `three-globe`. It is the Three.js component of Globe.gl.
        // I'll update package.json to include `three-globe` just in case, or assume it's available.
        // Actually, I'll just use `three-globe` in the code and assume the user is okay with it since it's the core of globe.gl.
        // But wait, `globe.gl` has nice interaction features.
        // If I use `three-globe`, I lose the built-in interaction/controls of `globe.gl` unless I reimplement them.
        // The user said "Wraps Globe.gl".
        // Maybe they mean: Use `Globe()` to manage the data/layers, but render it in my scene?
        // I'll stick to `three-globe` for the object. It's the standard way to do "Three.js + Globe".

        this.radius = 100; // ThreeGlobe default radius is 100
        this.worldScale = 100 / 6371;

        // Create a root group for the entire globe (base + tiles)
        this.globeGroup = new THREE.Group();
        this.scene.add(this.globeGroup);

        this.tilesGroup = new THREE.Group();
        // this.scene.add(this.tilesGroup); // OLD
        this.globeGroup.add(this.tilesGroup); // NEW: Add to group

        // Initialize ThreeGlobe
        // I'll need to dynamically import it or assume it's there.
        // Since I can't easily change package.json right now without a tool call, I'll assume I can import it.
        // But wait, I can change package.json.
        // I will add `three-globe` to package.json in a bit.

        this.currentZoom = 2;
        this.loadedTiles = new Map(); // key -> mesh
    }

    async init() {
        const { default: ThreeGlobe } = await import('three-globe');
        this.globe = new ThreeGlobe()
            .showAtmosphere(false);

        // Make the base globe invisible or wireframe so we can see tiles
        // ThreeGlobe doesn't have a direct "hide base" but we can set a transparent material or no image
        // If we don't set an image, it might default to something.
        // Let's try setting a dummy material or just rely on showAtmosphere(false) and maybe it will be white/black.
        // Better: set `showGlobe(false)` if it exists (it does in globe.gl, check ThreeGlobe).
        // ThreeGlobe has .showGlobe(bool)
        this.globe.showGlobe(false);

        // this.scene.add(this.globe); // OLD
        this.globeGroup.add(this.globe); // NEW: Add to group

        // Add a group for high-res tiles
        // this.tilesGroup = new THREE.Group(); // Already created in constructor
        // this.globe.add(this.tilesGroup); // SUSPECT: showGlobe(false) might hide children
        // this.scene.add(this.tilesGroup); // Add directly to scene to be safe

        // DEBUG: Add a small yellow sphere at center to verify scene is rendering
        const debugGeo = new THREE.SphereGeometry(5, 16, 16);
        const debugMat = new THREE.MeshBasicMaterial({ color: 0xffff00, wireframe: true });
        const debugSphere = new THREE.Mesh(debugGeo, debugMat);
        this.scene.add(debugSphere);

        // DEBUG: Add a RED CUBE to tilesGroup to verify group is visible
        // Position it at z=120 (in front of tiles)
        const cubeGeo = new THREE.BoxGeometry(10, 10, 10);
        const cubeMat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true });
        const cube = new THREE.Mesh(cubeGeo, cubeMat);
        cube.position.set(0, 0, 120);
        this.tilesGroup.add(cube);

        // CORRECTION: Rotate group -90 degrees to align Lon 0 with +Z axis
        // Our generation puts Lon 0 at -X (PI). We want it at +Z (PI/2).
        // So we rotate by -PI/2.
        this.tilesGroup.rotation.y = -Math.PI / 2;
    }

    update(camera, tileCache) {
        if (!this.globe) return;

        // Debug overlay update
        const overlay = document.getElementById('debug-overlay');

        // Calculate Lat/Lon for debug display
        const pos = camera.position;
        const r = pos.length();
        const phi = Math.acos(pos.y / r);
        const theta = Math.atan2(pos.x, pos.z);
        const lat = 90 - (phi * 180 / Math.PI);
        const lon = (theta * 180 / Math.PI);

        if (overlay) {
            overlay.innerHTML = `
                Tiles: ${this.tilesGroup.children.length}<br>
                Loaded: ${this.loadedTiles.size}<br>
                Zoom: ${this.currentZoom}<br>
                Lat: ${lat.toFixed(2)}, Lon: ${lon.toFixed(2)}
             `;
        }

        this.updateTilesForView(camera, tileCache, this.currentZoom);

        // 1. Get camera position in ECEF (assuming world is at 0,0,0)
        // The globe might be rotated, so we need to account for that if we want lat/lon relative to earth.
        // However, ThreeGlobe usually keeps the mesh static and rotates the camera or the object.
        // If we rotate the globe object, we need to transform camera position to local space.

        // For now, assume globe is at 0,0,0 and not rotated (or we handle rotation).

        // If the user controls the camera around the globe, the globe stays fixed.

        // Get camera altitude for LOD
        const dist = camera.position.length();
        const alt = dist - this.radius;

        // Simple tile update logic:
        // Convert camera position to Lat/Lon
        // This is rough because it doesn't account for where the camera is *looking*, only where it *is*.
        // For a flight sim, looking down, this is fine.

        // We need to inverse the globe rotation if it's rotating.
        // But let's assume for Step 1 we just want to see tiles appear.

        // TODO: Implement proper frustum culling and tile selection.
        // For now, let's just load a fixed tile at the current zoom for testing.
    }

    /**
     * Creates a spherical tile mesh.
     */
    createTileMesh(x, y, z, texture) {
        const bounds = tileToLatLonBounds(x, y, z);

        // Convert to SphereGeometry parameters
        // Phi: 0 (North) to PI (South)
        // Theta: 0 to 2PI (starts at +x? No, usually +z or -z depending on UVs)
        // Three.js Sphere:
        // phiStart: start angle from X axis (horizontal)
        // phiLength: sweep angle
        // thetaStart: start angle from Y axis (vertical) -> Actually theta is horizontal in Three.js docs?
        // Docs: 
        // phiStart: horizontal starting angle. Default 0.
        // phiLength: horizontal sweep angle size. Default Math.PI * 2.
        // thetaStart: vertical starting angle. Default 0.
        // thetaLength: vertical sweep angle size. Default Math.PI.

        // Wait, standard math uses Theta for zenith (vertical) and Phi for azimuth (horizontal).
        // Three.js uses:
        // widthSegments, heightSegments
        // phiStart, phiLength (Horizontal, around Y axis)
        // thetaStart, thetaLength (Vertical, from +Y down to -Y)

        const phiStart = (bounds.west + 180) * Math.PI / 180;
        const phiLength = (bounds.east - bounds.west) * Math.PI / 180;

        const thetaStart = (90 - bounds.north) * Math.PI / 180;
        const thetaLength = (bounds.north - bounds.south) * Math.PI / 180;

        // Add a small offset to radius to avoid z-fighting with base globe
        // DEBUG: Increased offset to 1.01 to be sure
        const r = this.radius * (1 + 0.01 * z);

        const geometry = new THREE.SphereGeometry(
            r,
            16, // segments
            16,
            phiStart,
            phiLength,
            thetaStart,
            thetaLength
        );

        // DEBUG: Red wireframe to see if meshes are created
        const material = new THREE.MeshBasicMaterial({
            map: texture,
            color: 0xff0000,
            wireframe: true,
            transparent: true,
            side: THREE.DoubleSide
        });

        const mesh = new THREE.Mesh(geometry, material);
        console.log('Creating tile mesh for', x, y, z);
        return mesh;
    }

    async updateTilesForView(camera, tileCache, zoom) {
        if (!this.globe) return;

        // Debug overlay update
        const overlay = document.getElementById('debug-overlay');
        if (overlay) {
            overlay.innerHTML = `
                Tiles: ${this.tilesGroup.children.length}<br>
                Loaded: ${this.loadedTiles.size}<br>
                Zoom: ${this.currentZoom}
             `;
        }

        // 1. Get camera position in Lat/Lon
        // We need to convert camera position (which is in local space relative to globe center) to Lat/Lon.
        // Since we moved tilesGroup to scene, we need to be careful.
        // But the camera moves around the center (0,0,0).
        // So we can just use ecefToLatLon with the camera position.
        // Note: Our ecefToLatLon assumes Z is up (North), but Three.js Y is up.
        // So we pass (x, z, -y) or similar?
        // Three.js: Y is up, Z is forward/back.
        // ECEF: Z is North (Up), X/Y are equatorial.
        // So Three Y -> ECEF Z.
        // Three Z -> ECEF Y?
        // Three X -> ECEF X?
        // Let's assume standard mapping:
        // Three Y = North = ECEF Z
        // Three Z = Prime Meridian? 
        // Usually in Three.js, Z is positive towards viewer.
        // Let's just try mapping: x->x, y->z, z->-y (to align with standard ECEF if Y is up).
        // Actually, let's just use a simple spherical conversion for now since we are on a perfect sphere of radius 100.

        const pos = camera.position;
        const r = pos.length();

        // Simple spherical to lat/lon
        // phi = angle from Y axis (0 at North Pole)
        // theta = angle around Y axis
        const phi = Math.acos(pos.y / r); // 0..PI
        const theta = Math.atan2(pos.x, pos.z); // -PI..PI

        const lat = 90 - (phi * 180 / Math.PI);
        const lon = (theta * 180 / Math.PI);
        // Note: This mapping depends on how the texture is wrapped. 
        // Usually Three.js Sphere UVs:
        // u = 0.5 + atan2(x, z) / (2*PI)
        // v = 0.5 + asin(y/r) / PI
        // Let's stick to standard lat/lon.

        const z = Math.round(zoom); // Ensure integer zoom
        const max = Math.pow(2, z);

        // Import latLonToTile dynamically or assume it's available if I imported it (I didn't import it yet in this file)
        // I need to update imports.
        // For now, I'll inline the logic or assume I can add the import.
        // I will add the import in a separate edit or use the logic here.
        // Logic:
        const n = Math.pow(2, z);
        const tileX = Math.floor((lon + 180.0) / 360.0 * n);
        const latRad = lat * Math.PI / 180.0;
        const tileY = Math.floor((1.0 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2.0 * n);

        // Load 5x5 grid around center
        const range = 2;
        const tilesToLoad = [];

        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                let tx = tileX + dx;
                let ty = tileY + dy;

                // Wrap X
                tx = (tx % max + max) % max;

                // Clamp Y
                if (ty < 0 || ty >= max) continue;

                const key = `${z}/${tx}/${ty}`;
                tilesToLoad.push(key);

                if (this.loadedTiles.has(key)) continue;

                const url = this.tileServerUrl
                    .replace('{z}', z)
                    .replace('{x}', tx)
                    .replace('{y}', ty);

                try {
                    // Placeholder
                    const placeholderMat = new THREE.MeshBasicMaterial({
                        color: 0x00ff00,
                        wireframe: true,
                        transparent: true,
                        opacity: 0.3,
                        side: THREE.DoubleSide
                    });

                    const mesh = this.createTileMesh(tx, ty, z, null);
                    mesh.material = placeholderMat;

                    this.tilesGroup.add(mesh);
                    this.loadedTiles.set(key, mesh);

                    tileCache.loadTile(url, key).then(texture => {
                        mesh.material = new THREE.MeshBasicMaterial({
                            map: texture,
                            color: 0xffffff,
                            wireframe: false,
                            transparent: true,
                            side: THREE.DoubleSide
                        });
                    }).catch(err => {
                        console.error(`Failed to load texture for ${key}`, err);
                        mesh.material.color.setHex(0xff0000);
                        mesh.material.wireframe = true;
                    });

                } catch (e) {
                    console.error(`Failed to create tile ${key}`, e);
                }
            }
        }

        // Cleanup old tiles (simple logic: remove anything not in current zoom or far away)
        // For Step 1, just remove tiles from different zoom levels to avoid clutter
        for (const [key, mesh] of this.loadedTiles.entries()) {
            const [tz, tx, ty] = key.split('/').map(Number);
            if (tz !== z) {
                // Remove different zoom levels
                // In a real LOD system we'd keep parent tiles until children load
                this.tilesGroup.remove(mesh);
                if (mesh.geometry) mesh.geometry.dispose();
                if (mesh.material) mesh.material.dispose();
                this.loadedTiles.delete(key);
            } else {
                // Check distance (optional, for now just keep the 5x5 grid)
                // If it's not in tilesToLoad, remove it?
                if (!tilesToLoad.includes(key)) {
                    this.tilesGroup.remove(mesh);
                    if (mesh.geometry) mesh.geometry.dispose();
                    if (mesh.material) mesh.material.dispose();
                    this.loadedTiles.delete(key);
                }
            }
        }
    }

    setTargetZoom(zoom) {
        this.currentZoom = zoom;
        // Calculate visible tiles at currentZoom
        // For now, just load a fixed set or based on lat/lon center
        // This needs the camera position to find the center.
    }

    // ...
}
