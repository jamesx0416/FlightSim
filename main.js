import { GlobeViewer } from './src/GlobeViewer.js';
import { Tiles3DLoader } from './src/Tiles3DLoader.js';
import { LODManager } from './src/LODManager.js';
import { DebugOverlay } from './src/DebugOverlay.js';
import { CONFIG } from './config.js';

async function main() {
  // 1. Init UI
  const debugOverlay = new DebugOverlay('ui-layer');
  debugOverlay.update({ message: 'Initializing...' });

  // 2. Init Globe
  const viewer = new GlobeViewer('canvas-container');

  // 3. Init 3D Tiles Loader
  const tilesLoader = new Tiles3DLoader(viewer.scene, viewer.camera, debugOverlay);

  // 4. Init LOD Manager
  const lodManager = new LODManager(viewer.camera, viewer.scene);

  // 5. Start Google Session
  if (CONFIG.GOOGLE_API_KEY || CONFIG.CESIUM_ION_TOKEN) {
    await tilesLoader.init();

    // Hide base globe if tiles loaded successfully
    if (tilesLoader.isInitialized) {
      viewer.setBaseGlobeVisible(false);
    }

    debugOverlay.update({ message: 'Ready' });
  } else {
    console.warn("No API Keys found!");
    debugOverlay.logError("No API Key. Showing base globe only.");
  }

  // 6. Animation Loop
  function animate() {
    requestAnimationFrame(animate);

    // Update LOD logic
    const lodState = lodManager.update();

    // Update Tiles
    if (tilesLoader.isInitialized) {
      tilesLoader.update();
    }

    // Render Scene
    viewer.render();

    // Update Debug
    debugOverlay.update({
      altitude: lodState.altitude
    });
  }

  animate();
}

main().catch(err => {
  console.error("=== MAIN ERROR ===", err);
  console.error(err.stack);
});
