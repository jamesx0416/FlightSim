# Query Parameters

The viewer reads these URL query parameters at startup. If a parameter is omitted, the runtime follows its normal default path unless noted.

## Package Selection

| Parameter | Example | Feature |
| --- | --- | --- |
| `package` | `?package=/tmp/flybywire-aircraft-a320-neo/` | Selects the main built MSFS package root to load. The value is normalized with a trailing slash. If omitted, `VITE_MSFS_PACKAGE_ROOT` is used, then the built-in development default. |
| `aircraft` | `?aircraft=SimObjects/AirPlanes/FlyByWire_A320_NEO%23fltsim.0` | Selects a specific aircraft variation from the imported package. The aircraft selector also writes this value into the URL when changed. If omitted or invalid, the viewer falls back to the first discovered aircraft. |
| `lod` | `?lod=0` | Requests the initial zero-based LOD index. `0` means LOD00, `1` means LOD01, and so on. Empty values are ignored. Negative or non-integer values throw a startup error. |
| `interiorLod` | `?interiorLod=1` | Requests the zero-based cockpit/interior-view LOD index. `0` means LOD00, `1` means LOD01, and so on. If omitted, empty, or `auto`, the viewer keeps the default interior-view path and loads LOD00. Negative or non-integer values throw a startup error. |
| `syncExteriorInterior` | `?syncExteriorInterior` | Loads any `withExterior_showInterior` interior LOD synchronously before the first exterior view. By default, that interior is loaded progressively after the exterior first view is available. |

## Additional Package Roots

| Parameter | Example | Feature |
| --- | --- | --- |
| `packages` | `?packages=/tmp/fs-base-aircraft-common/;/tmp/asobo-vcockpits-instruments-airliners/` | Adds one or more built-package roots for generic shared asset lookup, including behavior XML includes and texture fallback paths. Values can be repeated or delimited with commas, semicolons, or newlines. |
| `deps` | `?deps=/tmp/fs-base-aircraft-common/&deps=/tmp/asobo-vcockpits-instruments-airliners/` | Alias for `packages`. It is useful when listing dependency roots as repeated URL parameters. Values are normalized with trailing slashes and deduplicated after parsing. |
| `stockBehaviors` | `?stockBehaviors=off` | Disables the bundled stock behavior root only when the value is exactly `off`. Any other value, or no value, leaves stock behavior loading enabled unless `VITE_MSFS_STOCK_BEHAVIOR_ROOT=off` is set. |

## Cockpit Diagnostics And Experiments

| Parameter | Example | Feature |
| --- | --- | --- |
| `cockpitPerf` | `?cockpitPerf` | Enables cockpit performance diagnostics and exposes frame/render/load stats through `globalThis.__cockpitPerf`. Without this flag, the per-frame profiler is not installed. |
| `cockpitTextures` | `?cockpitTextures=range-low` | Opts the selected cockpit/interior-view LOD into low-resolution DDS texture loading. The loader fetches DDS headers first, then requests only the selected small mip byte range when the server supports HTTP `Range`; decoded normal/transparent DDS paths also use range-loaded low mips. If range requests are not supported, it falls back to placeholders instead of downloading the full DDS. |
| `cockpitTextureSize` | `?cockpitTextures=range-low&cockpitTextureSize=1024` | Sets the largest mip dimension for range-loaded cockpit textures. Values are clamped from `128` to `2048`; default is `1024` so cockpit labels have enough atlas resolution to remain readable while still avoiding full DDS downloads. |
| `vcockpitSurfaces` | `?vcockpitSurfaces=off` | Generic `panel.cfg` `[VCockpitXX]` surface binding is enabled for the selected cockpit/interior-view LOD by default. Set this to `off` to disable dynamic VCockpit textures. The current slice parses panel surfaces, binds dynamic textures to matching cockpit material names, resolves `htmlgaugeXX` and resolvable `WasmInstrumentXX` HTML hosts into a serialized queued sandboxed iframe loader, adapts MSFS HTML imports for browser loading, bridges gauge SimVar/local-var/key-event calls into the shared runtime host, composites the first accessible iframe DOM frame into the cockpit textures with bounded retries, and exposes diagnostics on `globalThis.__lastVCockpitSurfaceBinding`. Native MSFS WASM binary ABI execution remains unsupported and is diagnosed rather than emulated. |
| `vcockpitLiveGauges` | `?vcockpitLiveGauges=off` | VCockpit HTML gauges are live by default. Live texture/video capture is dirty-driven and rate-capped: the iframe bridge marks gauges dirty on DOM mutations and Canvas2D writes, and the parent recaptures only dirty surfaces without letting per-frame gauge draws bypass the capture cap. Set this to `off` to use one-shot capture instead: gauges capture the first successfully rendered frame, cache that bitmap in the cockpit texture, release the hidden iframe, and then stop refreshing. |
| `vcockpitGaugeMode` | `?vcockpitGaugeMode=video` | Selects how non-WASM HTML gauges are displayed. `texture` is the default and composites iframe DOM into the VCockpit `CanvasTexture`. `overlay` is experimental direct HTML over projected screen bounds. `video` is experimental and keeps gauges on the mesh using a canvas `captureStream()` plus Three `VideoTexture`; it still rasterizes HTML into the surface canvas, but lets the browser/video texture path schedule frame upload. |
| `vcockpitGaugeVideoFps` | `?vcockpitGaugeMode=video&vcockpitGaugeVideoFps=15` | Sets the canvas capture stream frame rate for video-backed VCockpit gauge textures. Values are clamped from `1` to `60`; default is `15`. |
| `vcockpitGaugeCaptureFps` | `?vcockpitGaugeCaptureFps=10` | Caps dirty HTML gauge DOM rasterization and texture updates for texture/video modes. `vcockpitGaugeCaptureHz` is accepted as an alias. Values are clamped from `1` to `60`; default is `15`. |
| `vcockpitGaugeRasterScale` | `?vcockpitGaugeRasterScale=0.5` | Opts texture/video VCockpit gauges into lower-resolution hidden iframe viewports and dynamic textures. Values are clamped from `0.25` to `1`; default is `1`. Lower values reduce DOM capture, canvas draw, and texture upload cost, but may blur screens or alter responsive HTML gauge layout. Overlay mode ignores this and uses `1`. |
| `vcockpitGaugeUpdateMs` | `?vcockpitGaugeUpdateMs=125` | Forces generic iframe-hosted instrument `Update()` calls to run periodically using a minimum interval in milliseconds. Values are clamped from `16` to `5000` ms. Omit the parameter to use adaptive SimVar/game-var dependency scheduling; set it to `0` or `off` to update every animation frame. |
| `vcockpitGaugeUpdateHz` | `?vcockpitGaugeUpdateHz=8` | Alternative to `vcockpitGaugeUpdateMs`: forces generic iframe-hosted instruments into periodic `Update()` calls by frequency. Ignored when `vcockpitGaugeUpdateMs` is set. Values are clamped from `0.2` to `60` Hz. |
| `vcockpitGaugeDebug` | `?vcockpitGaugeDebug` | Shows diagnostic VCockpit placeholder labels, grid, and HTML gauge status overlays on the dynamic cockpit textures. By default these debug overlays are hidden so captured gauges are not contaminated by loader text. |
| `cockpitInstanceStatic` | `?cockpitPerf&cockpitInstanceStatic` | Opts into dynamic runtime instancing for eligible static cockpit meshes in the selected cockpit/interior-view LOD. The default path is unchanged when this flag is absent. The experiment preserves behavior-bound nodes by keeping hidden proxy meshes and only batches meshes with matching geometry, material, draw range, and safe behavior ancestry. |
| `cockpitMergeStatic` | `?cockpitPerf&cockpitMergeStatic` | Opts into dynamic runtime merging for eligible opaque static cockpit meshes in the selected cockpit/interior-view LOD. The default path is unchanged when this flag is absent. The experiment keeps named/metadata proxy meshes hidden, skips behavior-bound/skinned/morphed/transparent/decal meshes, and merges by material plus spatial cell to reduce draw calls while limiting culling loss. It may slightly change visuals because merged chunks can have different frustum-culling or render-order behavior. |

## Common URLs

```text
?package=/tmp/my-aircraft/&aircraft=SimObjects/AirPlanes/MyAircraft%23fltsim.0&lod=0
```

```text
?package=/tmp/my-aircraft/&interiorLod=1
```

```text
?package=/tmp/my-aircraft/&deps=/tmp/fs-base-aircraft-common/&stockBehaviors=off
```

```text
?package=/tmp/my-aircraft/&cockpitPerf&cockpitInstanceStatic
```

```text
?package=/tmp/my-aircraft/&cockpitPerf&cockpitMergeStatic
```

```text
?package=/tmp/my-aircraft/&cockpitTextures=range-low&cockpitTextureSize=1024
```

```text
?package=/tmp/my-aircraft/&vcockpitSurfaces&cockpitTextures=range-low
```

## Related Environment Variables

These are not query parameters, but they provide defaults that the query parameters can override or augment.

| Variable | Feature |
| --- | --- |
| `VITE_MSFS_PACKAGE_ROOT` | Default main package root when `package` is omitted. |
| `VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS` | Additional package roots appended after `packages` and `deps`. Uses the same comma, semicolon, or newline delimiters. |
| `VITE_MSFS_STOCK_BEHAVIOR_ROOT` | Stock behavior package root. Set to `off` to disable it globally. |
