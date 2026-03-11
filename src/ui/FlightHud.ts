import type { PlaneStepResult } from '../entities/Plane'

function formatNumber(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—'
  return value.toFixed(digits)
}

export class FlightHud {
  private readonly el: HTMLDivElement

  constructor() {
    this.el = document.createElement('div')
    this.el.style.position = 'fixed'
    this.el.style.left = '12px'
    this.el.style.top = '12px'
    this.el.style.color = '#e8f0ff'
    this.el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    this.el.style.fontSize = '12px'
    this.el.style.whiteSpace = 'pre'
    this.el.style.textShadow = '0 1px 2px rgba(0,0,0,0.8)'
    this.el.style.pointerEvents = 'none'
    this.el.style.userSelect = 'none'
    document.body.appendChild(this.el)
  }

  dispose(): void {
    this.el.remove()
  }

  update(data: PlaneStepResult, followEnabled: boolean): void {
    const alphaDeg = (data.alphaRad * 180) / Math.PI
    const betaDeg = (data.betaRad * 180) / Math.PI

    this.el.textContent =
      `Flight\n` +
      `  follow: ${followEnabled ? 'on' : 'off'} (C)\n` +
      `  reset: Backspace\n` +
      `  throttle: 0-9 (10%-100%)\n` +
      `  roll: ←/→  pitch: ↑/↓  yaw: Q/E\n\n` +
      `State\n` +
      `  alt: ${formatNumber(data.altitudeMeters, 0)} m\n` +
      `  V:   ${formatNumber(data.airspeedMps, 1)} m/s\n` +
      `  rho: ${formatNumber(data.rhoKgPerM3, 3)} kg/m³\n` +
      `  α:   ${formatNumber(alphaDeg, 1)}°\n` +
      `  β:   ${formatNumber(betaDeg, 1)}°\n\n` +
      `Forces\n` +
      `  L: ${formatNumber(data.liftN, 0)} N  D: ${formatNumber(data.dragN, 0)} N  Y: ${formatNumber(data.sideN, 0)} N\n` +
      `  T: ${formatNumber(data.thrustN, 0)} N`
  }
}
