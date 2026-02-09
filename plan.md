# FlightSim V7 Project Plan

## Overview
Building a modern 3D flight simulator with WebGPU, React, TypeScript, and three-geospatial.

## Technology Stack

### Core Framework
- **React 18/19**: UI framework
- **TypeScript**: Type safety and developer experience
- **Vite**: Build tool and development server

### 3D Rendering
- **Three.js**: Core 3D graphics library
- **react-three-fiber (R3F)**: React integration for Three.js (declarative scene graph)
- **@react-three/drei**: Useful helpers and abstractions for R3F (OrbitControls, GLTFLoader, effects)
- **WebGPU Renderer**: Modern GPU API for better performance

### Geospatial Libraries
- **three-geospatial**: Core geospatial rendering functions (@takram/three-geospatial)
- **three-atmosphere**: Precomputed Atmospheric Scattering (@takram/three-atmosphere)
- **3d-tiles-renderer**: Google Photorealistic 3D Tiles rendering via Cesium Ion proxy
- **Cesium Ion**: Provides Google 3D tiles (Asset ID: 2275207) - no direct Google Maps API needed

### State Management
- **Zustand**: Lightweight global state management
  - Aircraft position, orientation, speed
  - Camera state and follow mode
  - UI interactions (open menus, selected panels)
  - Simulation controls (play/pause, speed)
  - Map data (loaded tiles, visible POIs)
  - three-geospatial parameters (atmosphere settings, sun position)

### UI/UX
- **Tailwind CSS**: Utility-first CSS for rapid UI development
- **MSFS/X-Plane Style UI**: Sophisticated glass-panel aesthetic

### Assets
- **GLTF/GLB**: 3D aircraft models
- **Google Photorealistic 3D Tiles**: Earth terrain and buildings

## Project Structure

```
flightsim-v7/
├── public/
│   └── assets/
│       ├── models/          # GLTF aircraft models
│       └── textures/        # Textures and skyboxes
├── src/
│   ├── components/
│   │   ├── ui/             # React UI components
│   │   │   ├── panels/     # Glass panels, instruments
│   │   │   ├── controls/   # Buttons, sliders
│   │   │   └── hud/        # Heads-up display elements
│   │   └── scene/          # R3F scene components
│   │       ├── Globe.tsx
│   │       ├── Atmosphere.tsx
│   │       ├── Aircraft.tsx
│   │       ├── Tiles3D.tsx
│   │       └── Camera.tsx
│   ├── hooks/
│   │   ├── useAircraft.ts
│   │   ├── useCamera.ts
│   │   └── useSimulation.ts
│   ├── stores/
│   │   ├── aircraftStore.ts
│   │   ├── cameraStore.ts
│   │   ├── uiStore.ts
│   │   └── simulationStore.ts
│   ├── services/
│   │   ├── tilesService.ts   # 3D tiles loading
│   │   └── weatherService.ts # Weather data integration
│   ├── utils/
│   │   ├── math.ts
│   │   └── coordinates.ts
│   ├── styles/
│   │   ├── index.css
│   │   └── tailwind.config.js
│   ├── App.tsx
│   └── main.tsx
├── .env                    # API keys (not committed)
├── .env.example            # API key template
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## Setup Steps

### 1. Project Initialization
```bash
# Create Vite project with React + TypeScript
pnpm create vite flightsim-v7 --template react-ts
cd flightsim-v7
```

### 2. Install Dependencies
```bash
# Core 3D libraries
pnpm add three @react-three/fiber @react-three/drei

# Geospatial libraries (WebGPU versions)
pnpm add @takram/three-geospatial @takram/three-atmosphere

# 3D Tiles renderer
pnpm add 3d-tiles-renderer

# State management
pnpm add zustand

# Type definitions
pnpm add -D @types/three
```

### 3. Tailwind CSS Setup
```bash
pnpm add -D tailwindcss postcss autoprefixer
npx tailwindcss init -p
```

Configure `tailwind.config.js` for dark glass-panel UI:
- Custom colors for aviation UI (dark grays, blues, oranges)
- Custom fonts for instruments
- Backdrop blur effects

### 4. Environment Configuration
Create `.env` file:
```
VITE_CESIUM_ION_TOKEN=your_cesium_token_here
```

**Note**: Only Cesium Ion token is needed - Google Photorealistic 3D Tiles are accessed via Cesium Ion proxy (Asset ID: 2275207), not direct Google Maps API.

### 5. WebGPU Renderer Configuration
- Configure Vite for WebGPU support
- Set up react-three-fiber Canvas with WebGPURenderer
- Implement fallback detection for browsers without WebGPU

### 6. Three-Geospatial Integration
- Set up Atmosphere component with Precomputed Atmospheric Scattering
- Configure sun/moon positioning based on real astronomical calculations
- Integrate volumetric clouds (optional but recommended)

### 7. 3D Tiles Implementation
- Integrate 3d-tiles-renderer with R3F
- Use `CesiumIonAuthPlugin` with Asset ID `2275207` for Google 3D tiles
- Add optimization plugins (TileCompression, UpdateOnChange, UnloadTiles, TilesFade)
- Create custom component for tile management
- Implement LOD (Level of Detail) and frustum culling
- Add horizon culling for performance
- Handle ECEF to Y-up coordinate transformation

### 8. Aircraft Model Loading
- Use @react-three/drei's `useGLTF` hook
- Create Aircraft component with:
  - Model loading and caching
  - Position/orientation updates from Zustand store
  - Animation states (landing gear, flaps, etc.)

### 9. UI Development (Tailwind)
- Design glass-panel aesthetic with Tailwind
- Create instrument panels (PFD, MFD, ND)
- Implement control panels (autopilot, systems)
- HUD overlays for flight data

### 10. State Management (Zustand)
Create stores for:
- **AircraftStore**: Position, velocity, attitude, systems state
- **CameraStore**: Camera mode, target, zoom, FOV
- **UIStore**: Panel visibility, selected tools, modals
- **SimulationStore**: Time, weather, physics state

## Key Features to Implement

### Phase 1: Foundation
- [ ] WebGPU renderer with R3F
- [ ] Basic atmosphere rendering
- [ ] 3D tiles loading
- [ ] Basic camera controls

### Phase 2: Aircraft
- [ ] GLTF model loading
- [ ] Aircraft state management
- [ ] Basic flight physics (or integration with physics library)

### Phase 3: UI
- [ ] Glass-panel UI framework
- [ ] Primary Flight Display (PFD)
- [ ] Navigation Display (ND)
- [ ] Multi-Function Display (MFD)

### Phase 4: Advanced
- [ ] Cloud rendering
- [ ] Weather integration
- [ ] Night lighting
- [ ] Performance optimization

## References

### Primary Resources
- **three-geospatial**: https://github.com/takram-design-engineering/three-geospatial
  - WebGPU-focused implementation
  - Modular architecture
  - Precomputed Atmospheric Scattering
  - Volumetric clouds

- **jeantimex/geospatial**: https://github.com/jeantimex/geospatial
  - Practical implementation examples
  - Vite + React + three-geospatial integration
  - Atmosphere, Clouds, Tiles demos
  - Cesium Ion Google 3D tiles proxy integration

### Additional Resources
- **react-three-fiber**: https://docs.pmnd.rs/react-three-fiber
- **three.js WebGPU**: https://threejs.org/docs/#api/en/renderers/webgpu/WebGPURenderer
- **3d-tiles-renderer**: https://github.com/NASA-AMMOS/3DTilesRendererJS
- **Zustand**: https://docs.pmnd.rs/zustand
- **Tailwind CSS**: https://tailwindcss.com/

## Design Goals

### Visual Style
- **MSFS/X-Plane Inspired**: Professional aviation aesthetic
- **Glass Panels**: Frosted glass effects with backdrop blur
- **Dark Theme**: Aviation-appropriate dark UI with orange/blue accents
- **Responsive**: Adapt to different screen sizes

### Performance Targets
- **60 FPS**: Smooth flight experience
- **Smart Culling**: Horizon and frustum culling for tiles
- **LOD Management**: Dynamic level of detail based on distance
- **WebGPU Benefits**: Faster atmospheric calculations, better GPU utilization

## Development Notes

### WebGPU Considerations
- Check browser compatibility (Chrome, Edge, Firefox)
- Implement graceful degradation for non-WebGPU browsers
- WebGPU requires secure context (HTTPS or localhost)

### Three-Geospatial WebGPU
- Node-based material system (different from WebGL shader chunks)
- Faster LUT (Look-Up Table) generation for atmosphere
- Better integration with modern Three.js post-processing

### State Management Philosophy
- Keep UI state separate from simulation state
- Use selectors for performance (Zustand supports this)
- Consider using `immer` for immutable updates if needed

---

**Next Steps**: Review this plan and proceed with project scaffolding when ready.
