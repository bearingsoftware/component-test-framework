import { describe, it, expect, vi } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import { containerControl, type DockerRunner } from './container'

function fakeRunner(
  statuses: number[] = [],
  stderr = '',
): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = []
  const run = vi.fn<DockerRunner>(async (args) => {
    calls.push(args)
    return { status: statuses.length > 0 ? statuses.shift()! : 0, stderr }
  })
  return { run, calls }
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
    ['answers 399', 399, true],
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
})
