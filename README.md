# 3D Earth Demo - Google Photorealistic 3D Tiles

A scrollable 3D Earth demo using Three.js and Google's Photorealistic 3D Tiles.

## Prerequisites
- Python 3 (for the local server)
- A Google Map Tiles API Key

## Setup
1. **Get an API Key**:
   - Go to the [Google Cloud Console](https://console.cloud.google.com/).
   - Enable the **Map Tiles API**.
   - Create an API Key.

2. **Configure the App**:
   - Open `config.js` in a text editor.
   - Paste your API Key into the `GOOGLE_API_KEY` field.
   ```javascript
   export const CONFIG = {
       GOOGLE_API_KEY: 'YOUR_KEY_HERE',
       // OR for Cesium Ion:
       // CESIUM_ION_TOKEN: 'YOUR_ION_TOKEN',
       ...
   };
   ```

   **Note**: You can use either a direct Google API Key OR a Cesium Ion Token. If both are present, Cesium Ion takes precedence.

## Running the Demo
1. Open a terminal in this directory.
2. Run the Python simple HTTP server:
   ```bash
   python3 -m http.server 8000
   ```
3. Open your browser to [http://localhost:8000](http://localhost:8000).

## Controls
- **Left Click + Drag**: Rotate the globe.
- **Scroll Wheel**: Zoom in/out.
- **Right Click + Drag**: Pan (limited).

## Troubleshooting
- **Black Screen?** Check the console (F12) for errors.
- **401/403 Error?** Your API Key might be invalid or the Map Tiles API is not enabled.
- **CORS Errors?** Ensure you are running via `http://localhost:8000` and not opening the file directly.
