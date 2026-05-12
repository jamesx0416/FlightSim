import {
  Box3,
  Box3Helper,
  Group,
  type Material,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector2,
  Vector3
} from 'three'
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { AircraftRuntime, SharedMsfsRuntimeHost } from './msfs/runtime'
import type {
  CompiledBehaviorSet,
  ImportedAircraft,
  ImportDiagnostic,
  RuntimeState
} from './msfs/types'
import type { RendererInfo } from './rendering/createAppRenderer'
import type {
  CockpitCameraController,
  CockpitInteractionPickRegistry,
  CockpitPerfDiagnostics,
  FpsCounterSnapshot,
  LoadedAircraftModel,
  VCockpitHtmlGaugeRuntime,
  ViewerConfigProfile
} from './main'

declare global {
  interface Window {
    __DevApi?: ViewerDevApi
  }
}

type DevApiResponse<T = unknown> = {
  readonly ok: boolean
  readonly summary: string
  readonly data: T
  readonly warnings?: readonly string[]
}

type DevApiListKind =
  | 'nodes'
  | 'components'
  | 'interactions'
  | 'gauges'
  | 'animations'
  | 'animationTriggers'
  | 'materials'
  | 'inputEvents'
  | 'variables'
  | 'diagnostics'
  | 'events'
  | 'settings'
  | 'camera'

type DevApiClickOptions = {
  readonly count?: number
  readonly delayMs?: number
  readonly holdMs?: number
  readonly release?: boolean
  readonly mouseEvent?: string
  readonly inputType?: number
  readonly relativeX?: number
  readonly relativeY?: number
  readonly relativeZ?: number
  readonly dragPercent?: number
}

type DevApiTurnOptions = {
  readonly direction: 'up' | 'down' | 'left' | 'right' | 'inc' | 'dec' | 'increase' | 'decrease'
  readonly steps?: number
  readonly delayMs?: number
  readonly until?: {
    readonly var?: string
    readonly unit?: string | null
    readonly equals?: number
    readonly above?: number
    readonly below?: number
  }
}

type DevApiDragOptions = {
  readonly axis?: 'x' | 'y' | 'z'
  readonly start?: number
  readonly end?: number
  readonly startPercent?: number
  readonly endPercent?: number
  readonly steps?: number
  readonly durationMs?: number
  readonly inputType?: number
  readonly lock?: boolean
  readonly release?: boolean
}

type DevApiDiagnosticsOptions = {
  readonly severity?: string
  readonly filter?: string
  readonly limit?: number
  readonly includeGauges?: boolean
}

type DevApiWaitCondition =
  | string
  | {
      readonly kind?: string
      readonly target?: string
      readonly var?: string
      readonly unit?: string | null
      readonly equals?: number
      readonly above?: number
      readonly below?: number
      readonly minimum?: number
      readonly captured?: boolean
    }

type ViewerDevApi = {
  readonly ready: () => Promise<DevApiResponse>
  readonly status: () => DevApiResponse
  readonly help: () => DevApiResponse
  readonly schema: () => DevApiResponse
  readonly report: () => DevApiResponse
  readonly reset: (options?: { readonly runtime?: boolean; readonly coldAndDark?: boolean }) => DevApiResponse
  readonly find: (query: string, options?: { readonly limit?: number }) => DevApiResponse
  readonly list: (options?: { readonly kind?: DevApiListKind; readonly filter?: string; readonly limit?: number }) => DevApiResponse
  readonly click: (target: string, options?: DevApiClickOptions) => Promise<DevApiResponse>
  readonly release: (target: string) => DevApiResponse
  readonly turn: (target: string, options: DevApiTurnOptions) => Promise<DevApiResponse>
  readonly drag: (target: string, options?: DevApiDragOptions) => Promise<DevApiResponse>
  readonly checkComponent: (target: string) => DevApiResponse
  readonly checkMaterial: (target: string, options?: { readonly descendants?: boolean }) => DevApiResponse
  readonly checkGauge: (key?: string, options?: { readonly screenshot?: boolean }) => DevApiResponse
  readonly checkParam: (names: string | readonly string[]) => DevApiResponse
  readonly setParam: (name: string, value: number, unit?: string | null) => DevApiResponse
  readonly diagnostics: (options?: DevApiDiagnosticsOptions) => DevApiResponse
  readonly readVar: (name: string, unit?: string | null) => DevApiResponse
  readonly writeVar: (name: string, value: number, unit?: string | null) => DevApiResponse
  readonly keyEvent: (name: string, args?: readonly number[]) => DevApiResponse
  readonly bridgeCall: (name: string, args?: readonly number[]) => DevApiResponse
  readonly events: (options?: { readonly kind?: 'key' | 'html' | 'sound' | 'effect' | 'bridge' | 'interaction'; readonly limit?: number }) => DevApiResponse
  readonly watch: (
    targets: string | readonly string[],
    options?: { readonly durationMs?: number; readonly intervalMs?: number; readonly unit?: string | null }
  ) => Promise<DevApiResponse>
  readonly waitFor: (condition: DevApiWaitCondition, timeoutMs?: number) => Promise<DevApiResponse>
  readonly perf: () => DevApiResponse
  readonly screenshot: (options?: { readonly target?: 'viewport' | 'gauge'; readonly key?: string }) => DevApiResponse
  readonly visualCheck: (target?: string) => DevApiResponse
  readonly highlight: (target: string, options?: { readonly durationMs?: number }) => DevApiResponse
  readonly camera: {
    readonly enterCockpit: () => Promise<DevApiResponse>
    readonly exitCockpit: () => DevApiResponse
    readonly getPose: () => DevApiResponse
    readonly setPose: (pose: {
      readonly position?: readonly number[]
      readonly target?: readonly number[]
    }) => DevApiResponse
    readonly frame: (target: string) => DevApiResponse
  }
  readonly settings: {
    readonly get: () => DevApiResponse
    readonly set: (settings: Partial<ViewerConfigProfile>) => Promise<DevApiResponse>
  }
  readonly input: {
    readonly pointer: (event: {
      readonly type: 'down' | 'up' | 'move' | 'click'
      readonly x: number
      readonly y: number
      readonly button?: number
    }) => DevApiResponse
    readonly key: (code: string, options?: { readonly type?: 'down' | 'up' | 'press' }) => DevApiResponse
    readonly wheel: (deltaY: number, options?: { readonly x?: number; readonly y?: number }) => DevApiResponse
  }
}

type ViewerDevApiContext = {
  readonly packageRoot: string
  readonly packageData: {
    readonly packageName: string
    readonly diagnostics: readonly ImportDiagnostic[]
  }
  readonly aircraft: ImportedAircraft
  readonly scene: Scene
  readonly renderer: RendererInfo['renderer']
  readonly camera: PerspectiveCamera
  readonly controls: OrbitControls
  readonly rendererInfo: RendererInfo
  readonly getEffectiveSearchParams: () => URLSearchParams
  readonly getCompiledBehaviors: () => CompiledBehaviorSet
  readonly getLoadedModel: () => LoadedAircraftModel
  readonly getRuntime: () => AircraftRuntime
  readonly getRuntimeHost: () => SharedMsfsRuntimeHost
  readonly getRuntimeState: () => RuntimeState
  readonly getFpsSnapshot: () => FpsCounterSnapshot
  readonly getSettingsSnapshot: () => Record<string, unknown>
  readonly getCockpitPerfDiagnostics: () => CockpitPerfDiagnostics
  readonly cockpitInteractionStats: Record<string, unknown>
  readonly getCockpitInteractionPickRegistry: () => CockpitInteractionPickRegistry
  readonly getCockpitCameraController: () => CockpitCameraController
  readonly applySettings: (settings: Partial<ViewerConfigProfile>) => Promise<string | null>
}

export function installViewerBootDevApi(): void {
  const installedAt = performance.now()
  const ok = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T> => ({
    ok: true,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const fail = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T> => ({
    ok: false,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const sleep = (delayMs: number): Promise<void> =>
    new Promise(resolve => window.setTimeout(resolve, Math.max(0, delayMs)))
  const getLoadStage = (): Record<string, unknown> | null => {
    const value = (globalThis as Record<string, unknown>).__msfsLoadStage
    return typeof value === 'object' && value != null ? value as Record<string, unknown> : null
  }
  const loadingData = (): Record<string, unknown> => ({
    ready: false,
    loadStage: getLoadStage(),
    elapsedMs: performance.now() - installedAt,
    location: window.location.href
  })
  const unavailable = (method: string): DevApiResponse =>
    fail('Viewer is still loading; full DevApi is not ready yet.', {
      ...loadingData(),
      method
    }, [
      'Use __DevApi.status() or __DevApi.diagnostics() to inspect boot progress, then retry after __DevApi.ready().'
    ])

  let consoleApi: ViewerDevApi
  const bootApi: Partial<ViewerDevApi> = {
    ready: async () => {
      while (window.__DevApi === consoleApi) {
        await sleep(250)
      }
      return window.__DevApi?.ready?.() ?? unavailable('ready')
    },
    status: () => ok('Viewer is still loading.', loadingData()),
    help: () => ok('Boot DevApi is available while the full viewer loads.', {
      methods: [
        '__DevApi.status()',
        '__DevApi.diagnostics()',
        'await __DevApi.ready()'
      ],
      note: 'Interaction, camera, gauge, and runtime helpers become available after model loading completes.'
    }),
    schema: () => ok('Returned boot DevApi schema summary.', {
      ready: false,
      methods: ['ready', 'status', 'help', 'schema', 'diagnostics', 'report']
    }),
    diagnostics: () => ok('Returned boot diagnostics.', {
      ...loadingData(),
      diagnostics: []
    }),
    report: () => ok('Returned boot report.', {
      ...loadingData(),
      diagnostics: [],
      performance: {
        fps: null
      }
    }),
    camera: {
      enterCockpit: async () => unavailable('camera.enterCockpit'),
      exitCockpit: () => unavailable('camera.exitCockpit'),
      getPose: () => unavailable('camera.getPose'),
      setPose: () => unavailable('camera.setPose'),
      frame: () => unavailable('camera.frame')
    },
    settings: {
      get: () => unavailable('settings.get'),
      set: async () => unavailable('settings.set')
    },
    input: {
      pointer: () => unavailable('input.pointer'),
      key: () => unavailable('input.key'),
      wheel: () => unavailable('input.wheel')
    }
  }
  const proxy = new Proxy(bootApi, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver)
      }
      if (typeof property === 'string') {
        return () => unavailable(property)
      }
      return undefined
    }
  }) as ViewerDevApi

  consoleApi = wrapDevApiForConsole(proxy, error =>
    fail('Boot DevApi call failed.', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null
    })
  )
  window.__DevApi = consoleApi
  ;(globalThis as Record<string, unknown>).__DevApi = consoleApi
}

export function installViewerDevApi(context: ViewerDevApiContext): void {
  let highlightGroup: Group | null = null
  const ok = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T> => ({
    ok: true,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const fail = <T>(summary: string, data: T, warnings?: readonly string[]): DevApiResponse<T> => ({
    ok: false,
    summary,
    data,
    ...(warnings != null && warnings.length > 0 ? { warnings } : {})
  })
  const sleep = (delayMs: number): Promise<void> =>
    new Promise(resolve => window.setTimeout(resolve, Math.max(0, delayMs)))
  const getLoadStage = (): Record<string, unknown> | null => {
    const value = (globalThis as Record<string, unknown>).__msfsLoadStage
    return typeof value === 'object' && value != null ? value as Record<string, unknown> : null
  }
  const getDiagnostics = (): readonly ImportDiagnostic[] => dedupeDiagnostics([
    ...context.packageData.diagnostics,
    ...context.getCompiledBehaviors().diagnostics,
    ...context.getRuntimeState().diagnostics,
    ...(context.getLoadedModel().interior?.vcockpitBinding?.diagnostics ?? [])
  ])
  const diagnosticCounts = (): Record<string, number> => {
    const counts = { error: 0, warning: 0, info: 0, other: 0 }
    for (const diagnostic of getDiagnostics()) {
      if (diagnostic.severity === 'error') counts.error += 1
      else if (diagnostic.severity === 'warning') counts.warning += 1
      else if (diagnostic.severity === 'info') counts.info += 1
      else counts.other += 1
    }
    return counts
  }
  const matchesDiagnosticFilter = (diagnostic: ImportDiagnostic, filter: string): boolean =>
    !filter || `${diagnostic.severity} ${diagnostic.code} ${diagnostic.message} ${diagnostic.sourcePath ?? ''}`.toLowerCase().includes(filter)
  const collectGaugeDiagnostics = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const rows: Record<string, unknown>[] = []
    for (const gauge of gauges()) {
      if (rows.length >= limit) break
      const summary = summarizeGauge(gauge)
      const scriptErrors = Array.isArray(summary.scriptErrors) ? summary.scriptErrors : []
      const assetErrors = Array.isArray(summary.assetErrors) ? summary.assetErrors : []
      const resourceErrors = Array.isArray(summary.resourceErrors) ? summary.resourceErrors : []
      const bridgeStats = typeof summary.bridgeStats === 'object' && summary.bridgeStats != null
        ? summary.bridgeStats as Record<string, unknown>
        : null
      const runtimeErrorCount = typeof bridgeStats?.runtimeErrorCount === 'number' ? bridgeStats.runtimeErrorCount : 0
      const unsupportedCalls = Array.isArray(bridgeStats?.unsupportedCalls) ? bridgeStats.unsupportedCalls : []
      if (
        scriptErrors.length === 0 &&
        assetErrors.length === 0 &&
        resourceErrors.length === 0 &&
        runtimeErrorCount === 0 &&
        unsupportedCalls.length === 0
      ) {
        continue
      }
      const haystack = `${gauge.gaugeKey} ${gauge.surface} ${gauge.source} ${JSON.stringify({
        scriptErrors,
        assetErrors,
        resourceErrors,
        runtimeErrorCount,
        unsupportedCalls
      })}`.toLowerCase()
      if (filter && !haystack.includes(filter)) continue
      rows.push({
        key: gauge.gaugeKey,
        surface: gauge.surface,
        source: gauge.source,
        status: gauge.status,
        scriptErrors,
        assetErrors,
        resourceErrors,
        bridge: {
          runtimeErrorCount,
          unsupportedCalls,
          wasmBridge: bridgeStats?.wasmBridge ?? null,
          status: bridgeStats?.status ?? null
        }
      })
    }
    return rows
  }
  const collectDiagnosticsReport = (options: DevApiDiagnosticsOptions = {}): Record<string, unknown> => {
    const severity = options.severity?.trim()
    const filter = options.filter?.trim().toLowerCase() ?? ''
    const limit = Math.max(1, Math.min(5_000, Math.floor(options.limit ?? 500)))
    const diagnostics = getDiagnostics().filter(diagnostic =>
      (severity == null || severity === '' || diagnostic.severity === severity) &&
      matchesDiagnosticFilter(diagnostic, filter)
    )
    const gaugeDiagnostics = options.includeGauges === false ? [] : collectGaugeDiagnostics(filter, limit)
    return {
      counts: diagnosticCounts(),
      filters: {
        severity: severity == null || severity === '' ? null : severity,
        filter: filter || null,
        limit,
        includeGauges: options.includeGauges !== false
      },
      diagnostics: diagnostics.slice(0, limit),
      truncatedDiagnostics: Math.max(0, diagnostics.length - limit),
      gaugeDiagnostics,
      status: statusData()
    }
  }
  const gauges = (): readonly VCockpitHtmlGaugeRuntime[] =>
    context.getLoadedModel().interior?.vcockpitBinding?.htmlGaugeRuntimes ?? []
  const isCapturableGauge = (runtime: VCockpitHtmlGaugeRuntime): boolean =>
    runtime.captured ||
    runtime.captureImage != null ||
    runtime.staticCaptureImage != null ||
    runtime.textureName.toUpperCase() !== 'NO_TEXTURE'
  const summarizeGauge = (runtime: VCockpitHtmlGaugeRuntime): Record<string, unknown> => ({
    key: runtime.gaugeKey,
    surface: runtime.surface,
    textureName: runtime.textureName,
    source: runtime.source,
    resolvedUrl: runtime.resolvedUrl,
    status: runtime.status,
    captured: runtime.captured,
    needsCapture: runtime.needsCapture,
    lastRenderStatus: runtime.lastRenderStatus,
    lastRenderKind: runtime.lastRenderKind,
    lastCaptureError: runtime.lastCaptureError,
    captureAttemptCount: runtime.captureAttemptCount,
    capturable: isCapturableGauge(runtime),
    backendOnly: !isCapturableGauge(runtime),
    hasIframe: runtime.iframe != null,
    hasCaptureImage: runtime.captureImage != null || runtime.staticCaptureImage != null,
    ...summarizeGaugeFrame(runtime)
  })
  const summarizeGaugeFrame = (runtime: VCockpitHtmlGaugeRuntime): Record<string, unknown> => {
    const frameDocument = runtime.iframe?.contentDocument
    const frameWindow = runtime.iframe?.contentWindow as
      | (Window & {
          readonly __msfsGaugeDirtyStats?: unknown
          readonly __msfsInstrumentRuntimeStats?: unknown
          readonly __msfsGaugeBridgeStats?: unknown
          readonly __msfsGaugeErrors?: unknown
          readonly __msfsGaugeAssetErrors?: unknown
          readonly __msfsGaugeResourceErrors?: unknown
        })
      | null
      | undefined
    const bridgeStats = frameWindow?.__msfsGaugeBridgeStats ?? null
    const wasmModuleUrl = getWasmModuleUrl(runtime)
    return {
      domNodeCount: frameDocument?.getElementsByTagName('*').length ?? null,
      canvasCount: frameDocument?.querySelectorAll('canvas').length ?? null,
      svgCount: frameDocument?.querySelectorAll('svg').length ?? null,
      dirtyStats: frameWindow?.__msfsGaugeDirtyStats ?? null,
      instrumentStats: frameWindow?.__msfsInstrumentRuntimeStats ?? null,
      bridgeStats: wasmModuleUrl == null
        ? bridgeStats
        : {
            ...(typeof bridgeStats === 'object' ? bridgeStats : {}),
            wasmModuleInfo: {
              url: wasmModuleUrl,
              status: 'resolved-url-only',
              byteLength: 0,
              imports: [],
              exports: [],
              error: null
            }
          },
      scriptErrors: frameWindow?.__msfsGaugeErrors ?? null,
      assetErrors: frameWindow?.__msfsGaugeAssetErrors ?? null,
      resourceErrors: frameWindow?.__msfsGaugeResourceErrors ?? null
    }
  }
  const getWasmModuleUrl = (runtime: VCockpitHtmlGaugeRuntime): string | null => {
    if (runtime.status !== 'loaded-wasm-bridge') {
      return null
    }
    if (runtime.wasmModuleUrl != null) {
      return runtime.wasmModuleUrl
    }
    if (runtime.resolvedUrl == null) {
      return null
    }
    try {
      return new URL(runtime.resolvedUrl).searchParams.get('wasmModuleUrl')
    } catch {
      return null
    }
  }
  const canvasDataUrl = (canvas: HTMLCanvasElement): string | null => {
    try {
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }
  const findObject = (query: string): Object3D | null => {
    const needle = query.trim().toLowerCase()
    if (!needle) return null
    let found: Object3D | null = null
    context.getLoadedModel().scene.traverse(object => {
      if (found != null) return
      if (object.name.toLowerCase() === needle) found = object
    })
    context.getLoadedModel().scene.traverse(object => {
      if (found != null) return
      if ((object.name || object.type).toLowerCase().includes(needle)) found = object
    })
    return found
  }
  const collectNodes = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const rows: Record<string, unknown>[] = []
    context.getLoadedModel().scene.traverse(object => {
      if (rows.length >= limit) return
      const label = object.name || object.type
      if (needle && !label.toLowerCase().includes(needle)) return
      rows.push({
        name: object.name || null,
        type: object.type,
        visible: object.visible,
        childCount: object.children.length,
        parent: object.parent?.name || object.parent?.type || null,
        position: object.position.toArray()
      })
    })
    return rows
  }
  const collectComponents = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const registry = context.getCockpitInteractionPickRegistry()
    return context.getRuntime().getInteractionBindings()
      .filter(binding => !needle || binding.target.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(binding => {
        const pickMeshes = [...registry.bindingsByMesh.entries()]
          .filter(([, candidate]) => candidate.target === binding.target)
          .map(([mesh]) => mesh.name || mesh.type)
        const fallback = registry.fallbackHitboxes.find(target => target.binding.target === binding.target)
        return {
          target: binding.target,
          kind: binding.kind,
          sourcePath: binding.sourcePath,
          source: binding.expression.source,
          releaseSource: binding.releaseExpression?.source ?? null,
          feedbackTargets: binding.feedbackTargets,
          feedbackVariableKeys: binding.feedbackVariableKeys,
          soundEvents: binding.soundEvents,
          hasRelease: binding.releaseExpression != null,
          pickMeshes,
          fallbackHitbox: fallback == null
            ? null
            : {
                sourceNode: fallback.sourceNode.name || fallback.sourceNode.type,
                center: fallback.box.getCenter(new Vector3()).toArray(),
                size: fallback.box.getSize(new Vector3()).toArray()
              }
        }
      })
  }
  const collectAnimations = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const runtimeState = context.getRuntimeState()
    return context.getCompiledBehaviors().animationBindings
      .filter(binding => !needle || binding.target.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(binding => ({
        target: binding.target,
        sourcePath: binding.sourcePath,
        value: runtimeState.animationValues.get(binding.target) ?? null
      }))
  }
  const collectAnimationTriggers = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    return context.getCompiledBehaviors().animationTriggerBindings
      .filter(binding => !needle || binding.animation.toLowerCase().includes(needle) || binding.eventName.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(binding => ({ ...binding }))
  }
  const summarizeMaterial = (material: Material): Record<string, unknown> => {
    const materialRecord = material as Material & {
      readonly color?: { readonly getHexString?: () => string }
      readonly emissive?: { readonly getHexString?: () => string }
      readonly emissiveIntensity?: number
      readonly map?: unknown
      readonly emissiveMap?: unknown
      readonly alphaMap?: unknown
      readonly opacity?: number
      readonly transparent?: boolean
      readonly depthTest?: boolean
      readonly depthWrite?: boolean
      readonly blending?: number
      readonly colorWrite?: boolean
    }
    return {
      name: material.name || null,
      type: material.type,
      visible: material.visible,
      opacity: materialRecord.opacity ?? null,
      transparent: materialRecord.transparent ?? null,
      color: materialRecord.color?.getHexString == null
        ? null
        : `#${materialRecord.color.getHexString()}`,
      emissive: materialRecord.emissive?.getHexString == null
        ? null
        : `#${materialRecord.emissive.getHexString()}`,
      emissiveIntensity: materialRecord.emissiveIntensity ?? null,
      map: materialRecord.map != null,
      emissiveMap: materialRecord.emissiveMap != null,
      alphaMap: materialRecord.alphaMap != null,
      depthTest: materialRecord.depthTest ?? null,
      depthWrite: materialRecord.depthWrite ?? null,
      blending: materialRecord.blending ?? null,
      colorWrite: materialRecord.colorWrite ?? null,
      msfs: {
        blendGBufferDepthMask: material.userData?.msfsBlendGBufferDepthMask ?? null,
        blendGBufferForwardColor: material.userData?.msfsBlendGBufferForwardColor ?? null,
        materialCode: material.userData?.msfsMaterialCode ?? null
      }
    }
  }
  const getObjectMaterials = (object: Object3D): readonly Material[] => {
    const material = (object as Object3D & { readonly material?: Material | Material[] }).material
    if (material == null) return []
    return Array.isArray(material) ? material : [material]
  }
  const summarizeMaterialObject = (
    object: Object3D,
    options: { readonly descendants?: boolean } = {}
  ): Record<string, unknown> => {
    const rows: Record<string, unknown>[] = []
    const appendObject = (candidate: Object3D): void => {
      const materials = getObjectMaterials(candidate)
      if (materials.length === 0) return
      rows.push({
        node: candidate.name || candidate.type,
        visible: candidate.visible,
        parent: candidate.parent?.name || candidate.parent?.type || null,
        runtimeEmissiveValue: context.getRuntimeState().materialValues.get(candidate.name) ?? null,
        bindings: context.getCompiledBehaviors().materialBindings
          .filter(binding => binding.target === candidate.name)
          .map(binding => ({
            target: binding.target,
            property: binding.property,
            source: binding.expression.source,
            overrideBaseEmissive: binding.overrideBaseEmissive,
            sourcePath: binding.sourcePath
          })),
        materials: materials.map(summarizeMaterial)
      })
    }

    appendObject(object)
    if (options.descendants === true) {
      object.traverse(child => {
        if (child !== object) appendObject(child)
      })
    }
    return {
      object: object.name || object.type,
      type: object.type,
      visible: object.visible,
      materialRows: rows
    }
  }
  const collectMaterials = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    const rows: Record<string, unknown>[] = []
    context.getLoadedModel().scene.traverse(object => {
      if (rows.length >= limit) return
      const materials = getObjectMaterials(object)
      if (materials.length === 0) return
      const objectLabel = object.name || object.type
      const materialLabels = materials.map(material => material.name || material.type).join(' ')
      if (
        needle &&
        !objectLabel.toLowerCase().includes(needle) &&
        !materialLabels.toLowerCase().includes(needle)
      ) {
        return
      }
      rows.push(summarizeMaterialObject(object))
    })
    return rows
  }
  const collectVariables = (filter = '', limit = 500): readonly Record<string, unknown>[] => {
    const needle = filter.trim().toLowerCase()
    return Object.entries(context.getRuntimeHost().getSnapshot())
      .filter(([name]) => !needle || name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(([name, value]) => ({ name, value }))
  }
  const statusData = (): Record<string, unknown> => {
    const loadedModel = context.getLoadedModel()
    const cockpit = context.getCockpitCameraController()
    const binding = loadedModel.interior?.vcockpitBinding ?? null
    const gaugeRows = gauges()
    const capturableGaugeCount = gaugeRows.filter(isCapturableGauge).length
    const capturedCapturableGaugeCount = gaugeRows.filter(gauge => isCapturableGauge(gauge) && gauge.captured).length
    return {
      loadStage: getLoadStage(),
      packageRoot: context.packageRoot,
      packageName: context.packageData.packageName,
      aircraftId: context.aircraft.id,
      aircraftTitle: context.aircraft.title,
      renderer: {
        mode: context.rendererInfo.mode,
        pixelRatio: context.renderer.getPixelRatio(),
        size: context.renderer.getSize(new Vector2()).toArray()
      },
      cockpit: {
        available: cockpit.isAvailable(),
        active: cockpit.isActive(),
        activeInteriorLodIndex: loadedModel.interior?.loadedLodIndex ?? null
      },
      counts: {
        interactions: context.getRuntime().getInteractionBindings().length,
        materialBindings: context.getCompiledBehaviors().materialBindings.length,
        gauges: binding?.htmlGaugeCount ?? 0,
        loadedGauges: binding?.loadedHtmlGaugeCount ?? 0,
        capturedGauges: binding?.capturedHtmlGaugeCount ?? 0,
        capturableGauges: capturableGaugeCount,
        capturedCapturableGauges: capturedCapturableGaugeCount,
        backendOnlyGauges: Math.max(0, gaugeRows.length - capturableGaugeCount),
        variables: Object.keys(context.getRuntimeHost().getSnapshot()).length
      },
      fps: context.getFpsSnapshot(),
      diagnostics: diagnosticCounts()
    }
  }
  const isViewerReady = (): boolean => {
    const stage = getLoadStage()?.stage
    return typeof stage === 'string' && stage !== 'init:error'
  }
  const resolveGauge = (key?: string): VCockpitHtmlGaugeRuntime | null => {
    if (key == null || key.trim() === '') return gauges()[0] ?? null
    const needle = key.trim().toLowerCase()
    return gauges().find(gauge =>
      gauge.gaugeKey.toLowerCase() === needle ||
      gauge.gaugeKey.toLowerCase().includes(needle) ||
      gauge.source.toLowerCase().includes(needle) ||
      gauge.surface.toLowerCase().includes(needle)
    ) ?? null
  }
  const executeClick = async (
    target: string,
    options: DevApiClickOptions = {}
  ): Promise<DevApiResponse> => {
    const count = Math.max(1, Math.min(500, Math.floor(options.count ?? 1)))
    const delayMs = Math.max(0, Math.min(10_000, Math.floor(options.delayMs ?? 0)))
    const holdMs = Math.max(0, Math.min(60_000, Math.floor(options.holdMs ?? 0)))
    const shouldRelease = options.release !== false
    const interactionOptions = {
      holdFeedback: holdMs > 0,
      mouseEvent: options.mouseEvent,
      inputType: options.inputType,
      relativeX: options.relativeX,
      relativeY: options.relativeY,
      relativeZ: options.relativeZ,
      dragPercent: options.dragPercent
    }
    const before = context.getRuntime().getInteractionExecutionCount()
    const presses: Record<string, unknown>[] = []
    let callbackReleaseCount = 0
    for (let index = 0; index < count; index += 1) {
      const pressed = context.getRuntime().executeInteraction(target, interactionOptions)
      presses.push({ index, pressed })
      if (pressed && holdMs > 0) {
        context.cockpitInteractionStats.activeHeldTarget = target
        await sleep(holdMs)
      }
      if (pressed && shouldRelease) {
        const releaseMouseEvent = holdMs > 0 && (options.mouseEvent == null || options.mouseEvent === 'LeftSingle' || options.mouseEvent === 'Lock')
          ? 'LeftRelease'
          : null
        if (releaseMouseEvent != null) {
          const callbackReleased = context.getRuntime().executeInteractionCallbackEvent(target, {
            ...interactionOptions,
            holdFeedback: false,
            mouseEvent: releaseMouseEvent
          })
          if (callbackReleased) callbackReleaseCount += 1
        }
        context.getRuntime().releaseInteraction(target)
        if (context.cockpitInteractionStats.activeHeldTarget === target) {
          context.cockpitInteractionStats.activeHeldTarget = null
        }
      }
      if (index < count - 1 && delayMs > 0) await sleep(delayMs)
    }
    const executedCount = context.getRuntime().getInteractionExecutionCount() - before
    return (executedCount > 0 ? ok : fail)(
      executedCount > 0
        ? `Executed ${count} requested click(s) for ${target}; ${executedCount} runtime interaction event(s).`
        : `No interaction executed for ${target}.`,
      { target, requestedCount: count, executedCount, callbackReleaseCount, held: holdMs > 0 && !shouldRelease, presses, interactionStats: { ...context.cockpitInteractionStats } },
      executedCount > 0 ? undefined : [`No exact interaction target matched "${target}". Try __DevApi.find("${target}").`]
    )
  }
  const resolveTurnTarget = (target: string, direction: DevApiTurnOptions['direction']): {
    readonly target: string
    readonly candidates: readonly string[]
  } => {
    const bindings = context.getRuntime().getInteractionBindings()
    if (bindings.some(binding => binding.target === target)) return { target, candidates: [target] }
    const targetNeedle = target.toLowerCase()
    const directionNeedles =
      direction === 'up' || direction === 'right' || direction === 'inc' || direction === 'increase'
        ? ['inc', 'increase', 'plus', 'right', 'up', 'clockwise', 'cw']
        : ['dec', 'decrease', 'minus', 'left', 'down', 'counter', 'ccw']
    const candidates = bindings
      .map(binding => binding.target)
      .filter(candidate => {
        const normalized = candidate.toLowerCase()
        return normalized.includes(targetNeedle) && directionNeedles.some(needle => normalized.includes(needle))
      })
    return { target: candidates[0] ?? target, candidates }
  }
  const untilReached = (until: DevApiTurnOptions['until']): boolean => {
    if (until?.var == null) return false
    const value = context.getRuntimeHost().readVariable(until.var, until.unit ?? null)
    return (
      (until.equals != null && Math.abs(value - until.equals) < 1e-6) ||
      (until.above != null && value > until.above) ||
      (until.below != null && value < until.below)
    )
  }
  const executeDrag = async (
    target: string,
    options: DevApiDragOptions = {}
  ): Promise<DevApiResponse> => {
    const axis = options.axis ?? 'y'
    const steps = Math.max(1, Math.min(200, Math.floor(options.steps ?? 8)))
    const durationMs = Math.max(0, Math.min(60_000, Math.floor(options.durationMs ?? 250)))
    const stepDelayMs = steps > 1 ? durationMs / (steps - 1) : 0
    const inputType = options.inputType ?? 1
    const start = finiteNumberOr(options.start, 0)
    const end = finiteNumberOr(options.end, 1)
    const startPercent = clamp01(finiteNumberOr(options.startPercent, start))
    const endPercent = clamp01(finiteNumberOr(options.endPercent, end))
    const shouldLock = options.lock !== false
    const shouldRelease = options.release !== false
    const phases: Record<string, unknown>[] = []
    const before = context.getRuntime().getInteractionExecutionCount()
    const createMouseOptions = (
      mouseEvent: string,
      relativeValue: number,
      dragPercent: number
    ): DevApiClickOptions => {
      const base = {
        count: 1,
        release: false,
        mouseEvent,
        inputType,
        dragPercent
      }
      if (axis === 'x') return { ...base, relativeX: relativeValue }
      if (axis === 'z') return { ...base, relativeZ: relativeValue }
      return { ...base, relativeY: relativeValue }
    }
    const runPhase = async (
      phase: string,
      mouseEvent: string,
      relativeValue: number,
      dragPercent: number
    ): Promise<void> => {
      const response = await executeClick(target, createMouseOptions(mouseEvent, relativeValue, dragPercent))
      phases.push({
        phase,
        mouseEvent,
        relativeValue,
        dragPercent,
        ok: response.ok,
        executedCount: (response.data as { readonly executedCount?: unknown }).executedCount
      })
    }

    if (shouldLock) await runPhase('lock', 'Lock', start, startPercent)
    await runPhase('press', 'LeftSingle', start, startPercent)
    for (let index = 0; index < steps; index += 1) {
      const ratio = steps === 1 ? 1 : index / (steps - 1)
      const relativeValue = start + (end - start) * ratio
      const dragPercent = startPercent + (endPercent - startPercent) * ratio
      await runPhase('drag', 'LeftDrag', relativeValue, dragPercent)
      if (index < steps - 1 && stepDelayMs > 0) await sleep(stepDelayMs)
    }
    if (shouldRelease) {
      await runPhase('release', 'LeftRelease', end, endPercent)
      if (shouldLock) await runPhase('unlock', 'Unlock', end, endPercent)
      const released = context.getRuntime().releaseInteraction(target)
      phases.push({ phase: 'runtimeRelease', released })
      if (context.cockpitInteractionStats.activeHeldTarget === target) {
        context.cockpitInteractionStats.activeHeldTarget = null
      }
    }

    const executedCount = context.getRuntime().getInteractionExecutionCount() - before
    return (executedCount > 0 ? ok : fail)(
      executedCount > 0 ? `Dragged ${target} across ${steps} step(s).` : `No drag interaction executed for ${target}.`,
      {
        target,
        axis,
        inputType,
        start,
        end,
        startPercent,
        endPercent,
        steps,
        durationMs,
        executedCount,
        phases,
        interactionStats: { ...context.cockpitInteractionStats }
      },
      executedCount > 0 ? undefined : [`No exact interaction target matched "${target}". Try __DevApi.find("${target}").`]
    )
  }
  const list = (options: { readonly kind?: DevApiListKind; readonly filter?: string; readonly limit?: number } = {}): DevApiResponse => {
    const kind = options.kind ?? 'components'
    const filter = options.filter ?? ''
    const limit = Math.max(1, Math.min(5_000, Math.floor(options.limit ?? 500)))
    if (kind === 'nodes') return ok('Listed scene nodes.', collectNodes(filter, limit))
    if (kind === 'components' || kind === 'interactions') return ok('Listed cockpit components/interactions.', collectComponents(filter, limit))
    if (kind === 'gauges') return ok('Listed VCockpit gauges.', gauges().map(summarizeGauge).slice(0, limit))
    if (kind === 'animations') return ok('Listed animation bindings.', collectAnimations(filter, limit))
    if (kind === 'animationTriggers') return ok('Listed animation trigger bindings.', collectAnimationTriggers(filter, limit))
    if (kind === 'materials') return ok('Listed scene materials.', collectMaterials(filter, limit))
    if (kind === 'inputEvents') {
      const normalizedFilter = filter.trim().toLowerCase()
      return ok(
        'Listed input-event bridge bindings.',
        context.getRuntimeHost()
          .getInputEventBindingNames()
          .filter(name => !normalizedFilter || name.toLowerCase().includes(normalizedFilter))
          .slice(0, limit)
      )
    }
    if (kind === 'variables') return ok('Listed runtime variables.', collectVariables(filter, limit))
    if (kind === 'diagnostics') return api.diagnostics({ filter, limit })
    if (kind === 'events') return api.events()
    if (kind === 'settings') return api.settings.get()
    if (kind === 'camera') return api.camera.getPose()
    return fail(`Unknown list kind "${kind}".`, { kind })
  }
  const api: ViewerDevApi = {
    ready: async () => {
      const started = performance.now()
      while (performance.now() - started < 60_000) {
        if (isViewerReady()) return ok('Viewer scene is ready.', statusData())
        await sleep(50)
      }
      return fail('Timed out waiting for viewer scene readiness.', statusData())
    },
    status: () => ok('Collected viewer status.', statusData()),
    help: () => ok('Available on window.__DevApi.', {
      examples: [
        'await __DevApi.ready()',
        '__DevApi.find("baro")',
        'await __DevApi.click("PUSH_AP_MASTER", { count: 2 })',
        'await __DevApi.click("PUSH_STARTER", { holdMs: 1500 })',
        'await __DevApi.click("LEVER_FLAPS", { mouseEvent: "WheelUp" })',
        'await __DevApi.turn("KNOB_HEADING", { direction: "up", steps: 3 })',
        'await __DevApi.drag("LEVER_THROTTLE", { axis: "y", start: 0, end: 1, endPercent: 1 })',
        'await __DevApi.waitFor({ kind: "gaugesReady", captured: true }, 45000)',
        '__DevApi.checkGauge(undefined, { screenshot: true })',
        '__DevApi.checkMaterial("PUSH_OVHD_HYD_ENG1PUMP_SEQ1")',
        '__DevApi.diagnostics({ severity: "warning", includeGauges: true })',
        '__DevApi.checkParam(["gear", "flaps", "spoilers", "parkingBrake"])',
        '__DevApi.setParam("spoilers", 50)',
        '__DevApi.bridgeCall("A32NX_PED_ECP_ENG_PB_Push")',
        '__DevApi.bridgeCall("InputEvent_Push_Long", [1, 1])',
        '__DevApi.events({ kind: "html", limit: 5 })',
        '__DevApi.report()'
      ],
      methods: Object.keys(window.__DevApi ?? {})
    }),
    schema: () => ok('Returned DevApi schema summary.', {
      response: '{ ok, summary, data, warnings? }',
      listKinds: ['nodes', 'components', 'interactions', 'gauges', 'animations', 'animationTriggers', 'materials', 'inputEvents', 'variables', 'diagnostics', 'events', 'settings', 'camera'],
      clickOptions: ['count', 'delayMs', 'holdMs', 'release', 'mouseEvent', 'inputType', 'relativeX', 'relativeY', 'relativeZ', 'dragPercent'],
      turnOptions: ['direction', 'steps', 'delayMs', 'until'],
      dragOptions: ['axis', 'start', 'end', 'startPercent', 'endPercent', 'steps', 'durationMs', 'inputType', 'lock', 'release'],
      waitConditions: ['viewerReady', 'cockpitReady', 'gaugesLoaded', 'gaugesReady', 'gaugeCaptured', 'componentAvailable', 'varEquals', 'varAbove', 'varBelow', 'noNewErrors'],
      diagnosticsOptions: ['severity', 'filter', 'limit', 'includeGauges'],
      eventOptions: ['kind', 'limit'],
      resetOptions: ['runtime', 'coldAndDark'],
      runtimeMethods: ['readVar', 'writeVar', 'keyEvent', 'bridgeCall'],
      paramPresets: ['vspeed', 'altitude', 'pressure', 'location', 'gear', 'flaps', 'spoilers', 'parkingBrake']
    }),
    report: () => ok('Collected viewer debug report.', {
      status: statusData(),
      settings: context.getSettingsSnapshot(),
      diagnostics: getDiagnostics(),
      cockpitInteractionStats: { ...context.cockpitInteractionStats },
      gauges: gauges().map(summarizeGauge),
      events: api.events().data,
      perf: api.perf().data
    }),
    reset: (options = {}) => {
      if (highlightGroup != null) {
        context.scene.remove(highlightGroup)
        highlightGroup.clear()
        highlightGroup = null
      }
      context.getCockpitPerfDiagnostics().reset()
      const shouldResetRuntime = options.runtime === true || options.coldAndDark === true
      if (shouldResetRuntime) {
        context.getRuntimeHost().resetRuntimeState({ coldAndDark: options.coldAndDark === true })
      }
      return ok(shouldResetRuntime ? 'Reset DevApi transient diagnostics and runtime state.' : 'Reset DevApi transient diagnostics.', {
        perf: context.getCockpitPerfDiagnostics().getSummary(),
        runtime: shouldResetRuntime ? context.getRuntimeHost().getStats() : null
      })
    },
    find: (query, options = {}) => {
      const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 50)))
      const needle = query.toLowerCase()
      return ok(`Searched viewer for "${query}".`, {
        nodes: collectNodes(query, limit),
        components: collectComponents(query, limit),
        gauges: gauges().filter(gauge => `${gauge.gaugeKey} ${gauge.source} ${gauge.surface}`.toLowerCase().includes(needle)).slice(0, limit).map(summarizeGauge),
        animations: collectAnimations(query, limit),
        variables: collectVariables(query, limit),
        diagnostics: getDiagnostics().filter(diagnostic => `${diagnostic.code} ${diagnostic.message} ${diagnostic.sourcePath ?? ''}`.toLowerCase().includes(needle)).slice(0, limit)
      })
    },
    list,
    click: executeClick,
    release: target => {
      const callbackReleased = context.getRuntime().executeInteractionCallbackEvent(target, {
        holdFeedback: false,
        mouseEvent: 'LeftRelease'
      })
      const released = context.getRuntime().releaseInteraction(target)
      if (context.cockpitInteractionStats.activeHeldTarget === target) context.cockpitInteractionStats.activeHeldTarget = null
      return (released || callbackReleased ? ok : fail)(
        released || callbackReleased ? `Released ${target}.` : `No interaction released for ${target}.`,
        { target, released, callbackReleased }
      )
    },
    turn: async (target, options) => {
      const steps = Math.max(1, Math.min(500, Math.floor(options.steps ?? 1)))
      const resolved = resolveTurnTarget(target, options.direction)
      let executedCount = 0
      const results: unknown[] = []
      for (let index = 0; index < steps; index += 1) {
        const mouseEvent =
          options.direction === 'up' || options.direction === 'right' || options.direction === 'inc' || options.direction === 'increase'
            ? 'WheelUp'
            : 'WheelDown'
        const result = await executeClick(resolved.target, { count: 1, delayMs: options.delayMs, mouseEvent })
        results.push(result.data)
        const data = result.data as { readonly executedCount?: unknown }
        executedCount += typeof data.executedCount === 'number' ? data.executedCount : 0
        if (untilReached(options.until)) break
      }
      return (executedCount > 0 ? ok : fail)(
        executedCount > 0 ? `Turned ${target} ${options.direction} using ${resolved.target}.` : `Could not resolve a turn binding for ${target} ${options.direction}.`,
        { requestedTarget: target, resolvedTarget: resolved.target, candidates: resolved.candidates, executedCount, results },
        executedCount > 0 ? undefined : [`Try __DevApi.find("${target}") to inspect available rotary targets.`]
      )
    },
    drag: executeDrag,
    checkComponent: target => {
      const matches = collectComponents(target, 50)
      const exact = matches.find(row => row.target === target) ?? matches[0] ?? null
      return (exact != null ? ok : fail)(exact != null ? `Found component ${String(exact.target)}.` : `No component matched ${target}.`, {
        component: exact,
        matches,
        interactionStats: { ...context.cockpitInteractionStats }
      })
    },
    checkMaterial: (target, options = {}) => {
      const object = findObject(target)
      if (object == null) {
        return fail(`No scene object matched ${target}.`, {
          target,
          matches: collectNodes(target, 25),
          materials: collectMaterials(target, 25)
        })
      }
      return ok(`Checked materials for ${object.name || object.type}.`, {
        target,
        ...summarizeMaterialObject(object, options)
      })
    },
    checkGauge: (key, options = {}) => {
      const gauge = resolveGauge(key)
      if (gauge == null) return fail('No VCockpit gauge matched.', { key, gauges: gauges().map(summarizeGauge) })
      const canvas = gauge.captureImage ?? gauge.staticCaptureImage
      return ok(`Checked gauge ${gauge.gaugeKey}.`, {
        gauge: summarizeGauge(gauge),
        screenshot: options.screenshot === true && canvas != null ? canvasDataUrl(canvas) : null
      })
    },
    checkParam: names => {
      const requested = Array.isArray(names) ? names : [names]
      return ok('Checked runtime parameters.', requested.map(name => createDevApiParamCheck(name, context.getRuntimeHost())), [
        'Plane physics state is not wired into this viewer loop; plane source is unavailable in v1.'
      ])
    },
    setParam: (name, value, unit = null) => {
      const mapping = resolveDevApiParamMapping(name, unit)
      return api.writeVar(mapping.simVar, value, mapping.unit)
    },
    diagnostics: (options = {}) => {
      const report = collectDiagnosticsReport(options)
      const counts = report.counts as Record<string, number>
      const gaugeDiagnostics = report.gaugeDiagnostics as readonly unknown[]
      return ok(
        `Collected diagnostics: ${counts.error ?? 0} error, ${counts.warning ?? 0} warning, ${counts.info ?? 0} info, ${gaugeDiagnostics.length} gauge issue group(s).`,
        report
      )
    },
    readVar: (name, unit = null) => ok(`Read ${name}.`, { name, unit, value: context.getRuntimeHost().readVariable(name, unit) }),
    writeVar: (name, value, unit = null) => {
      context.getRuntimeHost().writeVariable(name, value, unit)
      return ok(`Wrote ${name}.`, { name, unit, value: context.getRuntimeHost().readVariable(name, unit) })
    },
    keyEvent: (name, args = []) => {
      context.getRuntimeHost().invokeKeyEvent(name, args)
      return ok(`Invoked key event ${name}.`, { name, args, recent: context.getRuntimeHost().getKeyEvents().at(-1) ?? null })
    },
    bridgeCall: (name, args = [1]) => {
      context.getRuntimeHost().invokeBridgeCall(name, args)
      return ok(`Invoked bridge call ${name}.`, {
        name,
        args,
        stats: context.getRuntimeHost().getStats(),
        value: context.getRuntimeHost().readVariable(`B:${name}`)
      })
    },
    events: (options = {}) => {
      const limit = Math.max(1, Math.min(500, Math.floor(options.limit ?? 100)))
      const recent = <T>(events: readonly T[]): readonly T[] => events.slice(-limit)
      return ok('Collected recent runtime events.', {
        key: options.kind == null || options.kind === 'key' ? recent(context.getRuntimeHost().getKeyEvents()) : [],
        html: options.kind == null || options.kind === 'html' ? recent(context.getRuntimeHost().getHtmlEvents()) : [],
        sound: options.kind == null || options.kind === 'sound' ? recent(context.getRuntimeHost().getSoundEvents()) : [],
        effect: options.kind == null || options.kind === 'effect' ? recent(context.getRuntimeHost().getEffectEvents()) : [],
        bridge: options.kind == null || options.kind === 'bridge' ? recent(context.getRuntimeHost().getBridgeEvents()) : [],
        interaction: options.kind == null || options.kind === 'interaction' ? { ...context.cockpitInteractionStats } : null
      })
    },
    watch: async (targets, options = {}) => {
      const names = Array.isArray(targets) ? targets : [targets]
      const durationMs = Math.max(0, Math.min(60_000, Math.floor(options.durationMs ?? 1_000)))
      const intervalMs = Math.max(16, Math.min(5_000, Math.floor(options.intervalMs ?? 100)))
      const started = performance.now()
      const samples: Record<string, unknown>[] = []
      do {
        samples.push({
          elapsedMs: performance.now() - started,
          values: Object.fromEntries(names.map(name => [name, context.getRuntimeHost().readVariable(name, options.unit ?? null)]))
        })
        await sleep(intervalMs)
      } while (performance.now() - started < durationMs)
      return ok('Collected watch samples.', { targets: names, samples })
    },
    waitFor: async (condition, timeoutMs = 10_000) => {
      const waitKind = getDevApiWaitConditionKind(condition)
      if (!isKnownDevApiWaitConditionKind(waitKind)) {
        return fail(`Unknown wait condition "${waitKind ?? ''}".`, {
          condition,
          supportedKinds: DEV_API_WAIT_CONDITION_KINDS
        })
      }
      const started = performance.now()
      while (performance.now() - started < timeoutMs) {
        if (evaluateDevApiWaitCondition(condition, api, context)) return ok('Wait condition satisfied.', { condition, elapsedMs: performance.now() - started })
        await sleep(50)
      }
      return fail('Timed out waiting for condition.', { condition, timeoutMs, status: statusData() })
    },
    perf: () => ok('Collected performance summary.', {
      fps: context.getFpsSnapshot(),
      rendererInfo: { memory: { ...context.renderer.info.memory }, render: { ...context.renderer.info.render } },
      runtimeHost: context.getRuntimeHost().getStats(),
      cockpitPerf: context.getCockpitPerfDiagnostics().getSummary(),
      activeInterior: context.getCockpitPerfDiagnostics().getActiveInteriorStats(),
      panelSurfaces: context.getCockpitPerfDiagnostics().getPanelSurfaceStats()
    }),
    screenshot: (options = {}) => {
      if (options.target === 'gauge') {
        const gauge = resolveGauge(options.key)
        const canvas = gauge?.captureImage ?? gauge?.staticCaptureImage ?? null
        return canvas == null
          ? fail('Gauge screenshot is unavailable.', { key: options.key, gauge: gauge == null ? null : summarizeGauge(gauge) })
          : ok('Captured gauge screenshot.', { key: gauge?.gaugeKey ?? null, dataUrl: canvasDataUrl(canvas) })
      }
      return ok('Captured viewport screenshot.', {
        dataUrl: canvasDataUrl(context.renderer.domElement),
        width: context.renderer.domElement.width,
        height: context.renderer.domElement.height
      })
    },
    visualCheck: target => {
      const screenshot = target == null ? api.screenshot() : api.screenshot({ target: 'gauge', key: target })
      const data = screenshot.data as { readonly dataUrl?: unknown; readonly width?: unknown; readonly height?: unknown }
      const dataUrl = typeof data.dataUrl === 'string' ? data.dataUrl : null
      return (screenshot.ok && dataUrl != null ? ok : fail)(
        screenshot.ok && dataUrl != null ? 'Visual target produced a screenshot.' : 'Visual target did not produce a screenshot.',
        { target: target ?? 'viewport', hasImage: dataUrl != null, dataUrlLength: dataUrl?.length ?? 0, width: data.width ?? null, height: data.height ?? null }
      )
    },
    highlight: (target, options = {}) => {
      if (highlightGroup != null) {
        context.scene.remove(highlightGroup)
        highlightGroup.clear()
      }
      const object = findObject(target)
      if (object == null) return fail(`No scene object matched ${target}.`, { target, matches: collectNodes(target, 25) })
      object.updateWorldMatrix(true, true)
      const box = new Box3().setFromObject(object)
      if (box.isEmpty()) return fail(`Object ${target} has no highlightable bounds.`, { target, object: object.name || object.type })
      highlightGroup = new Group()
      highlightGroup.name = 'dev-api-highlight'
      highlightGroup.add(new Box3Helper(box, 0x38d973))
      context.scene.add(highlightGroup)
      const durationMs = Math.max(0, Math.min(60_000, Math.floor(options.durationMs ?? 4_000)))
      if (durationMs > 0) {
        window.setTimeout(() => {
          if (highlightGroup != null) {
            context.scene.remove(highlightGroup)
            highlightGroup.clear()
            highlightGroup = null
          }
        }, durationMs)
      }
      return ok(`Highlighted ${object.name || object.type}.`, { target, object: object.name || object.type, bounds: { min: box.min.toArray(), max: box.max.toArray() } })
    },
    camera: {
      enterCockpit: async () => {
        const controller = context.getCockpitCameraController()
        if (!controller.isAvailable()) return fail('Cockpit camera is unavailable for this aircraft.', statusData())
        controller.enter('keyboard')
        await sleep(0)
        return ok('Entered cockpit view.', api.camera.getPose().data)
      },
      exitCockpit: () => {
        context.getCockpitCameraController().exit('keyboard')
        return ok('Exited cockpit view.', api.camera.getPose().data)
      },
      getPose: () => ok('Collected camera pose.', {
        position: context.camera.position.toArray(),
        quaternion: context.camera.quaternion.toArray(),
        target: context.controls.target.toArray(),
        cockpitActive: context.getCockpitCameraController().isActive()
      }),
      setPose: pose => {
        if (pose.position != null && pose.position.length >= 3) context.camera.position.fromArray([...pose.position] as number[])
        if (pose.target != null && pose.target.length >= 3) context.controls.target.fromArray([...pose.target] as number[])
        context.camera.lookAt(context.controls.target)
        context.controls.update()
        return ok('Updated camera pose.', api.camera.getPose().data)
      },
      frame: target => {
        const object = findObject(target)
        if (object == null) return fail(`No scene object matched ${target}.`, { target, matches: collectNodes(target, 25) })
        object.updateWorldMatrix(true, true)
        const bounds = new Box3().setFromObject(object)
        const center = bounds.getCenter(new Vector3())
        const size = bounds.getSize(new Vector3())
        const radius = Math.max(size.x, size.y, size.z, 1)
        context.camera.near = 0.1
        context.camera.far = Math.max(5000, radius * 40)
        context.camera.position.copy(center).add(new Vector3(radius * 1.2, radius * 0.35, radius * 1.05))
        context.camera.lookAt(center)
        context.camera.updateProjectionMatrix()
        context.controls.target.copy(center)
        context.controls.update()
        return ok(`Framed ${object.name || object.type}.`, api.camera.getPose().data)
      }
    },
    settings: {
      get: () => ok('Collected viewer settings.', context.getSettingsSnapshot()),
      set: async settings => ok(await context.applySettings(settings) ?? 'Updated viewer settings.', {
        requested: settings,
        effective: context.getSettingsSnapshot()
      })
    },
    input: {
      pointer: event => {
        const type = event.type === 'down' ? 'pointerdown' : event.type === 'up' ? 'pointerup' : event.type === 'move' ? 'pointermove' : 'click'
        context.renderer.domElement.dispatchEvent(new PointerEvent(type, { clientX: event.x, clientY: event.y, button: event.button ?? 0, bubbles: true }))
        return ok(`Dispatched ${type}.`, event)
      },
      key: (code, options = {}) => {
        const type = options.type ?? 'press'
        const dispatch = (eventType: 'keydown' | 'keyup'): void => {
          window.dispatchEvent(new KeyboardEvent(eventType, { code, key: code, bubbles: true }))
        }
        if (type === 'down' || type === 'press') dispatch('keydown')
        if (type === 'up' || type === 'press') dispatch('keyup')
        return ok(`Dispatched key ${code}.`, { code, type })
      },
      wheel: (deltaY, options = {}) => {
        context.renderer.domElement.dispatchEvent(new WheelEvent('wheel', {
          deltaY,
          clientX: options.x ?? context.renderer.domElement.clientWidth / 2,
          clientY: options.y ?? context.renderer.domElement.clientHeight / 2,
          bubbles: true
        }))
        return ok('Dispatched wheel event.', { deltaY, ...options })
      }
    }
  }
  const consoleApi = wrapDevApiForConsole(api, error =>
    fail('DevApi call failed.', {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null
    })
  )
  window.__DevApi = consoleApi
  ;(globalThis as Record<string, unknown>).__DevApi = consoleApi
}

function wrapDevApiForConsole<T>(
  value: T,
  createErrorResponse: (error: unknown) => DevApiResponse
): T {
  return wrapDevApiValueForConsole(value, '__DevApi', createErrorResponse, new WeakMap()) as T
}

function wrapDevApiValueForConsole(
  value: unknown,
  path: string,
  createErrorResponse: (error: unknown) => DevApiResponse,
  seen: WeakMap<object, unknown>
): unknown {
  if (typeof value === 'function') {
    return (...args: unknown[]) => {
      try {
        const result = value(...args)
        if (isPromiseLike(result)) {
          return result
            .then((response: unknown) => {
              logDevApiResponse(path, response)
              return response
            })
            .catch((error: unknown) => {
              const response = createErrorResponse(error)
              logDevApiResponse(path, response)
              return response
            })
        }
        logDevApiResponse(path, result)
        return result
      } catch (error) {
        const response = createErrorResponse(error)
        logDevApiResponse(path, response)
        return response
      }
    }
  }
  if (typeof value !== 'object' || value == null) {
    return value
  }
  const cached = seen.get(value)
  if (cached != null) {
    return cached
  }
  const wrapped: Record<string, unknown> = {}
  seen.set(value, wrapped)
  for (const [key, child] of Object.entries(value)) {
    wrapped[key] = wrapDevApiValueForConsole(
      child,
      `${path}.${key}`,
      createErrorResponse,
      seen
    )
  }
  return wrapped
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return typeof value === 'object' &&
    value != null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
}

function logDevApiResponse(path: string, response: unknown): void {
  if (!isDevApiResponse(response)) {
    console.info(`[DevApi] ${path} returned a non-response value.`, response)
    return
  }
  const method = response.ok ? console.info : console.warn
  method(`[DevApi] ${path}: ${response.summary}`, response)
}

function isDevApiResponse(value: unknown): value is DevApiResponse {
  if (typeof value !== 'object' || value == null) {
    return false
  }
  const candidate = value as { readonly ok?: unknown; readonly summary?: unknown; readonly data?: unknown }
  return typeof candidate.ok === 'boolean' &&
    typeof candidate.summary === 'string' &&
    'data' in candidate
}

function createDevApiParamCheck(
  name: string,
  runtimeHost: SharedMsfsRuntimeHost
): Record<string, unknown> {
  const mapping = resolveDevApiParamMapping(name)
  const simValue = runtimeHost.readVariable(mapping.simVar, mapping.unit)
  return {
    name,
    preset: mapping.preset,
    unit: mapping.unit,
    plane: { available: false, value: null, source: null },
    sim: {
      available: true,
      variable: mapping.simVar,
      value: simValue,
      longitude: mapping.preset === 'location' || mapping.preset === 'position'
        ? runtimeHost.readVariable('A:GPS POSITION LON', 'degrees')
        : undefined,
      altitude: mapping.preset === 'location' || mapping.preset === 'position'
        ? runtimeHost.readVariable('A:PLANE ALTITUDE', 'feet')
        : undefined,
      source: 'SharedMsfsRuntimeHost'
    },
    delta: null,
    sources: { plane: 'unavailable', sim: 'runtime-host' }
  }
}

function resolveDevApiParamMapping(
  name: string,
  unit: string | null = null
): { readonly preset: string; readonly simVar: string; readonly unit: string | null } {
  const preset = name.trim().toLowerCase().replace(/[\s_-]+/gu, '')
  if (preset === 'vspeed' || preset === 'verticalspeed') {
    return { preset, simVar: 'A:VERTICAL SPEED', unit: 'feet per minute' }
  }
  if (preset === 'alt' || preset === 'altitude') {
    return { preset, simVar: 'A:PLANE ALTITUDE', unit: 'feet' }
  }
  if (preset === 'pressure' || preset === 'baro' || preset === 'barometricpressure') {
    return { preset, simVar: 'A:AMBIENT PRESSURE', unit: 'inHg' }
  }
  if (preset === 'location' || preset === 'position') {
    return { preset, simVar: 'A:GPS POSITION LAT', unit: 'degrees' }
  }
  if (preset === 'gear' || preset === 'gearhandle' || preset === 'landinggear') {
    return { preset, simVar: 'A:GEAR HANDLE POSITION', unit: null }
  }
  if (preset === 'flap' || preset === 'flaps' || preset === 'flapshandle') {
    return { preset, simVar: 'A:FLAPS HANDLE PERCENT', unit: unit ?? 'percent' }
  }
  if (preset === 'spoiler' || preset === 'spoilers' || preset === 'speedbrake' || preset === 'speedbrakes') {
    return { preset, simVar: 'A:SPOILERS HANDLE POSITION', unit: unit ?? 'percent' }
  }
  if (preset === 'parkingbrake' || preset === 'parkbrake') {
    return { preset, simVar: 'A:BRAKE PARKING POSITION', unit: null }
  }
  return { preset, simVar: name, unit }
}

function finiteNumberOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Number(value) : fallback
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function dedupeDiagnostics(diagnostics: readonly ImportDiagnostic[]): ImportDiagnostic[] {
  const seen = new Set<string>()
  const deduped: ImportDiagnostic[] = []
  for (const diagnostic of diagnostics) {
    const key = [
      diagnostic.severity,
      diagnostic.code,
      diagnostic.sourcePath ?? '',
      diagnostic.message
    ].join('\0')
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    deduped.push(diagnostic)
  }
  return deduped
}

function evaluateDevApiWaitCondition(
  condition: DevApiWaitCondition,
  api: ViewerDevApi,
  context: ViewerDevApiContext
): boolean {
  const kind = getDevApiWaitConditionKind(condition)
  if (kind === 'viewerReady' || kind === 'ready') {
    const status = api.status().data as { readonly loadStage?: { readonly stage?: unknown } }
    return typeof status.loadStage?.stage === 'string' && status.loadStage.stage !== 'init:error'
  }
  if (kind === 'cockpitReady' || kind === 'cockpitActive') return context.getCockpitCameraController().isActive()
  if (kind === 'gaugesLoaded' || kind === 'gaugesReady') {
    const status = api.status().data as {
      readonly counts?: {
        readonly gauges?: unknown
        readonly loadedGauges?: unknown
        readonly capturedGauges?: unknown
      }
    }
    const total = typeof status.counts?.gauges === 'number' ? status.counts.gauges : 0
    const loaded = typeof status.counts?.loadedGauges === 'number' ? status.counts.loadedGauges : 0
    const captured = typeof status.counts?.capturedGauges === 'number' ? status.counts.capturedGauges : 0
    const gaugeRows = api.list({ kind: 'gauges', limit: 5_000 }).data as readonly {
      readonly captured?: unknown
      readonly hasCaptureImage?: unknown
      readonly textureName?: unknown
    }[]
    const isCapturableGauge = (gauge: { readonly captured?: unknown; readonly hasCaptureImage?: unknown; readonly textureName?: unknown }): boolean =>
      gauge.captured === true ||
      gauge.hasCaptureImage === true ||
      (typeof gauge.textureName === 'string' && gauge.textureName.toUpperCase() !== 'NO_TEXTURE')
    const capturableTotal = gaugeRows.filter(isCapturableGauge).length
    const capturableCaptured = gaugeRows.filter(
      gauge => isCapturableGauge(gauge) && gauge.captured === true
    ).length
    const requestedMinimum = typeof condition === 'string' ? undefined : condition.minimum
    const minimum =
      requestedMinimum == null
        ? total
        : Math.max(0, Math.min(total, Math.floor(requestedMinimum)))
    const capturedMinimum =
      requestedMinimum == null
        ? capturableTotal
        : Math.max(0, Math.min(capturableTotal, Math.floor(requestedMinimum)))
    const requireCaptured =
      kind === 'gaugesReady' &&
      (typeof condition === 'string' || condition.captured !== false)
    return total > 0 && loaded >= minimum && (!requireCaptured || (captured >= capturedMinimum && capturableCaptured >= capturedMinimum))
  }
  if (kind === 'gaugeCaptured') {
    const target = typeof condition === 'string' ? undefined : condition.target
    const gauge = (api.checkGauge(target).data as { readonly gauge?: { readonly captured?: unknown } }).gauge
    return gauge?.captured === true
  }
  if (kind === 'componentAvailable') {
    const target = typeof condition === 'string' ? '' : condition.target ?? ''
    return api.checkComponent(target).ok
  }
  if (kind === 'varEquals' || kind === 'varAbove' || kind === 'varBelow') {
    if (typeof condition === 'string' || condition.var == null) return false
    const value = context.getRuntimeHost().readVariable(condition.var, condition.unit ?? null)
    return (
      (condition.equals != null && Math.abs(value - condition.equals) < 1e-6) ||
      (condition.above != null && value > condition.above) ||
      (condition.below != null && value < condition.below)
    )
  }
  if (kind === 'noNewErrors') {
    const status = api.status().data as { readonly diagnostics?: { readonly error?: unknown } }
    return status.diagnostics?.error === 0
  }
  return false
}

const DEV_API_WAIT_CONDITION_KINDS = [
  'viewerReady',
  'ready',
  'cockpitReady',
  'cockpitActive',
  'gaugesLoaded',
  'gaugesReady',
  'gaugeCaptured',
  'componentAvailable',
  'varEquals',
  'varAbove',
  'varBelow',
  'noNewErrors'
] as const

function getDevApiWaitConditionKind(condition: DevApiWaitCondition): string | undefined {
  return typeof condition === 'string' ? condition : condition.kind
}

function isKnownDevApiWaitConditionKind(kind: string | undefined): boolean {
  return kind != null && DEV_API_WAIT_CONDITION_KINDS.includes(kind as (typeof DEV_API_WAIT_CONDITION_KINDS)[number])
}
