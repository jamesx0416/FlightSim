export class FixedStepLoop {
  private accumulatorSeconds = 0
  private lastTimeMs: number | undefined

  constructor(
    readonly stepSeconds: number,
    readonly maxSubStepsPerFrame = 6
  ) {}

  tick(timeMs: number, step: (dtSeconds: number) => void): void {
    if (this.lastTimeMs == null) {
      this.lastTimeMs = timeMs
      return
    }

    const frameSeconds = Math.min(
      Math.max((timeMs - this.lastTimeMs) / 1000, 0),
      this.stepSeconds * this.maxSubStepsPerFrame
    )
    this.lastTimeMs = timeMs
    this.accumulatorSeconds += frameSeconds

    let subSteps = 0
    while (
      this.accumulatorSeconds >= this.stepSeconds &&
      subSteps < this.maxSubStepsPerFrame
    ) {
      step(this.stepSeconds)
      this.accumulatorSeconds -= this.stepSeconds
      subSteps += 1
    }
  }
}

