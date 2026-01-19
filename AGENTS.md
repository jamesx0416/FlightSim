# FlightSim - Agent Development Guide

This file contains guidelines and commands for agentic coding agents working on the FlightSim 3D Earth visualization project.

## Project Overview

FlightSim is a sophisticated 3D Earth flight simulator that renders both 2D satellite tiles and Google Photorealistic 3D tiles using Three.js. The project uses ES6 modules with import maps and does not have a traditional build system.

## Development Commands

### Running the Application
```bash
# Start static HTTP server (required for CORS)
python3 -m http.server 5500

# Access the application
http://localhost:5500
```

**Important**: This is a static project - always use the HTTP server, never open files directly due to CORS requirements for tile loading.

### Testing
**No test framework is currently configured.** The project uses manual testing:
- Test 3D rendering and API integration in browser
- Verify both 2D tiles and 3D photorealistic tiles work
- Test Web Worker functionality for LOD calculations
- Use browser dev tools for performance profiling

### Code Quality
**No linting/formatting tools are configured.** The project maintains code quality through:
- Consistent ES6 module patterns
- JSDoc documentation
- Manual code review
- Browser console for error detection

## Code Style Guidelines

### File Structure and Naming
- **Files**: Use `PascalCase.js` for class files (e.g., `TileManager.js`, `Tiles3DManager.js`)
- **Constants**: Use `UPPER_SNAKE_CASE` and export from `Constants.js`
- **Classes**: Use `PascalCase` with descriptive names
- **Methods/Variables**: Use `camelCase`
- **Private members**: Prefix with underscore (`_privateMethod`)
- **Directories**: Use `lowercase` for feature directories (e.g., `2d/`)

### Import/Export Patterns
```javascript
// Use ES6 import/export syntax
import * as THREE from "three";
import { RADIUS, MAX_ZOOM } from "./Constants.js";
import { TileManager } from "./2d/TileManager.js";

// Export classes individually
export class TileManager {
  // ...
}

// Export constants from dedicated files
export const RADIUS = 6378137;
```

### Code Organization
- **Main entry point**: `main.js` - initializes renderer, scene, and managers
- **Constants**: All configuration in `Constants.js`
- **API Keys**: Store in `Keys.js` (never commit real keys)
- **Feature modules**: Group related functionality in directories
- **Utilities**: Place in `Utils.js` within feature directories

### Documentation Standards
```javascript
/**
 * Brief description of the class/function.
 * 
 * Detailed explanation with usage patterns and important notes.
 * Include performance considerations for critical code.
 * 
 * @example
 * const manager = new TileManager(scene, camera);
 * manager.update();
 * 
 * @param {THREE.Scene} scene - The Three.js scene
 * @param {THREE.PerspectiveCamera} camera - Camera for frustum culling
 */
```

### Three.js Specific Guidelines

#### Object Management
```javascript
// Reuse objects to prevent garbage collection
private _vector = new THREE.Vector3();
private _matrix = new THREE.Matrix4();
private _sphere = new THREE.Sphere();

// Dispose properly
dispose() {
  this.geometry?.dispose();
  this.material?.dispose();
  this.texture?.dispose();
}
```

#### Performance Patterns
```javascript
// Frustum culling
if (!this.frustum.intersectsSphere(boundingSphere)) {
  return; // Skip rendering
}

// Object pooling for frequently created objects
const mesh = this.meshPool.get() || this.createMesh();
// ... use mesh ...
this.meshPool.release(mesh);
```

#### Shader Materials
```javascript
// Use custom shader materials for globe projection
const material = new THREE.ShaderMaterial({
  uniforms: {
    u_texture: { value: null },
    u_radius: { value: RADIUS }
  },
  vertexShader: `// GLSL code`,
  fragmentShader: `// GLSL code`
});
```

### Error Handling Patterns
```javascript
// Async operations with proper error handling
async loadTile(z, x, y) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    console.warn(`Failed to load tile ${z}/${x}/${y}:`, error);
    return null; // Graceful fallback
  }
}

// Validation with early returns
function validateTile(z, x, y) {
  if (z < MIN_ZOOM || z > MAX_ZOOM) return false;
  if (x < 0 || y < 0) return false;
  return true;
}
```

### Web Worker Guidelines
```javascript
// Worker communication with type safety
// Main thread:
worker.postMessage({
  type: 'update',
  cameraPosition: this.camera.position,
  frustumPlanes: planes
});

// Worker thread:
self.onmessage = (e) => {
  const { type, ...data } = e.data;
  if (type === 'update') {
    const result = processUpdate(data);
    self.postMessage({ type: 'result', ...result });
  }
};
```

### State Management
```javascript
// Use clear property names and comments
class TileManager {
  constructor() {
    /** @type {boolean} Whether tile loading is paused */
    this.loadingPaused = false;
    
    /** @type {number} Current number of tiles being loaded */
    this.currentLoads = 0;
    
    /** @type {Set<string>} Currently rendered tile keys */
    this.activeTiles = new Set();
  }
}
```

## API Integration

### Google Maps API
- API key in `Keys.js` (use placeholder in commits)
- Handle session tokens for 3D tiles
- Implement proper error handling for API limits
- Use CORS-enabled endpoints

### Cesium Ion (Alternative)
- Fallback option when Google API fails
- Requires access token configuration
- Different URL structure and authentication

## Performance Considerations

### Critical Path Optimization
- **Frame rate**: Target 60fps for smooth interaction
- **Tile loading**: Limit concurrent requests (`LOAD_LIMIT = 20`)
- **LOD calculations**: Offload to Web Workers
- **Memory management**: Use LRU caching and object pooling

### Horizon Culling
```javascript
// Efficient horizon occlusion without trig per tile
updateHorizonParameters() {
  const distToCenter = this.camera.position.length();
  this.horizonCosAngle = RADIUS / distToCenter;
}

isTileAboveHorizon(boundingSphere) {
  const dot = this.cameraDirection.dot(tileDirection);
  return dot >= this.horizonCosAngle;
}
```

## Browser Compatibility

- **Modern browsers**: ES6+ modules required
- **WebGL**: Required for 3D rendering
- **Web Workers**: Required for LOD calculations
- **ImageBitmap**: Used for efficient texture loading

## Security Considerations

- **API Keys**: Never commit real keys, use placeholders
- **CORS**: Required for tile loading from CDNs
- **Content Security**: Consider CSP for production

## Debugging

### Console Output
```javascript
// Use appropriate log levels
console.log("System initialized"); // Normal flow
console.warn("API rate limit approaching"); // Recoverable issues
console.error("Critical initialization failed"); // Fatal errors
```

### Performance Monitoring
```javascript
// FPS counter in main loop
let frameCount = 0, fps = 0, lastFpsTime = performance.now();
function updateStats() {
  frameCount++;
  const now = performance.now();
  if (now - lastFpsTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastFpsTime = now;
    // Update UI with fps
  }
}
```

## Common Pitfalls

1. **Direct file opening**: Always use HTTP server for CORS
2. **Memory leaks**: Dispose Three.js objects properly
3. **API limits**: Implement request throttling
4. **Async timing**: Handle initialization order correctly
5. **Coordinate systems**: Google tiles use ECEF (Z-up), Three.js uses Y-up

## When Adding Features

1. **Check Constants.js**: Add new configuration values there
2. **Update documentation**: Include JSDoc comments
3. **Consider performance**: Profile before and after changes
4. **Test both modes**: 2D tiles and 3D tiles should work
5. **Handle errors gracefully**: Provide fallbacks for API failures

## Git Workflow

- **Branch structure**: v1, v2, v3, v4, v5 (currently on v5)
- **Commit messages**: Use conventional format when possible
- **No CI/CD**: Manual testing and deployment currently
