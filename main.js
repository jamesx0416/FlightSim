// main.js
import { GlobeViewer } from './src/GlobeViewer.js';
import { Tiles3DLoader } from './src/Tiles3DLoader.js';
import { LODManager } from './src/LODManager.js';
import { DebugOverlay } from './src/DebugOverlay.js';
import { CONFIG } from './config.js';

async function main() {
  console.log("=== MAIN.JS START ===");

  // 1. Init UI
  console.log("1. Creating DebugOverlay...");
  const debugOverlay = new DebugOverlay('ui-layer');
  debugOverlay.update({ message: 'Initializing...' });

  // 2. Init Globe
  console.log("2. Creating GlobeViewer...");
  const viewer = new GlobeViewer('canvas-container');

  // 3. Init 3D Tiles Loader
  console.log("3. Creating Tiles3DLoader...");
  const tilesLoader = new Tiles3DLoader(viewer.scene, viewer.camera, debugOverlay);

  // 4. Init LOD Manager
  console.log("4. Creating LODManager...");
  const lodManager = new LODManager(viewer.camera, viewer.scene);

  // 5. Start Google Session
  console.log("5. Checking for API keys...");
  console.log("   CONFIG.GOOGLE_API_KEY:", CONFIG.GOOGLE_API_KEY ? "SET" : "EMPTY");
  console.log("   CONFIG.CESIUM_ION_TOKEN:", CONFIG.CESIUM_ION_TOKEN ? "SET (length=" + CONFIG.CESIUM_ION_TOKEN.length + ")" : "EMPTY");

  if (CONFIG.GOOGLE_API_KEY || CONFIG.CESIUM_ION_TOKEN) {
    console.log("6. Calling tilesLoader.init()...");
    await tilesLoader.init();
    console.log("7. tilesLoader.init() completed");

    // Hide base globe if tiles loaded successfully
    if (tilesLoader.isInitialized) {
      console.log("Tiles loaded, hiding base globe.");
      viewer.setBaseGlobeVisible(false);
    }

    debugOverlay.update({ message: 'Ready' });
  } else {
    console.warn("6. No API Keys found!");
    debugOverlay.logError("No API Key. Showing base globe only.");
  }

  // 6. Animation Loop
  console.log("8. Starting animation loop...");
  function animate() {
    requestAnimationFrame(animate);

    // Update LOD logic
    const lodState = lodManager.update();

    // Update Tiles
    if (tilesLoader.isInitialized) {
      tilesLoader.update();
      // Optional: Hide/Show tiles based on LOD
      // tilesLoader.renderer.group.visible = lodState.showTiles;
    }

    // Render Scene
    viewer.render();

    // Update Debug
    debugOverlay.update({
      altitude: lodState.altitude
    });
  }

  animate();
  console.log("=== MAIN.JS COMPLETE ===");
}

console.log("=== CALLING main() ===");
main().catch(err => {
  console.error("=== MAIN ERROR ===", err);
  console.error(err.stack);
});
