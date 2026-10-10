import { Given, When } from '@cucumber/cucumber'
import { sendOperation, type SendOperationOptions } from '../../support/requests'
import { adoptTokens } from '../../support/auth'
import type { ComponentTestWorld } from '../../support/world'

/** The steps below send through sendOperation; this keeps their call sites short. */
function sendRequest(
  world: ComponentTestWorld,
  requestFile: string,
  operationId: string,
  options: Omit<SendOperationOptions, 'requestFile'> = {},
): Promise<void> {
  return sendOperation(world, operationId, { ...options, requestFile })
}

// --- Step definitions ---

Given(
  'I send the request {word} to the {word} operation',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId)
  },
)

Given(
  'I send the request {word} to the {word} operation with token {word}',
  async function (
    this: ComponentTestWorld,
    requestFile: string,
    operationId: string,
    token: string,
  ) {
    await sendRequest(this, requestFile, operationId, { auth: { token } })
  },
)

Given(
  'I send the request {word} to the {word} operation without authentication',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId, { auth: 'none' })
  },
)

When(
  'I authenticate with the request {word} to the {word} operation',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    await sendRequest(this, requestFile, operationId, { auth: 'none' })
    // Tokens are read from config.auth.tokenPath / refreshTokenPath, which
    // default to access_token / refresh_token.
    if (this.lastResponse && this.lastResponse.status < 300) {
      adoptTokens(this, this.lastResponse.body, { require: false, refresh: 'keep' })
    }
  },
)

When(
  'I send the request {word} to the {word} operation with id from last response',
  async function (this: ComponentTestWorld, requestFile: string, operationId: string) {
    const id = (this.lastResponse?.body as { id?: string } | null | undefined)?.id
    if (!id) {
      throw new Error(
        'No `id` field on last response body — this step needs a prior request that returned one.',
      )
    }
    await sendRequest(this, requestFile, operationId, { pathParams: { id } })
  },
)
