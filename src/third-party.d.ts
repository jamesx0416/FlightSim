declare module '3d-tiles-renderer/src/three/plugins/fade/FadeMaterialManager.js' {
  export class FadeMaterialManager {
    protected _fadeParams: WeakMap<unknown, unknown>
    prepareMaterial(material: unknown): void
  }
}

declare module '3d-tiles-renderer/src/three/plugins/fade/wrapFadeMaterial.js' {
  export function wrapFadeMaterial(material: unknown, onBeforeCompile: unknown): unknown
}
