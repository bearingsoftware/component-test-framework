// Stops, starts and restarts a Docker container from a suite, with the docker
// CLI and no shell. Readiness is polled until it passes or the timeout ends.
import { execFile } from 'node:child_process'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'

/** How a container counts as ready after it starts or restarts. */
export interface ContainerReadiness {
  /** A TCP connection to `host:port` is accepted. */
  tcp?: { host: string; port: number }
  /** A GET to this URL answers with a 2xx status. A redirect is not ready. */
  http?: string
  /** `docker exec <name> …` with this argv exits 0. */
  exec?: string[]
}

export interface ContainerOptions {
  readiness?: ContainerReadiness
  /** How long each docker call and the readiness wait may take, in ms. Default 30s. */
  timeoutMs?: number
}

export interface DockerResult {
  status: number
  stderr: string
}

/** Runs `docker` with the given arguments, killing it after `timeoutMs`. Rejects only when docker can't be started. */
export type DockerRunner = (args: string[], timeoutMs: number) => Promise<DockerResult>

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const POLL_MS = 200
const PROBE_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30_000

const runDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8', timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('docker is not installed or not on PATH'))
        return
      }
      const status = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ status, stderr })
    })
  })

class CallTimeout extends Error {}

// A runner that never resolves must not hang the suite, so the race is here as well as in execFile.
function timed<T>(pending: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CallTimeout(`${what} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    )
  })
  return Promise.race([pending, expired]).finally(() => clearTimeout(timer))
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid container name "${name}"`)
}

function checkReadiness(readiness: ContainerReadiness | undefined): void {
  if (!readiness) return
  if (readiness.exec?.length === 0) throw new Error('readiness exec needs an argv, got []')
  if (!readiness.tcp && !readiness.http && !readiness.exec) {
    throw new Error('readiness needs one of tcp, http or exec')
  }
}

function describeReadiness(readiness: ContainerReadiness): string {
  if (readiness.tcp) return `tcp ${readiness.tcp.host}:${readiness.tcp.port}`
  if (readiness.http) return `http ${readiness.http}`
  return `exec ${(readiness.exec ?? []).join(' ')}`
}

function tcpReady(
  { host, port }: { host: string; port: number },
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function httpReady(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new URL(url).protocol === 'https:' ? https : http
    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      const status = res.statusCode ?? 0
      resolve(status >= 200 && status < 300)
    })
    req.once('timeout', () => req.destroy())
    req.once('error', () => resolve(false))
  })
}

/** The container-control functions over an injected docker runner. */
export function containerControl(run: DockerRunner) {
  async function docker(args: string[], timeoutMs: number, what: string): Promise<void> {
    const result = await timed(run(args, timeoutMs), timeoutMs, what)
    if (result.status !== 0) {
      throw new Error(`${what} failed: ${result.stderr.trim() || `docker exited ${result.status}`}`)
    }
  }

  async function probe(
    name: string,
    readiness: ContainerReadiness,
    timeoutMs: number,
  ): Promise<boolean> {
    if (readiness.tcp) return tcpReady(readiness.tcp, timeoutMs)
    if (readiness.http) return httpReady(readiness.http, timeoutMs)
    try {
      const result = await timed(
        run(['exec', name, ...(readiness.exec ?? [])], timeoutMs),
        timeoutMs,
        `checking ${name}`,
      )
      return result.status === 0
    } catch (err) {
      if (err instanceof CallTimeout) return false
      throw err
    }
  }

  async function waitReady(name: string, options: ContainerOptions): Promise<void> {
    const { readiness } = options
    if (!readiness) return
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(
          `container ${name} was not ready within ${timeoutMs} ms (${describeReadiness(readiness)})`,
        )
      }
      if (await probe(name, readiness, Math.min(PROBE_MS, left))) return
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))),
      )
    }
  }

  return {
    async restartContainer(name: string, options: ContainerOptions = {}): Promise<void> {
      checkName(name)
      checkReadiness(options.readiness)
      await docker(
        ['restart', name],
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `restarting container ${name}`,
      )
      await waitReady(name, options)
    },
    async stopContainer(name: string): Promise<void> {
      checkName(name)
      await docker(['stop', name], DEFAULT_TIMEOUT_MS, `stopping container ${name}`)
    },
    async startContainer(name: string, options: ContainerOptions = {}): Promise<void> {
      checkName(name)
      checkReadiness(options.readiness)
      await docker(
        ['start', name],
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        `starting container ${name}`,
      )
      await waitReady(name, options)
    },
  }
}

const control = containerControl(runDocker)

/** Restart a container and wait for `readiness`. */
export const restartContainer = control.restartContainer
/** Stop a container. */
export const stopContainer = control.stopContainer
/** Start a container and wait for `readiness`. */
export const startContainer = control.startContainer
