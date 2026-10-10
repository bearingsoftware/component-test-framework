/**
 * Polling helpers for asserting on things that settle asynchronously: a
 * background worker writing a row, an SPA rendering after a fetch, a service
 * calling a stubbed dependency.
 *
 * Both take a `check` that throws (for example with `assert`) while the
 * condition doesn't hold, so the last failure message is what the step
 * reports.
 */

export interface EventuallyOptions {
  /** How long to keep retrying, in ms. */
  timeout: number
  /** Pause between attempts, in ms. Default 250. */
  interval?: number
  /** Prefix for the timeout error, e.g. "waiting for 2 rows in jobs". */
  description?: string
}

export interface HoldsForOptions {
  /** How long the check must keep passing, in ms. */
  duration: number
  /** Pause between attempts, in ms. Default 250. */
  interval?: number
  /** Prefix for the failure error. */
  description?: string
}

/**
 * Thrown by a check to stop {@link eventually} retrying: the condition can no
 * longer become true, so waiting out the timeout would only delay the failure.
 */
export class StopRetrying extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Run `check` until it returns without throwing, and return its result. If it
 * still throws when `timeout` runs out, throw its last error, prefixed with
 * the description and how long was waited. The last attempt is made at the
 * deadline, even when that's sooner than `interval`. A check that throws
 * {@link StopRetrying} fails at once.
 */
export async function eventually<T>(
  check: () => T | Promise<T>,
  options: EventuallyOptions,
): Promise<T> {
  const interval = options.interval ?? 250
  const deadline = Date.now() + options.timeout
  for (;;) {
    try {
      return await check()
    } catch (err) {
      if (err instanceof StopRetrying) {
        throw withContext(err, options.description)
      }
      if (Date.now() >= deadline) {
        throw withContext(err, options.description, `timed out after ${options.timeout}ms`)
      }
    }
    await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)))
  }
}

/**
 * Run `check` repeatedly for `duration` and fail as soon as it throws. Use it
 * for "nothing else happens" assertions, such as no further requests within
 * a window.
 */
export async function holdsFor(
  check: () => unknown | Promise<unknown>,
  options: HoldsForOptions,
): Promise<void> {
  const interval = options.interval ?? 250
  const started = Date.now()
  const deadline = started + options.duration
  for (;;) {
    try {
      await check()
    } catch (err) {
      throw withContext(err, options.description, `changed after ${Date.now() - started}ms`)
    }
    if (Date.now() >= deadline) return
    await sleep(Math.min(interval, deadline - Date.now()))
  }
}

/**
 * Prefix an error with what was being checked and how it ended, e.g.
 * "waiting for rows (timed out after 300ms): got 1".
 */
function withContext(err: unknown, description?: string, outcome?: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const context = [description, outcome && (description ? `(${outcome})` : outcome)]
    .filter(Boolean)
    .join(' ')
  const wrapped = new Error(context ? `${context}: ${message}` : message)
  if (err instanceof Error) wrapped.stack = `${wrapped.message}\n${err.stack ?? ''}`
  return wrapped
}

/**
 * Cucumber's own default step timeout. Waits default to just under this, so
 * a failed wait reports what it was waiting for instead of Cucumber's generic
 * "function timed out".
 */
const CUCUMBER_DEFAULT_TIMEOUT = 5_000
const HEADROOM = 1_000

/**
 * How long a waiting step polls before failing. In order: the explicit
 * `waitTimeout`, 1s less than `defaultStepTimeout`, or `fallback`. Steps that
 * have always waited (such as the DB record waits) pass their historical 30s
 * as the fallback; steps that used to check once fall back to just under
 * Cucumber's 5s default.
 */
export function waitTimeout(
  config: { waitTimeout?: number; defaultStepTimeout?: number },
  fallback = CUCUMBER_DEFAULT_TIMEOUT - HEADROOM,
): number {
  if (config.waitTimeout !== undefined) return config.waitTimeout
  if (config.defaultStepTimeout !== undefined) {
    return Math.max(config.defaultStepTimeout - HEADROOM, 0)
  }
  return fallback
}
