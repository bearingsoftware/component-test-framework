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
export class StopRetrying extends Error {
  override name = 'StopRetrying'
}

/**
 * True for a {@link StopRetrying}, including one from another installed copy
 * of this package, where `instanceof` would say no.
 */
export function isStopRetrying(err: unknown): boolean {
  return err instanceof Error && err.name === 'StopRetrying'
}

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
      if (isStopRetrying(err)) {
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
 * "waiting for rows (timed out after 300ms): got 1". The error itself is kept,
 * so its class survives (a StopRetrying still stops an outer wait) and so do
 * an AssertionError's actual and expected values.
 */
function withContext(err: unknown, description?: string, outcome?: string): Error {
  const context = [description, outcome && (description ? `(${outcome})` : outcome)]
    .filter(Boolean)
    .join(' ')
  if (!(err instanceof Error))
    return new Error(context ? `${context}: ${String(err)}` : String(err))
  if (!context) return err
  const original = err.message
  err.message = `${context}: ${original}`
  if (err.stack?.includes(original)) err.stack = err.stack.replace(original, err.message)
  return err
}

/**
 * Cucumber's own default step timeout. Waits default to just under this, so
 * a failed wait reports what it was waiting for instead of Cucumber's generic
 * "function timed out".
 */
const CUCUMBER_DEFAULT_TIMEOUT = 5_000
const HEADROOM = 1_000

/**
 * How long UI and assertion waits poll before failing. In order: the
 * explicit `waitTimeout`, 1s less than `defaultStepTimeout`, or just under
 * Cucumber's 5s default. Waits for background work use
 * {@link serviceWaitTimeout} instead.
 */
export function waitTimeout(config: { waitTimeout?: number; defaultStepTimeout?: number }): number {
  if (config.waitTimeout !== undefined) return atLeastOneMs(config.waitTimeout)
  if (config.defaultStepTimeout !== undefined) {
    return atLeastOneMs(config.defaultStepTimeout - HEADROOM)
  }
  return CUCUMBER_DEFAULT_TIMEOUT - HEADROOM
}

/** How long the DB record waits have always polled. */
const SERVICE_WAIT_DEFAULT = 30_000

/**
 * How long waits for background work poll before failing: a worker writing
 * rows, or a service calling a stubbed API. `serviceWaitTimeout` if set,
 * otherwise 30s, which the DB record waits have always used.
 */
export function serviceWaitTimeout(config: { serviceWaitTimeout?: number }): number {
  return atLeastOneMs(config.serviceWaitTimeout ?? SERVICE_WAIT_DEFAULT)
}

// Playwright treats a timeout of 0 as "wait forever", so a wait is never
// shorter than 1ms.
const atLeastOneMs = (ms: number) => Math.max(ms, 1)
