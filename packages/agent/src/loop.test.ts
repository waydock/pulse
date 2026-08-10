import { describe, it, expect } from 'vitest'
import { nonOverlapping } from './loop.js'

const settle = () => new Promise((r) => setTimeout(r, 0))

describe('nonOverlapping', () => {
  it('runs the tick when nothing is in flight', async () => {
    let runs = 0
    const fire = nonOverlapping(async () => { runs++ })
    fire()
    await settle()
    expect(runs).toBe(1)
  })

  it('drops firings while a tick is still running', async () => {
    // The bug this exists for: a restart cycle sleeps seconds per attempt, so a
    // check tick can outlast its own interval. Without this, two ticks observe
    // the same agent down and both run its restart command.
    let runs = 0
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const fire = nonOverlapping(async () => { runs++; await blocked })

    fire(); fire(); fire()
    await settle()
    expect(runs).toBe(1)

    release()
    await settle()
    fire()
    await settle()
    expect(runs).toBe(2)
  })

  it('reports each dropped firing so the operator can widen the interval', async () => {
    let skips = 0
    let release!: () => void
    const blocked = new Promise<void>((r) => { release = r })
    const fire = nonOverlapping(async () => { await blocked }, { onSkip: () => { skips++ } })

    fire(); fire(); fire()
    await settle()
    expect(skips).toBe(2)
    release()
  })

  it('releases the guard when the tick throws, instead of wedging the loop shut', async () => {
    // A stuck guard would stop the loop forever and look exactly like a healthy
    // quiet system, which is the worst failure mode available to a watchdog.
    let runs = 0
    const fire = nonOverlapping(async () => { runs++; throw new Error('boom') })
    fire()
    await settle()
    fire()
    await settle()
    expect(runs).toBe(2)
  })

  it('does not let a throwing tick reject into the caller', async () => {
    const fire = nonOverlapping(async () => { throw new Error('boom') })
    expect(() => fire()).not.toThrow()
    await settle()
  })
})
