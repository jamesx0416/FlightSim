import type { CompatibilityBridgeSnapshot } from '../msfs/runtime/bridge.ts'
import type { AircraftCompatibilityDescriptor } from '../msfs/runtime/descriptor.ts'

export class MsfsCompatibilityDock {
  private readonly el: HTMLDivElement
  private readonly summaryEl: HTMLDivElement
  private readonly soundEl: HTMLPreElement
  private readonly eventEl: HTMLPreElement

  constructor(
    descriptor: AircraftCompatibilityDescriptor,
    runtimeId: string
  ) {
    this.el = document.createElement('div')
    this.el.style.position = 'fixed'
    this.el.style.right = '16px'
    this.el.style.bottom = '16px'
    this.el.style.width = '420px'
    this.el.style.maxHeight = '80vh'
    this.el.style.overflow = 'auto'
    this.el.style.padding = '12px'
    this.el.style.background = 'rgba(9, 14, 22, 0.82)'
    this.el.style.border = '1px solid rgba(123, 164, 255, 0.45)'
    this.el.style.borderRadius = '12px'
    this.el.style.backdropFilter = 'blur(18px)'
    this.el.style.color = '#eaf2ff'
    this.el.style.fontFamily = '"JetBrains Mono", monospace'
    this.el.style.fontSize = '11px'
    this.el.style.lineHeight = '1.45'
    this.el.style.zIndex = '12'

    const title = document.createElement('div')
    title.textContent = `MSFS Compatibility: ${descriptor.label}`
    title.style.fontSize = '13px'
    title.style.fontWeight = '700'
    title.style.marginBottom = '8px'
    this.el.appendChild(title)

    this.summaryEl = document.createElement('div')
    this.summaryEl.style.marginBottom = '10px'
    this.el.appendChild(this.summaryEl)

    const panelFrames = descriptor.panel?.surfaces
      .filter((surface) => surface.kind === 'htmlgauge')
      .slice(0, 2) ?? []
    if (panelFrames.length > 0) {
      this.el.appendChild(createSectionLabel('Panels'))
      for (const surface of panelFrames) {
        this.el.appendChild(
          createHostFrame(`${surface.hostUrl}&runtime=${encodeURIComponent(runtimeId)}`)
        )
      }
    }

    if (descriptor.wasm.gauges.length > 0) {
      this.el.appendChild(createSectionLabel('WASM'))
      for (const gauge of descriptor.wasm.gauges.slice(0, 2)) {
        this.el.appendChild(
          createHostFrame(`${gauge.hostUrl}&runtime=${encodeURIComponent(runtimeId)}`)
        )
      }
    }

    this.el.appendChild(createSectionLabel('Sound'))
    this.soundEl = document.createElement('pre')
    this.soundEl.style.margin = '6px 0 10px'
    this.soundEl.style.whiteSpace = 'pre-wrap'
    this.soundEl.textContent = 'Awaiting runtime snapshot...'
    this.el.appendChild(this.soundEl)

    this.el.appendChild(createSectionLabel('Events'))
    this.eventEl = document.createElement('pre')
    this.eventEl.style.margin = '6px 0 0'
    this.eventEl.style.whiteSpace = 'pre-wrap'
    this.eventEl.textContent = 'No events yet.'
    this.el.appendChild(this.eventEl)

    document.body.appendChild(this.el)
  }

  update(snapshot: CompatibilityBridgeSnapshot): void {
    this.summaryEl.textContent =
      `vars=${snapshot.variables.length} anim=${snapshot.animations.length} nodes=${snapshot.nodes.length} sound=${snapshot.sounds.filter((entry) => entry.active).length}`

    const activeSounds = snapshot.sounds
      .filter((entry) => entry.active)
      .slice(0, 6)
      .map((entry) => `${entry.category}: ${entry.eventName ?? '(unnamed)'}`)
    this.soundEl.textContent =
      activeSounds.length > 0 ? activeSounds.join('\n') : 'No active sound entries.'

    const recentEvents = snapshot.recentEvents
      .slice(-6)
      .map((entry) => `${entry.event.channel}:${entry.event.name}`)
    this.eventEl.textContent =
      recentEvents.length > 0 ? recentEvents.join('\n') : 'No events yet.'
  }

  dispose(): void {
    this.el.remove()
  }
}

function createSectionLabel(label: string): HTMLDivElement {
  const el = document.createElement('div')
  el.textContent = label
  el.style.marginTop = '8px'
  el.style.marginBottom = '6px'
  el.style.fontWeight = '700'
  el.style.textTransform = 'uppercase'
  el.style.letterSpacing = '0.08em'
  el.style.color = '#8fb4ff'
  return el
}

function createHostFrame(src: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.src = src
  frame.style.width = '100%'
  frame.style.height = '160px'
  frame.style.border = '1px solid rgba(143, 180, 255, 0.25)'
  frame.style.borderRadius = '10px'
  frame.style.background = 'rgba(3, 7, 12, 0.9)'
  frame.style.marginBottom = '8px'
  return frame
}
