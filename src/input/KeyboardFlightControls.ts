import type { ControlInputs } from '../sim/FlightModel'

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export class KeyboardFlightControls {
  private readonly pressed = new Set<string>()
  private throttle01 = 0.35
  private flapDetentIndex = 2
  private readonly flapDetents01 = [0, 0.2, 0.45, 0.7, 1] as const
  private gearDown = true
  private spoiler01 = 0
  private follow = true
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
      rudder,
      flapTarget01: this.flapDetents01[this.flapDetentIndex],
      gearDown: this.gearDown,
      spoilerTarget01: this.spoiler01
    }
  }

  private axis(posKey: string, negKey: string): number {
    return (this.pressed.has(posKey) ? 1 : 0) - (this.pressed.has(negKey) ? 1 : 0)
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code)
    if (event.code === 'Backspace' && !event.repeat) this.resetRequested = true
    if (event.code === 'KeyC' && !event.repeat) this.singlePress.add('KeyC')
    if (!event.repeat && event.code === 'BracketLeft') {
      this.flapDetentIndex = Math.max(0, this.flapDetentIndex - 1)
    }
    if (!event.repeat && event.code === 'BracketRight') {
      this.flapDetentIndex = Math.min(
        this.flapDetents01.length - 1,
        this.flapDetentIndex + 1
      )
    }
    if (!event.repeat && event.code === 'KeyG') {
      this.gearDown = !this.gearDown
    }
    if (!event.repeat && event.code === 'Minus') {
      this.spoiler01 = clamp(this.spoiler01 - 0.25, 0, 1)
    }
    if (!event.repeat && event.code === 'Equal') {
      this.spoiler01 = clamp(this.spoiler01 + 0.25, 0, 1)
    }

    if (!event.repeat && event.code.startsWith('Digit')) {
      const digit = Number(event.code.replace('Digit', ''))
      if (!Number.isNaN(digit)) {
        this.throttle01 = digit === 0 ? 0 : clamp(digit / 10, 0, 1)
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
      event.code === 'BracketLeft' ||
      event.code === 'BracketRight' ||
      event.code === 'KeyG' ||
      event.code === 'Minus' ||
      event.code === 'Equal' ||
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
