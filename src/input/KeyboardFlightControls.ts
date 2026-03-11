import type { ControlInputs } from '../sim/FlightModel'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export class KeyboardFlightControls {
  private readonly pressed = new Set<string>()
  private throttle01 = 0.55
  private follow = false
  private resetRequested = false

  constructor(private readonly element: Window = window) {
    this.element.addEventListener('keydown', this.onKeyDown)
    this.element.addEventListener('keyup', this.onKeyUp)
  }

  dispose(): void {
    this.element.removeEventListener('keydown', this.onKeyDown)
    this.element.removeEventListener('keyup', this.onKeyUp)
  }

  consumeResetRequested(): boolean {
    const value = this.resetRequested
    this.resetRequested = false
    return value
  }

  consumeToggleFollowRequested(): boolean {
    const shouldToggle = this.wasPressedOnce('KeyC')
    if (shouldToggle) this.follow = !this.follow
    return shouldToggle
  }

  isFollowEnabled(): boolean {
    return this.follow
  }

  update(_dtSeconds: number): ControlInputs {
    const aileron = clamp(this.axis('ArrowRight', 'ArrowLeft'), -1, 1)
    const pitchScale = 1
    const elevator = clamp(this.axis('ArrowUp', 'ArrowDown') * pitchScale, -1, 1)
    const rudder = clamp(this.axis('KeyE', 'KeyQ'), -1, 1)

    return {
      throttle01: this.throttle01,
      aileron,
      elevator,
      rudder
    }
  }

  private axis(posKey: string, negKey: string): number {
    return (this.pressed.has(posKey) ? 1 : 0) - (this.pressed.has(negKey) ? 1 : 0)
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code)
    if (event.code === 'Backspace' && !event.repeat) this.resetRequested = true
    if (event.code === 'KeyC' && !event.repeat) this.singlePress.add('KeyC')

    if (!event.repeat && event.code.startsWith('Digit')) {
      const digit = Number(event.code.replace('Digit', ''))
      if (!Number.isNaN(digit)) {
        const next = Math.min(digit + 1, 10) / 10
        this.throttle01 = clamp(next, 0.1, 1)
      }
    }

    if (
      event.code === 'Backspace' ||
      event.code === 'KeyC' ||
      event.code === 'ArrowUp' ||
      event.code === 'ArrowDown' ||
      event.code === 'ArrowLeft' ||
      event.code === 'ArrowRight' ||
      event.code === 'KeyQ' ||
      event.code === 'KeyE' ||
      event.code.startsWith('Digit')
    ) {
      event.preventDefault()
    }
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code)
  }

  private readonly singlePress = new Set<string>()

  private wasPressedOnce(code: string): boolean {
    if (!this.singlePress.has(code)) return false
    this.singlePress.delete(code)
    return true
  }

}
