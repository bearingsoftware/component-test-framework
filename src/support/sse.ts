import { requireApiBaseUrl } from './config'
import type { ComponentTestWorld } from './world'

/**
 * Open an SSE connection and drain until either the first `\n\n`-terminated
 * data frame arrives, or (when `wantKeepalive` is set) a `: keepalive`
 * comment line is observed. Stores the result on `world.lastResponse`:
 *
 * - First-event mode: body is the parsed `data:` payload (JSON if it parses,
 *   otherwise the raw string).
 * - Keepalive mode: body is `{ keepalive: boolean }` depending on whether
 *   the comment appeared before the timeout.
 *
 * If `world.accessToken` is set it is sent as a Bearer token; otherwise the
 * request is unauthenticated. Callers testing auth failures should clear the
 * token before invoking this step.
 */
export async function readSSE(
  world: ComponentTestWorld,
  path: string,
  opts: { timeoutMs: number; wantKeepalive?: boolean },
): Promise<void> {
  const controller = new AbortController()
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  if (world.accessToken) headers.Authorization = `Bearer ${world.accessToken}`
  const res = await fetch(`${requireApiBaseUrl(world.config)}${path}`, {
    method: 'GET',
    headers,
    signal: controller.signal,
  })
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    responseHeaders[key] = value
  })
  const reader = res.body?.getReader()
  if (!reader) {
    controller.abort()
    world.lastResponse = { status: res.status, body: null, headers: responseHeaders }
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + opts.timeoutMs
  while (Date.now() < deadline) {
    if (opts.wantKeepalive) {
      if (buffer.includes(': keepalive')) break
    } else if (buffer.includes('\n\n')) {
      break
    }
    const readResult = await reader.read()
    if (readResult.done) break
    buffer += decoder.decode(readResult.value, { stream: true })
  }
  controller.abort()

  if (opts.wantKeepalive) {
    world.lastResponse = {
      status: res.status,
      body: { keepalive: buffer.includes(': keepalive') },
      headers: responseHeaders,
    }
    return
  }

  const frame = buffer.split('\n\n')[0] ?? ''
  const dataLine = frame
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('data:'))
  const payload = dataLine ? dataLine.slice(5).trim() : ''
  let parsed: unknown = payload
  if (payload) {
    try {
      parsed = JSON.parse(payload)
    } catch {
      parsed = payload
    }
  }
  world.lastResponse = { status: res.status, body: parsed, headers: responseHeaders }
}
