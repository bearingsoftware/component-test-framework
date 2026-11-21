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
  /** A GET to this URL answers with a status below 400. */
  http?: string
  /** `docker exec <name> …` with this argv exits 0. */
  exec?: string[]
}

export interface ContainerOptions {
  readiness?: ContainerReadiness
  /** How long to wait for readiness, in ms. Default 30s. */
  timeoutMs?: number
}

export interface DockerResult {
  status: number
  stderr: string
}

/** Runs `docker` with the given arguments. Rejects only when docker can't be started. */
export type DockerRunner = (args: string[]) => Promise<DockerResult>

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const POLL_MS = 200
const PROBE_MS = 1_000
const DEFAULT_TIMEOUT_MS = 30_000

const runDocker: DockerRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8' }, (err, _stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('docker is not installed or not on PATH'))
        return
      }
      const status = err ? (typeof err.code === 'number' ? err.code : 1) : 0
      resolve({ status, stderr })
    })
  })

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid container name "${name}"`)
}

function describeReadiness(readiness: ContainerReadiness): string {
  if (readiness.tcp) return `tcp ${readiness.tcp.host}:${readiness.tcp.port}`
  if (readiness.http) return `http ${readiness.http}`
  return `exec ${(readiness.exec ?? []).join(' ')}`
}

function tcpReady({ host, port }: { host: string; port: number }): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(PROBE_MS, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

function httpReady(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new URL(url).protocol === 'https:' ? https : http
    const req = client.get(url, { timeout: PROBE_MS }, (res) => {
      res.resume()
      resolve((res.statusCode ?? 500) < 400)
    })
    req.once('timeout', () => req.destroy())
    req.once('error', () => resolve(false))
  })
}

/** The container-control functions over an injected docker runner. */
export function containerControl(run: DockerRunner) {
  async function docker(args: string[], what: string): Promise<void> {
    const result = await run(args)
    if (result.status !== 0) {
      throw new Error(`${what} failed: ${result.stderr.trim() || `docker exited ${result.status}`}`)
    }
  }

  async function probe(name: string, readiness: ContainerReadiness): Promise<boolean> {
    if (readiness.tcp) return tcpReady(readiness.tcp)
    if (readiness.http) return httpReady(readiness.http)
    const result = await run(['exec', name, ...(readiness.exec ?? [])])
    return result.status === 0
  }

  async function waitReady(name: string, options: ContainerOptions): Promise<void> {
    if (!options.readiness) return
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    while (!(await probe(name, options.readiness))) {
      const left = deadline - Date.now()
      if (left <= 0) {
        throw new Error(
          `container ${name} was not ready within ${timeoutMs} ms (${describeReadiness(options.readiness)})`,
        )
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, left)))
    }
  }

  return {
    async restartContainer(name: string, options: ContainerOptions = {}): Promise<void> {
      checkName(name)
      await docker(['restart', name], `restarting container ${name}`)
      await waitReady(name, options)
    },
    async stopContainer(name: string): Promise<void> {
      checkName(name)
      await docker(['stop', name], `stopping container ${name}`)
    },
    async startContainer(name: string, options: ContainerOptions = {}): Promise<void> {
      checkName(name)
      await docker(['start', name], `starting container ${name}`)
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
