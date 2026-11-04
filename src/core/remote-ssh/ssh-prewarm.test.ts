import { describe, it, expect, vi } from 'vitest'
import { planSshPrewarm, runSshPrewarm, type SshPrewarmCandidate } from './ssh-prewarm'
import type { SshConnection } from '../../shared/ssh'

const conn = (host: string): SshConnection => ({ host, user: 'u', label: host })
const sshProject = (id: string, host: string, over: Partial<SshPrewarmCandidate> = {}): SshPrewarmCandidate => ({
  id,
  ssh: { server: conn(host), remoteCwd: '/srv' },
  ...over
})

describe('planSshPrewarm', () => {
  it('plans the open SSH projects, in index order', () => {
    const plan = planSshPrewarm({
      projects: [sshProject('p1', 'a'), { id: 'local' }, sshProject('p2', 'b')],
      busy: () => false
    })
    expect(plan.map((t) => t.projectId)).toEqual(['p1', 'p2'])
    expect(plan[0]).toEqual({ projectId: 'p1', conn: conn('a'), remoteCwd: '/srv' })
  })

  it('never dials a WSL project: that would start a distro nobody asked for at launch', () => {
    const wsl = { id: 'w1', ssh: { server: conn('ubuntu-0123456789abcdef.wsl.nodeterm.invalid'), remoteCwd: '~' } }
    const plan = planSshPrewarm({ projects: [wsl, sshProject('p2', 'b')], busy: () => false })
    expect(plan.map((t) => t.projectId)).toEqual(['p2'])
  })

  it('never dials a CLOSED project — a closed tab is the user saying "not now"', () => {
    const plan = planSshPrewarm({
      projects: [sshProject('p1', 'a', { closed: true }), sshProject('p2', 'b')],
      busy: () => false
    })
    expect(plan.map((t) => t.projectId)).toEqual(['p2'])
  })

  it('skips a project that is already connected or already being connected', () => {
    const plan = planSshPrewarm({
      projects: [sshProject('p1', 'a'), sshProject('p2', 'b')],
      busy: (id) => id === 'p1'
    })
    expect(plan.map((t) => t.projectId)).toEqual(['p2'])
  })

  it('plans one master per project id even if the index repeats one', () => {
    const plan = planSshPrewarm({
      projects: [sshProject('p1', 'a'), sshProject('p1', 'a')],
      busy: () => false
    })
    expect(plan).toHaveLength(1)
  })
})

describe('runSshPrewarm', () => {
  it('dials ONE HOST AT A TIME, never a burst', async () => {
    const order: string[] = []
    let inFlight = 0
    let peak = 0
    const connect = vi.fn(async (t: { projectId: string }) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      order.push(t.projectId)
      await Promise.resolve()
      inFlight--
    })
    const attempted = await runSshPrewarm(
      [
        { projectId: 'p1', conn: conn('a') },
        { projectId: 'p2', conn: conn('b') },
        { projectId: 'p3', conn: conn('c') }
      ],
      { connect, busy: () => false, delay: async () => {}, gapMs: 10 }
    )
    expect(attempted).toBe(3)
    expect(peak).toBe(1)
    expect(order).toEqual(['p1', 'p2', 'p3'])
  })

  it('re-asks at FIRE time: a project opened mid-queue is left to its own connect', async () => {
    const dialed: string[] = []
    const busy = new Set<string>()
    await runSshPrewarm(
      [
        { projectId: 'p1', conn: conn('a') },
        { projectId: 'p2', conn: conn('b') }
      ],
      {
        connect: async (t) => {
          dialed.push(t.projectId)
          busy.add('p2') // the user switched to p2 while p1 was dialing
        },
        busy: (id) => busy.has(id),
        delay: async () => {},
        gapMs: 0
      }
    )
    expect(dialed).toEqual(['p1'])
  })

  it('a failing dial is swallowed and the queue continues — a pre-warm never banners', async () => {
    const dialed: string[] = []
    const attempted = await runSshPrewarm(
      [
        { projectId: 'p1', conn: conn('a') },
        { projectId: 'p2', conn: conn('b') }
      ],
      {
        connect: async (t) => {
          dialed.push(t.projectId)
          if (t.projectId === 'p1') throw new Error('Could not establish the SSH connection.')
        },
        busy: () => false,
        delay: async () => {},
        gapMs: 0
      }
    )
    expect(dialed).toEqual(['p1', 'p2'])
    expect(attempted).toBe(2)
  })

  it('leaves a gap between hosts, but not a trailing one', async () => {
    const delay = vi.fn(async () => {})
    await runSshPrewarm(
      [
        { projectId: 'p1', conn: conn('a') },
        { projectId: 'p2', conn: conn('b') }
      ],
      { connect: async () => {}, busy: () => false, delay, gapMs: 750 }
    )
    expect(delay).toHaveBeenCalledTimes(1)
    expect(delay).toHaveBeenCalledWith(750)
  })

  it('stops when asked (quit)', async () => {
    const dialed: string[] = []
    let stop = false
    await runSshPrewarm(
      [
        { projectId: 'p1', conn: conn('a') },
        { projectId: 'p2', conn: conn('b') }
      ],
      {
        connect: async (t) => {
          dialed.push(t.projectId)
          stop = true
        },
        busy: () => false,
        delay: async () => {},
        gapMs: 0,
        stopped: () => stop
      }
    )
    expect(dialed).toEqual(['p1'])
  })
})
