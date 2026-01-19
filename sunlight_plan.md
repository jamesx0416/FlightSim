# Sunlight, Rotation, and Shadows Plan

## Goal
Add realistic lighting (Sun), support for shadows on 3D tiles, and Earth rotation (Day/Night cycle) to the flight simulator.

## User Requirements
1. Add Sun/Sunlight
2. Make the Earth Rotate
3. Enable Shadows on 3D tiles

## Technical Approach

### 1. Sunlight (Directional Light)
- Replace/Augment the static `HemisphereLight` with a `THREE.DirectionalLight`.
- The light's position will simulate the Sun.
- Since the Earth (0,0,0) is the center, the Sun should orbit at a large distance.

### 2. Shadows
- **Renderer**: Enable `renderer.shadowMap.enabled = true` (PCSoftShadowMap).
- **Light**: Set `sunLight.castShadow = true`. Configure shadow camera frustum to cover the visible Earth section.
- **Tiles**: 
  - The `3d-tiles-renderer` loads GLTF models. We need to intercept the loaded meshes.
  - Use `manager.onLoadModel` (or traverse loaded scene) to set `node.castShadow = true` and `node.receiveShadow = true`.
  - **Challenge**: Shadows at planetary scale are tricky due to precision. We may need to use "Cascaded Shadow Maps" or just tune a large Directional Light shadow camera that tracks the viewer.

### 3. Earth Rotation
- **Interpretation**: "Make the Earth rotate" usually means simulating the diurnal cycle.
- **Method**: Instead of physically rotating the `TilesRenderer` group (which messes up ECEF coordinates and `GlobeControls`), we will **rotate the Sun** around the Earth.
- **Visuals**: This effectively creates "Earth rotation" from the perspective of a fixed observer or space.
- **Implementation**: 
  - Add a `time` variable.
  - Calculate Sun position based on time.
  - Update `sunLight.position` every frame.

## Proposed Changes

### `main.js`
- Enable shadow map on renderer.
- Initialize `SunLight` setup.
- Add animation loop update for Sun position.

### `Tiles3DManager.js`
- Add logic to enable shadows on loaded tile meshes.
- `tilesRenderer.onLoadModel = (scene) => { scene.traverse(c => { if(c.isMesh) { c.castShadow=true; c.receiveShadow=true; } }); }`

### `Constants.js`
- Add Sun distance, shadow map settings.

## Verification
- Visual check: Can see shadows of buildings/terrain?
- Visual check: Does the sun move?
- Visual check: Does it get dark at night?
