/* eslint-disable @typescript-eslint/no-require-imports */
// Registration functions for the built-in step groups. Each loads its step
// module, which registers the steps with Cucumber as it loads. Node loads a
// module once, so calling one twice, or after importing the package root
// (which registers every group), registers nothing more.
//
// The `core` entry point exposes these instead of registering everything on
// import, so a suite registers only the steps it uses.

import type { RedisStepOptions } from './common/redis.steps'

/** `I send the request … to the … operation` and its variants. */
export function registerApiSteps(): void {
  require('./api/generic-api.steps')
}

/** `I send a GET request to …` and other raw requests. */
export function registerRawApiSteps(): void {
  require('./api/raw-api.steps')
}

/** Server-sent events: `I connect to the SSE endpoint …`. */
export function registerSseSteps(): void {
  require('./api/sse.steps')
}

/** `the response status should be …`, body and header assertions. */
export function registerResponseSteps(): void {
  require('./common/response-assertion.steps')
}

/** WireMock stubbing and call counts. */
export function registerWiremockSteps(): void {
  require('./common/wiremock.steps')
}

/** `the … table contains … row(s) matching …`. */
export function registerDbSteps(): void {
  require('./common/db-assertion.steps')
}

/**
 * Valkey / Redis keys and pub/sub. Pass the suite's `serviceWaitTimeout` to
 * set how long the waiting steps wait, and their Cucumber timeout. Only the
 * first call's options count.
 */
export function registerRedisSteps(options: RedisStepOptions = {}): void {
  ;(require('./common/redis.steps') as typeof import('./common/redis.steps')).defineRedisSteps(
    options,
  )
}

/** Service calls, call counts, the database record waits and the WireMock scenario move that waits for a row. */
export function registerServiceSteps(): void {
  require('./worker/generic-service.steps')
}

/** Playwright UI steps: navigate, click, fill, see. */
export function registerUiSteps(): void {
  require('./ui/generic-ui.steps')
}
