import type {
  CompatibilityBridgeMessage,
  CompatibilityBridgeSnapshot
} from './bridge.ts'
import { compatibilityChannelName } from './bridge.ts'
import type { AircraftCompatibilityDescriptor } from './descriptor.ts'
import { loadCompatibilityDescriptor } from './loader.ts'
import type {
  PanelSurfaceDescriptor,
  WasmGaugeDescriptor
} from './descriptor.ts'

export async function mountCompatibilityHostPage(
  mode: 'panel' | 'wasm'
): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const descriptorId = params.get('descriptor')
  const surfaceId = params.get('surface')
  const runtimeId = params.get('runtime')

  if (!descriptorId || !surfaceId) {
    document.body.textContent = 'Missing descriptor or surface id.'
    return
  }

  const descriptor = await loadCompatibilityDescriptor(descriptorId)
  const target =
    mode === 'panel'
      ? descriptor.panel?.surfaces.find((surface) => surface.id === surfaceId)
      : descriptor.wasm.gauges.find((gauge) => gauge.id === surfaceId)

  if (!target) {
    document.body.textContent = 'Requested surface was not found.'
    return
  }

  renderHostShell(descriptor, target, mode)

  if (!runtimeId) return
  const channel = new BroadcastChannel(compatibilityChannelName(runtimeId))
  const variableList = ensureTarget('variable-list')
  const eventList = ensureTarget('event-list')
  const metaList = ensureTarget('meta-list')
  const button = ensureTarget('write-variable') as HTMLButtonElement
  const variableNameInput = ensureTarget('variable-name') as HTMLInputElement
  const variableValueInput = ensureTarget('variable-value') as HTMLInputElement
  const eventButton = ensureTarget('emit-event') as HTMLButtonElement
  const eventNameInput = ensureTarget('event-name') as HTMLInputElement

  button.onclick = () => {
    if (!variableNameInput.value.trim()) return
    const numericValue = Number.parseFloat(variableValueInput.value)
    const message: CompatibilityBridgeMessage = {
      type: 'set-variable',
      reference: {
        namespace: 'lvar',
        name: variableNameInput.value.trim(),
        unit: 'number'
      },
      value: Number.isFinite(numericValue) ? numericValue : variableValueInput.value
    }
    channel.postMessage(message)
  }

  eventButton.onclick = () => {
    if (!eventNameInput.value.trim()) return
    const message: CompatibilityBridgeMessage = {
      type: 'emit-event',
      event: {
        channel: 'custom',
        name: eventNameInput.value.trim(),
        payloadShape: 'none'
      }
    }
    channel.postMessage(message)
  }

  channel.onmessage = (event: MessageEvent<CompatibilityBridgeMessage>) => {
    if (event.data?.type !== 'snapshot') return
    const snapshot = event.data.snapshot
    variableList.textContent = snapshot.variables
      .slice(0, 10)
      .map((entry) => `${entry.reference.namespace}:${entry.reference.name}=${entry.value}`)
      .join('\n')
    eventList.textContent = snapshot.recentEvents
      .slice(-6)
      .map((entry) => `${entry.event.channel}:${entry.event.name}`)
      .join('\n') || 'No events yet.'
    metaList.textContent = buildMetaText(snapshot, target, mode)
  }

  window.addEventListener('beforeunload', () => {
    channel.close()
  })
}

function renderHostShell(
  descriptor: AircraftCompatibilityDescriptor,
  target: PanelSurfaceDescriptor | WasmGaugeDescriptor,
  mode: 'panel' | 'wasm'
): void {
  document.body.innerHTML = `
    <main style="margin:0;padding:12px;background:#050a11;color:#eef4ff;font:12px/1.45 'JetBrains Mono', monospace;min-height:100vh;">
      <div style="font-weight:700;margin-bottom:8px;">${mode.toUpperCase()} Host</div>
      <div style="margin-bottom:10px;color:#9ab7ff;">${escapeHtml(descriptor.label)}</div>
      <pre id="meta-list" style="white-space:pre-wrap;margin:0 0 10px;"></pre>
      <div style="font-weight:700;margin-bottom:6px;">Variables</div>
      <pre id="variable-list" style="white-space:pre-wrap;margin:0 0 10px;">Awaiting runtime snapshot...</pre>
      <div style="font-weight:700;margin-bottom:6px;">Events</div>
      <pre id="event-list" style="white-space:pre-wrap;margin:0 0 10px;">No events yet.</pre>
      <div style="display:grid;grid-template-columns:1fr 88px;gap:6px;margin-bottom:6px;">
        <input id="variable-name" placeholder="LVar name" style="${inputStyle()}" />
        <input id="variable-value" placeholder="value" style="${inputStyle()}" />
      </div>
      <button id="write-variable" style="${buttonStyle()}">Write LVar</button>
      <div style="display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:8px;">
        <input id="event-name" placeholder="Custom event" style="${inputStyle()}" />
        <button id="emit-event" style="${buttonStyle()}">Emit</button>
      </div>
      ${
        'resourceUrl' in target && target.resourceUrl
          ? `<div style="margin-top:8px;"><a href="${target.resourceUrl}" target="_blank" rel="noreferrer" style="color:#8fb4ff;">Open source asset</a></div>`
          : ''
      }
    </main>
  `
}

function buildMetaText(
  snapshot: CompatibilityBridgeSnapshot,
  target: PanelSurfaceDescriptor | WasmGaugeDescriptor,
  mode: 'panel' | 'wasm'
): string {
  const lines = [
    `mode=${mode}`,
    `runtime=${snapshot.runtimeId}`,
    `generated=${snapshot.generatedAt}`
  ]

  if ('resource' in target) {
    lines.push(`resource=${target.resource}`)
  }
  if ('moduleName' in target) {
    lines.push(`module=${target.moduleName}`)
    if (target.gaugeName) {
      lines.push(`gauge=${target.gaugeName}`)
    }
  }

  return lines.join('\n')
}

function ensureTarget(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) {
    throw new Error(`Missing host page element: ${id}`)
  }
  return element
}

function inputStyle(): string {
  return 'width:100%;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid rgba(143,180,255,0.25);background:#0b1320;color:#eef4ff;'
}

function buttonStyle(): string {
  return 'padding:8px 10px;border-radius:8px;border:1px solid rgba(143,180,255,0.35);background:#12315d;color:#eef4ff;cursor:pointer;'
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
