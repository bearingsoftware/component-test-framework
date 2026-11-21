import { describe, it, expect, vi } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import { containerControl, type DockerRunner } from './container'

function fakeRunner(
  statuses: number[] = [],
  stderr = '',
): { run: DockerRunner; calls: string[][]; timeouts: number[] } {
  const calls: string[][] = []
  const timeouts: number[] = []
  const run = vi.fn<DockerRunner>(async (args, timeoutMs) => {
    calls.push(args)
    timeouts.push(timeoutMs)
    return { status: statuses.length > 0 ? statuses.shift()! : 0, stderr }
  })
  return { run, calls, timeouts }
}

async function freePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('container control (COMPONENT-39)', () => {
  it.each([
    ['empty', ''],
    ['leading dash', '-rf'],
    ['shell metacharacters', 'db; rm -rf /'],
    ['slash', 'a/b'],
  ])('rejects a %s name before calling docker', async (_, name) => {
    const { run } = fakeRunner()
    const control = containerControl(run)
    await expect(control.restartContainer(name)).rejects.toThrow('invalid container name')
    await expect(control.stopContainer(name)).rejects.toThrow('invalid container name')
    await expect(control.startContainer(name)).rejects.toThrow('invalid container name')
    expect(run).not.toHaveBeenCalled()
  })

  it('restarts, stops and starts with the docker CLI and no readiness wait', async () => {
    const { run, calls } = fakeRunner()
    const control = containerControl(run)
    await control.restartContainer('ctf39-db')
    await control.stopContainer('ctf39-db')
    await control.startContainer('ctf39-db')
    expect(calls).toEqual([
      ['restart', 'ctf39-db'],
      ['stop', 'ctf39-db'],
      ['start', 'ctf39-db'],
    ])
  })

  it('names the container and docker stderr when docker fails', async () => {
    const { run } = fakeRunner([1], 'Error: No such container: ctf39-gone\n')
    const control = containerControl(run)
    await expect(control.stopContainer('ctf39-gone')).rejects.toThrow(
      'stopping container ctf39-gone failed: Error: No such container: ctf39-gone',
    )
  })

  it('falls back to the exit status when docker says nothing', async () => {
    const { run } = fakeRunner([2])
    await expect(containerControl(run).startContainer('ctf39-x')).rejects.toThrow(
      'starting container ctf39-x failed: docker exited 2',
    )
  })

  it('polls an exec readiness check until it exits 0', async () => {
    // restart, then three failing probes, then a passing one
    const { run, calls } = fakeRunner([0, 1, 1, 1, 0])
    await containerControl(run).restartContainer('ctf39-db', {
      readiness: { exec: ['pg_isready', '-q'] },
      timeoutMs: 10_000,
    })
    expect(calls.slice(1)).toEqual(Array(4).fill(['exec', 'ctf39-db', 'pg_isready', '-q']))
  })

  it('times out naming the container and the readiness check', async () => {
    const { run } = fakeRunner([0, ...Array(1000).fill(1)])
    await expect(
      containerControl(run).restartContainer('ctf39-slow', {
        readiness: { exec: ['true'] },
        timeoutMs: 300,
      }),
    ).rejects.toThrow('container ctf39-slow was not ready within 300 ms (exec true)')
  })

  it('waits for a TCP readiness port to accept connections', async () => {
    const server = net.createServer((s) => s.end())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    try {
      const { run, calls } = fakeRunner()
      await containerControl(run).startContainer('ctf39-tcp', {
        readiness: { tcp: { host: '127.0.0.1', port } },
      })
      expect(calls).toEqual([['start', 'ctf39-tcp']])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('times out on a TCP port nothing listens on', async () => {
    const port = await freePort()
    const { run } = fakeRunner()
    await expect(
      containerControl(run).restartContainer('ctf39-tcp', {
        readiness: { tcp: { host: '127.0.0.1', port } },
        timeoutMs: 300,
      }),
    ).rejects.toThrow(`container ctf39-tcp was not ready within 300 ms (tcp 127.0.0.1:${port})`)
  })

  it.each([
    ['answers 200', 200, true],
    ['answers 204', 204, true],
    ['answers 302, a redirect', 302, false],
    ['answers 503', 503, false],
  ])('HTTP readiness %s', async (_, code, ready) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(code)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    const url = `http://127.0.0.1:${port}/health`
    const { run } = fakeRunner()
    const promise = containerControl(run).startContainer('ctf39-http', {
      readiness: { http: url },
      timeoutMs: 300,
    })
    try {
      if (ready) await expect(promise).resolves.toBeUndefined()
      else
        await expect(promise).rejects.toThrow(
          `container ctf39-http was not ready within 300 ms (http ${url})`,
        )
    } finally {
      server.close()
    }
  })
  it('gives up on a docker call that never returns, after its timeout', async () => {
    const control = containerControl(() => new Promise<never>(() => {}))
    await expect(control.restartContainer('ctf39-hung', { timeoutMs: 200 })).rejects.toThrow(
      'restarting container ctf39-hung timed out after 200 ms',
    )
    await expect(control.startContainer('ctf39-hung', { timeoutMs: 200 })).rejects.toThrow(
      'starting container ctf39-hung timed out after 200 ms',
    )
  })

  it('stop gives up after the default 30 s', async () => {
    vi.useFakeTimers()
    try {
      const promise = containerControl(() => new Promise<never>(() => {})).stopContainer(
        'ctf39-hung',
      )
      const assertion = expect(promise).rejects.toThrow(
        'stopping container ctf39-hung timed out after 30000 ms',
      )
      await vi.advanceTimersByTimeAsync(30_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('caps each exec probe at 1 s and at the time left before the deadline', async () => {
    const { run, timeouts } = fakeRunner([0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    await expect(
      containerControl(run).restartContainer('ctf39-db', {
        readiness: { exec: ['true'] },
        timeoutMs: 1_500,
      }),
    ).rejects.toThrow('not ready within 1500 ms')
    const probes = timeouts.slice(1)
    expect(probes[0]).toBe(1_000)
    expect(Math.max(...probes)).toBeLessThanOrEqual(1_000)
    expect(probes.at(-1)!).toBeLessThanOrEqual(1_000)
  })

  it('treats a hung exec probe as not ready and times out at the deadline', async () => {
    let calls = 0
    const run: DockerRunner = (args) => {
      calls++
      if (args[0] === 'restart') return Promise.resolve({ status: 0, stderr: '' })
      return new Promise<never>(() => {})
    }
    await expect(
      containerControl(run).restartContainer('ctf39-db', {
        readiness: { exec: ['pg_isready'] },
        timeoutMs: 400,
      }),
    ).rejects.toThrow('container ctf39-db was not ready within 400 ms (exec pg_isready)')
    expect(calls).toBeGreaterThan(1)
  })

  it.each([
    ['no kind set', {}],
    ['an empty exec argv', { exec: [] }],
  ])('rejects readiness with %s before calling docker', async (_, readiness) => {
    const { run } = fakeRunner()
    const control = containerControl(run)
    await expect(control.restartContainer('ctf39-db', { readiness })).rejects.toThrow('readiness')
    await expect(control.startContainer('ctf39-db', { readiness })).rejects.toThrow('readiness')
    expect(run).not.toHaveBeenCalled()
  })
})
