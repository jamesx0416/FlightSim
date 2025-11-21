# FlightSim Development Plan

## 1. System Overview
The application visualizes Earth using a hybrid approach:
- **Far View**: Uses `globe.gl` (ThreeGlobe) for a high-performance, low-resolution spherical base.
- **Mid View**: Overlays high-resolution tiles via `TileManager` as the camera zooms in.
- **Near View (Future/WIP)**: Switches to a local flat plane for flight simulation physics and precision.

## 2. Level of Detail (LOD) System
The LOD system is driven by the camera's altitude (distance from surface).

### Logic
- **Zoom Calculation**: `zoom = -1.4 * log2(altitude) + 11.0`
- **Base Layer**: `ThreeGlobe` renders the base texture (always visible in Far View).
- **Tile Layer**: `TileManager` activates at `zoom >= 4`.
    - Tiles are generated as spherical patches.
    - Tiles fade in using a custom shader to prevent popping.
    - Tiles with `z < 4` are skipped to allow the `ThreeGlobe` base to show.

### Pseudo-code
```javascript
function update(altitude) {
    zoom = calculateZoom(altitude);
    
    if (zoom < 4) {
        // Show only Globe.gl base
        Globe.visible = true;
        TileManager.hideAll();
    } else if (zoom < FLAT_THRESHOLD) {
        // Show Globe.gl + High Res Tiles
        Globe.visible = true;
        TileManager.update(zoom); // Creates/Fades tiles
    } else {
        // Flat Plane Mode
        Globe.visible = false;
        TileManager.hideAll();
        FlatPlane.update(centerPosition);
    }
}
```

## 3. Flat Local Plane Mode
**Trigger**: `zoom > 12` (approx. 10km altitude).

### Behavior
- The spherical globe and tiles are hidden.
- A `FlatPlaneManager` renders a planar grid centered at the camera's sub-point.
- The plane is oriented tangent to the sphere at that point.

### Current Implementation
- The plane is a visual proxy.
- Camera controls remain in spherical coordinates (Orbit).

## 4. Future Transition: Flat Plane to Globe
To support a true flight simulator, the physics and camera must transition between coordinate systems.

### Challenge
- **Sphere**: Physics in spherical coordinates (Lat/Lon/Alt). Gravity points to center.
- **Plane**: Physics in Cartesian coordinates (X/Y/Z). Gravity points down (-Y or -Z).

### Transition Strategy
1.  **Hybrid Coordinate System**:
    - Keep the "World" origin at the airplane's current local sector center.
    - When the airplane moves too far from the center, re-center the world (Floating Origin).
2.  **Interpolation**:
    - When crossing the threshold, blend the visual rendering matrices.
    - **Down (Sphere -> Plane)**: Project sphere surface to plane.
    - **Up (Plane -> Sphere)**: Wrap plane onto sphere.
3.  **Airplane Preservation**:
    - Maintain airplane state as `VelocityVector` and `OrientationQuaternion`.
    - On transition, rotate these vectors by the difference between the "Plane Normal" and "Sphere Normal" at that location.

### Checklist for Future Work
- [ ] Implement `Airplane` class with physics.
- [ ] Create `FloatingOriginManager` to handle coordinate resetting.
- [ ] Implement seamless visual blending (vertex shader morphing between sphere and plane).
- [ ] Add terrain heightmap support to the Flat Plane.
