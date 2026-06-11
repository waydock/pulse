export type AgentStatus = 'up' | 'down' | 'restarting'
export type Transition = 'up->down' | 'down->up'

export class AgentState {
  readonly confirm: number
  status: AgentStatus = 'up'
  private fails = 0

  constructor(confirm = 2) {
    this.confirm = confirm
  }

  onCheck(passed: boolean): Transition | null {
    if (passed) {
      this.fails = 0
      if (this.status === 'down' || this.status === 'restarting') {
        this.status = 'up'
        return 'down->up'
      }
      return null
    }

    // failed check
    if (this.status === 'up') {
      this.fails++
      if (this.fails >= this.confirm) {
        this.status = 'down'
        return 'up->down'
      }
      return null
    }

    // status is 'down' or 'restarting': a failed restart attempt returns to down, no new transition
    this.status = 'down'
    return null
  }

  markRestarting(): void {
    if (this.status === 'down') {
      this.status = 'restarting'
    }
  }
}
