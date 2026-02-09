# FlightSim V7 - Agent Development Guide

This file contains guidelines and commands for agentic coding agents working on FlightSim V7, a modern 3D flight simulator built with React, TypeScript, WebGPU, and three-geospatial.

## Project Overview

FlightSim V7 is a next-generation flight simulator featuring:
- **WebGPU rendering** for maximum performance
- **React + TypeScript** for type-safe UI development
- **three-geospatial** for realistic atmospheric and geospatial rendering
- **react-three-fiber (R3F)** for declarative 3D scene management
- **Google Photorealistic 3D Tiles** via Cesium Ion proxy (Asset ID: 2275207)
- **MSFS/X-Plane style glass-panel UI**

## Technology Stack

- **Package Manager**: Bun (faster than npm, better for modern projects)
- **Build Tool**: Vite (fast HMR, modern ES modules)
- **UI Framework**: React 18/19
- **Language**: TypeScript
- **3D Library**: Three.js with WebGPU renderer
- **React 3D**: react-three-fiber + @react-three/drei
- **Geospatial**: @takram/three-geospatial, @takram/three-atmosphere
- **3D Tiles**: 3d-tiles-renderer
- **State Management**: Zustand
- **Styling**: Tailwind CSS
- **Assets**: GLTF/GLB for 3D models

## Development Commands

### Package Management (Use Bun)
```bash
# Install dependencies
bun install

# Install specific package
bun add <package-name>

# Install dev dependency
bun add -D <package-name>

# Update packages
bun update

# Run scripts
bun run dev
bun run build
bun run preview
```

**Important**: Always use `bun` instead of `npm` or `pnpm` for this project.

### Running the Application

**Note**: Do not start a development server unless explicitly asked. The user typically has a server already running.

```bash
# Only start if explicitly requested
bun run dev

# Default access URL
http://localhost:5173
```

### Building for Production
```bash
# Create optimized production build
bun run build

# Preview production build locally
bun run preview
```

### Testing
**No test framework is currently configured.** The project uses manual testing:
- Test WebGPU compatibility in browser (Chrome/Edge/Firefox)
- Verify atmosphere rendering and lighting
- Test 3D tiles loading and performance
- Verify React UI interactions with Zustand state
- Use browser dev tools for performance profiling
- Test GLTF model loading

### Code Quality
```bash
# Type checking
bun run typecheck

# Linting (configure with ESLint if needed)
bun run lint

# Formatting (configure with Prettier if needed)
bun run format
```

## Lessons Learned & Agent Insights

This section documents non-obvious challenges and solutions discovered during development.

### WebGPU vs WebGL

**Problem**: The three-geospatial library has two incompatible implementations - WebGPU (node-based) and WebGL (shader-chunk-based).

**Solution**: 
- Use WebGPU as primary target for new projects
- Reference the `three-geospatial-webgpu` Storybook for examples
- WebGPU offers: faster LUT generation, accurate atmospheric lighting, better performance
- Coordinate systems still matter: Google tiles use ECEF (Z-up), Three.js uses Y-up

**Reference**: https://takram-design-engineering.github.io/three-geospatial-webgpu/

### Package Manager Choice

**Problem**: npm and pnpm can be slow, especially with monorepos and peer dependencies.

**Solution**: 
- Bun offers significantly faster installation and execution
- Built-in TypeScript support (no ts-node needed)
- Better workspace support for future monorepo expansion
- Native bundling capabilities

### State Management for 3D Apps

**Problem**: Sharing state between React UI and Three.js scene is non-trivial.

**Solution**:
- Use Zustand instead of Context API for global state
- Create separate stores: aircraftStore, cameraStore, uiStore, simulationStore
- Keep simulation state separate from UI state
- Use selectors to prevent unnecessary re-renders

**Example**:
```typescript
// stores/aircraftStore.ts
import { create } from 'zustand'

interface AircraftState {
  position: [number, number, number]
  rotation: [number, number, number]
  speed: number
  setPosition: (pos: [number, number, number]) => void
}

export const useAircraftStore = create<AircraftState>((set) => ({
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  speed: 0,
  setPosition: (pos) => set({ position: pos }),
}))
```

### Integrating three-geospatial with R3F

**Problem**: three-geospatial components are vanilla Three.js, not React components.

**Solution**:
- Wrap three-geospatial components in R3F using `useThree` hook
- Use `useFrame` to update components that need per-frame updates
- Initialize WebGPURenderer in Canvas component

**Example**:
```typescript
import { useThree, useFrame } from '@react-three/fiber'
import { Atmosphere } from '@takram/three-atmosphere'

function AtmosphereWrapper() {
  const { scene, camera } = useThree()
  const atmosphereRef = useRef<Atmosphere>()
  
  useEffect(() => {
    atmosphereRef.current = new Atmosphere()
    scene.add(atmosphereRef.current)
    return () => {
      scene.remove(atmosphereRef.current!)
    }
  }, [])
  
  useFrame(() => {
    if (atmosphereRef.current) {
      atmosphereRef.current.update(camera)
    }
  })
  
  return null
}
```

### Tailwind for Aviation UI

**Problem**: Standard Tailwind doesn't have aviation-style components.

**Solution**:
- Extend Tailwind config with custom colors:
  - Dark grays: `#0a0a0f`, `#1a1a2e`
  - Aviation orange: `#ff6b35`
  - Aviation blue: `#00d4ff`
- Use `backdrop-blur` for glass-panel effect
- Combine with `bg-opacity` for layered panels

**Config**:
```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        aviation: {
          dark: '#0a0a0f',
          panel: '#1a1a2e',
          orange: '#ff6b35',
          blue: '#00d4ff',
        }
      }
    }
  }
}
```

### 3D Tiles Renderer Integration

**Problem**: Integrating 3d-tiles-renderer with R3F requires careful lifecycle management.

**Solution**:
- Create a custom R3F component that manages the TilesRenderer instance
- Use `useLoader` for tileset loading
- Implement proper disposal in cleanup
- Handle LOD and frustum culling manually or use three-geospatial helpers

**Reference**: jeantimex/geospatial repository for practical implementation

### API Key Management

**Problem**: Multiple APIs needed (Google Maps, Cesium Ion).

**Solution**:
- Use Vite's `.env` file with `VITE_` prefix
- Never commit real keys to git
- Create `.env.example` as template
- Validate keys at app startup with graceful degradation

**Files**:
```
.env                    # Real keys (gitignored)
.env.example            # Template with placeholders
src/config/keys.ts      # Type-safe key access
```

### WebGPU Browser Compatibility

**Problem**: WebGPU not supported in all browsers.

**Solution**:
- Check for WebGPU support at app initialization
- Provide graceful fallback message for unsupported browsers
- Require secure context (HTTPS or localhost)
- Test primarily in Chrome/Edge (best WebGPU support)

**Detection**:
```typescript
if (!navigator.gpu) {
  throw new Error('WebGPU not supported in this browser')
}
```

### GLTF Model Loading

**Problem**: Aircraft models need proper loading, caching, and disposal.

**Solution**:
- Use @react-three/drei's `useGLTF` hook
- Preload models for better UX
- Implement proper cleanup in useEffect return
- Consider using `useGLTF.preload()` for critical models

**Example**:
```typescript
import { useGLTF } from '@react-three/drei'

function Aircraft({ modelPath }: { modelPath: string }) {
  const { scene } = useGLTF(modelPath)
  return <primitive object={scene} />
}

// Preload
useGLTF.preload('/models/aircraft.glb')
```

## Code Style Guidelines

### File Structure and Naming
- **Components**: Use `PascalCase.tsx` for React components (e.g., `FlightPanel.tsx`)
- **Hooks**: Use `camelCase.ts` prefixed with `use` (e.g., `useAircraft.ts`)
- **Stores**: Use `camelCase.ts` suffixed with `Store` (e.g., `aircraftStore.ts`)
- **Services**: Use `camelCase.ts` (e.g., `tilesService.ts`)
- **Utils**: Use `camelCase.ts` (e.g., `coordinates.ts`)
- **Types**: Use `PascalCase.ts` in `types/` directory (e.g., `Aircraft.ts`)
- **Constants**: Use `UPPER_SNAKE_CASE` in `constants.ts`
- **Directories**: Use `lowercase` for feature directories

### TypeScript Patterns
```typescript
// Explicit types for function parameters and returns
function calculateDistance(a: Vector3, b: Vector3): number {
  return a.distanceTo(b)
}

// Interface for component props
interface FlightPanelProps {
  altitude: number
  speed: number
  heading: number
}

// Type for state
interface AircraftState {
  position: [number, number, number]
  isFlying: boolean
}

// Generic hooks
function useSimulation<T>(initialState: T) {
  const [state, setState] = useState<T>(initialState)
  // ...
}
```

### React Component Patterns
```typescript
// Functional components with hooks
import { memo, useCallback, useEffect } from 'react'

interface Props {
  value: number
  onChange: (value: number) => void
}

export const FlightInstrument = memo(function FlightInstrument({ 
  value, 
  onChange 
}: Props) {
  const handleClick = useCallback(() => {
    onChange(value + 1)
  }, [value, onChange])
  
  return (
    <div onClick={handleClick}>
      {value}
    </div>
  )
})
```

### Import/Export Patterns
```typescript
// Grouped exports from index.ts
export { Aircraft } from './Aircraft'
export { FlightPanel } from './FlightPanel'
export { useAircraftStore } from './stores/aircraftStore'

// Named imports
import { Aircraft, FlightPanel } from './components'
import { useAircraftStore } from './stores'
```

### Documentation Standards
```typescript
/**
 * Brief description of the function/component.
 * 
 * Detailed explanation with usage patterns and important notes.
 * Include performance considerations and side effects.
 * 
 * @example
 * const distance = calculateDistance(positionA, positionB)
 * 
 * @param {Vector3} a - First position
 * @param {Vector3} b - Second position
 * @returns {number} Distance in meters
 */
```

### Three.js Specific Guidelines

#### Object Management
```typescript
// Reuse objects to prevent garbage collection
const vector = useRef(new THREE.Vector3())
const matrix = useRef(new THREE.Matrix4())

// Proper disposal in useEffect cleanup
useEffect(() => {
  const geometry = new THREE.BoxGeometry()
  const material = new THREE.MeshBasicMaterial()
  const mesh = new THREE.Mesh(geometry, material)
  
  return () => {
    geometry.dispose()
    material.dispose()
    // mesh is removed from scene by R3F
  }
}, [])
```

#### Performance with R3F
```typescript
// Use useFrame for per-frame updates
useFrame((state, delta) => {
  meshRef.current.rotation.y += delta
})

// Memoize expensive calculations
const expensiveValue = useMemo(() => {
  return computeExpensiveValue(props)
}, [props])

// Use refs for mutable values that don't trigger re-renders
const speedRef = useRef(0)
```

## API Integration

### Cesium Ion - Google Photorealistic 3D Tiles Proxy

The project uses **Cesium Ion as a proxy** to access Google Photorealistic 3D Tiles:

- **Primary Method**: Cesium Ion provides Google 3D tiles via Asset ID `2275207`
- **Authentication**: Only requires a Cesium Ion token (no direct Google Maps API key needed)
- **Plugin**: Use `CesiumIonAuthPlugin` from `3d-tiles-renderer/plugins`
- **Implementation**:
  ```typescript
  import { CesiumIonAuthPlugin } from '3d-tiles-renderer/plugins';
  
  tilesRenderer.registerPlugin(new CesiumIonAuthPlugin({
    apiToken: cesiumToken,
    assetId: '2275207', // Google Photorealistic 3D Tiles
    autoRefreshToken: true,
  }));
  ```

**Environment Variables**:
```
VITE_CESIUM_ION_TOKEN=your_cesium_token_here
```

**Required Assets** (add to "My Assets" in Cesium Ion):
- Google Photorealistic 3D Tiles (Asset ID: 2275207) - **Auto-provided**
- Cesium World Terrain (Asset ID: 1) - For fallback/base terrain

**Additional Optimization Plugins**:
```typescript
import {
  TileCompressionPlugin,
  UpdateOnChangePlugin,
  UnloadTilesPlugin,
  TilesFadePlugin,
  GLTFExtensionsPlugin
} from '3d-tiles-renderer/plugins';

// Register for performance
tilesRenderer.registerPlugin(new TileCompressionPlugin());
tilesRenderer.registerPlugin(new UpdateOnChangePlugin());
tilesRenderer.registerPlugin(new UnloadTilesPlugin());
tilesRenderer.registerPlugin(new TilesFadePlugin());
```

## Performance Considerations

### Critical Path Optimization
- **Frame rate**: Target 60fps minimum
- **Tile loading**: Limit concurrent requests, use LRU cache
- **LOD**: Level of Detail based on camera distance
- **Frustum culling**: Skip rendering objects outside camera view
- **Horizon culling**: Skip tiles below horizon

### React Optimization
- Use `React.memo` for pure components
- Use `useMemo` for expensive computations
- Use `useCallback` for event handlers passed to children
- Use `useRef` for values that don't need re-renders
- Split stores to prevent unnecessary updates

### WebGPU Benefits
- Faster atmospheric scattering calculations
- Better compute shader support
- More efficient GPU memory management
- Modern graphics pipeline

## Browser Compatibility

- **Modern browsers**: Chrome, Edge, Firefox (latest versions)
- **WebGPU**: Required, check `navigator.gpu` support
- **Secure context**: HTTPS or localhost required for WebGPU
- **ES2020+**: Modern JavaScript features
- **ImageBitmap**: Used for efficient texture loading

## Security Considerations

- **API Keys**: Never commit real keys, use `.env` and `.env.example`
- **CORS**: Required for tile loading from CDNs
- **CSP**: Consider Content Security Policy for production
- **Sanitization**: Sanitize user inputs if accepting custom data

## Debugging

### Console Output
```typescript
// Use appropriate log levels
console.log('System initialized')           // Normal flow
console.warn('API rate limit approaching')  // Recoverable issues
console.error('Critical error')             // Fatal errors

// React DevTools
// Use React DevTools browser extension for component inspection

// Three.js Inspector
// Use Three.js DevTools for scene graph inspection
```

### Performance Monitoring
```typescript
// R3F performance monitor
import { Perf } from 'r3f-perf'

function App() {
  return (
    <Canvas>
      <Perf position="top-left" />
      {/* ... */}
    </Canvas>
  )
}

// Custom FPS counter
const useFPS = () => {
  const [fps, setFps] = useState(0)
  const frameCount = useRef(0)
  const lastTime = useRef(performance.now())
  
  useFrame(() => {
    frameCount.current++
    const now = performance.now()
    if (now - lastTime.current >= 1000) {
      setFps(frameCount.current)
      frameCount.current = 0
      lastTime.current = now
    }
  })
  
  return fps
}
```

## Common Pitfalls

1. **WebGPU not available**: Always check `navigator.gpu` before initializing
2. **CORS errors**: Use Vite dev server, never open files directly
3. **Memory leaks**: Dispose Three.js objects properly, especially when unmounting components
4. **React re-renders**: Use refs and proper memoization for performance-critical code
5. **Zustand subscription issues**: Use selectors to prevent unnecessary updates
6. **GLTF loading**: Always handle loading states and errors
7. **Async timing**: Handle initialization order (WebGPU → Three.js → R3F → Tiles)
8. **Coordinate systems**: Google tiles use ECEF (Z-up), Three.js uses Y-up
9. **Type errors**: Use strict TypeScript configuration, avoid `any` types
10. **Tailwind classes**: Use `className` consistently, avoid inline styles

## When Adding Features

1. **Check plan.md**: Align with project roadmap
2. **Update types**: Add TypeScript interfaces for new data structures
3. **Create store**: Add Zustand store if managing new state
4. **Build component**: Create React component with proper TypeScript types
5. **Document**: Add JSDoc comments and update this guide if non-obvious
6. **Test**: Verify in browser, check WebGPU compatibility
7. **Profile**: Measure performance impact before and after changes
8. **Commit**: Use conventional commit format

## Git Workflow

- **Main branches**: `main`, `v1`, `v2`, `v3`, `v4`, `v5`, `v6`, `v7` (current)
- **Feature branches**: `feature/description` from v7
- **Commit messages**: Use conventional format (`feat:`, `fix:`, `docs:`, etc.)
- **No CI/CD**: Manual testing and deployment currently
- **Never force push to main/v7**
- **Environment files**: Always gitignored

## Resources & References

### Primary
- **three-geospatial**: https://github.com/takram-design-engineering/three-geospatial
- **three-geospatial-webgpu**: https://takram-design-engineering.github.io/three-geospatial-webgpu/
- **jeantimex/geospatial**: https://github.com/jeantimex/geospatial

### Documentation
- **react-three-fiber**: https://docs.pmnd.rs/react-three-fiber
- **three.js WebGPU**: https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer
- **Zustand**: https://docs.pmnd.rs/zustand
- **Tailwind CSS**: https://tailwindcss.com/
- **Bun**: https://bun.sh/docs

### Community
- **Three.js Discord**: https://discord.gg/threejs
- **React Three Fiber Discord**: https://discord.gg/poimandres

---

**Last Updated**: V7 development start
**Maintained by**: Agent development team
