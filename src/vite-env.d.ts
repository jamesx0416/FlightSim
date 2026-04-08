/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN: string
  readonly VITE_MSFS_PACKAGE_ROOT?: string
  readonly VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS?: string
  readonly VITE_RENDERER?: 'webgl' | 'webgpu' | 'auto'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
