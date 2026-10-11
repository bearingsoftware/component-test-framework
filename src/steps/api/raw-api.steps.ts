import { When } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '../../support/world'
import { rawRequest } from '../../support/raw-request'

// Re-exported for anyone importing it from here.
export { rawRequest }

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
