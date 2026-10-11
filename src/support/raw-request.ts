import { requireApiBaseUrl } from './config'
import type { ComponentTestWorld } from './world'

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
