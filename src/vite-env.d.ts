/// <reference types="vite/client" />
/// <reference types="@webgpu/types" />

interface ImportMetaEnv {
  readonly VITE_CESIUM_ION_TOKEN: string
  readonly VITE_MSFS_PACKAGE_ROOT?: string
  readonly VITE_MSFS_ADDITIONAL_PACKAGE_ROOTS?: string
  readonly VITE_MSFS_STOCK_BEHAVIOR_ROOT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
