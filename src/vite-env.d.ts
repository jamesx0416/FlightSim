/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN: string
  readonly VITE_MSFS_PACKAGE_ROOT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
