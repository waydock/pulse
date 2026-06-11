import { describe, it, expect } from 'vitest'
import { AgentState } from './state-machine.js'

describe('AgentState (confirm=2)', () => {
  it('starts up; one fail does not go down (below confirm)', () => {
    const s = new AgentState(2)
    expect(s.status).toBe('up')
    expect(s.onCheck(false)).toBeNull()
    expect(s.status).toBe('up')
  })
  it('goes down at `confirm` consecutive fails, emitting up->down once', () => {
    const s = new AgentState(2)
    expect(s.onCheck(false)).toBeNull()
    expect(s.onCheck(false)).toBe('up->down')
    expect(s.status).toBe('down')
    expect(s.onCheck(false)).toBeNull()   // staying down does not re-emit
    expect(s.status).toBe('down')
  })
  it('a pass resets the counter mid-confirm (never goes down)', () => {
    const s = new AgentState(3)
    s.onCheck(false); s.onCheck(false)
    expect(s.onCheck(true)).toBeNull()    // pass resets; still up
    expect(s.status).toBe('up')
    expect(s.onCheck(false)).toBeNull()   // counter restarted from 0
    expect(s.status).toBe('up')
  })
  it('recovers down->up on a pass', () => {
    const s = new AgentState(1)
    expect(s.onCheck(false)).toBe('up->down')
    expect(s.onCheck(true)).toBe('down->up')
    expect(s.status).toBe('up')
  })
  it('restarting then a pass returns to up (down->up)', () => {
    const s = new AgentState(1)
    s.onCheck(false)                      // -> down
    s.markRestarting()
    expect(s.status).toBe('restarting')
    expect(s.onCheck(true)).toBe('down->up')
    expect(s.status).toBe('up')
  })
  it('restarting then a fail stays down-ish, no new up->down', () => {
    const s = new AgentState(1)
    s.onCheck(false); s.markRestarting()
    expect(s.onCheck(false)).toBeNull()
    expect(s.status).toBe('down')         // restart attempt failed -> back to down, not a new transition
  })
})

describe('AgentState.seed()', () => {
  it('seed("down") sets status to down without emitting any transition', () => {
    const s = new AgentState(2)
    s.seed('down')
    expect(s.status).toBe('down')
  })
  it('after seed("down"), a passed check returns down->up (not up->down)', () => {
    const s = new AgentState(2)
    s.seed('down')
    expect(s.onCheck(true)).toBe('down->up')
    expect(s.status).toBe('up')
  })
  it('after seed("down"), a failed check returns null (already down — no duplicate alert)', () => {
    const s = new AgentState(2)
    s.seed('down')
    expect(s.onCheck(false)).toBeNull()
    expect(s.status).toBe('down')
  })
  it('seed("up") leaves status up and a single fail does not immediately fire up->down', () => {
    const s = new AgentState(2)
    s.seed('up')
    expect(s.status).toBe('up')
    expect(s.onCheck(false)).toBeNull()   // confirm=2, only 1 fail
  })
})
