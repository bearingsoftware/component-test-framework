import { When } from '@cucumber/cucumber'
import { requireApiBaseUrl } from '../../support/config'
import type { ComponentTestWorld } from '../../support/world'

/**
 * Send a raw HTTP request bypassing the operation map and fixture loader.
 * Stores the response on `world.lastResponse`. Intended for cases that
 * don't fit the op-map model: health probes, SSE endpoints, webhook
 * payloads, raw-body rejection tests, auth-header variations.
 */
export async function rawRequest(
  world: ComponentTestWorld,
  method: string,
  path: string,
  init: { body?: string; contentType?: string; headers?: Record<string, string> } = {},
): Promise<void> {
  const url = `${requireApiBaseUrl(world.config)}${path}`
  const headers: Record<string, string> = { ...(init.headers ?? {}) }
  if (init.contentType) headers['Content-Type'] = init.contentType
  const res = await fetch(url, { method, headers, body: init.body })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  world.lastResponse = { status: res.status, body, headers: responseHeaders }
}

When(
  'I send a {word} request to {string}',
  async function (this: ComponentTestWorld, method: string, path: string) {
    await rawRequest(this, method.toUpperCase(), path)
  },
)

When(
  'I send a {word} request to {string} with header {word} {string}',
  async function (
    this: ComponentTestWorld,
    method: string,
    path: string,
    header: string,
    value: string,
  ) {
    await rawRequest(this, method.toUpperCase(), path, { headers: { [header]: value } })
  },
)

When(
  'I send a {word} request to {string} with body {string}',
  async function (this: ComponentTestWorld, method: string, path: string, body: string) {
    await rawRequest(this, method.toUpperCase(), path, {
      body,
      contentType: 'application/json',
    })
  },
)

When(
  'I POST a {int} KiB body to {string}',
  async function (this: ComponentTestWorld, kib: number, path: string) {
    const payload = 'x'.repeat(kib * 1024)
    await rawRequest(this, 'POST', path, { body: payload, contentType: 'application/json' })
  },
)
