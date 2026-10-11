import { Then } from '@cucumber/cucumber'
import type { ComponentTestWorld } from '../support/world'
import { holdsFor, serviceWaitTimeout } from '../support/eventually'
import {
  MailpitClient,
  emailContains,
  emailLinks,
  type MailpitMessage,
} from '../clients/mailpit-client'

/** Options for {@link registerMailpitSteps}. */
export interface MailpitStepOptions {
  /** Mailpit's web/API address. Default `MAILPIT_URL`, or `http://localhost:8025`. */
  url?: string
  /**
   * The address a step's recipient names, e.g. "the owner" to the address the
   * scenario signed up with. Default: the step's text is the address.
   */
  recipient?: (world: ComponentTestWorld, name: string) => string
  /** How long the "eventually arrives" steps wait, in ms. Default 30s. */
  serviceWaitTimeout?: number
}

/** Where the steps keep the email they found, for {@link ComponentTestWorld.recall}. */
export const LAST_EMAIL = 'lastEmail'
/** Where `that email has a link matching …` keeps the link. */
export const LAST_EMAIL_LINK = 'lastEmailLink'

const STEP_HEADROOM = 1_000
// The "exactly N" step watches a window the feature file sets; its own wait
// bounds it, so the Cucumber timeout is off.
const NO_STEP_TIMEOUT = -1

let registered = false

/**
 * Register the Mailpit steps:
 *
 * - `an email to {string} eventually arrives whose subject contains {string}`
 * - `an email to {string} eventually arrives containing {string}`
 * - `that email contains {string}`
 * - `that email has a link matching {string}`
 * - `exactly {int} email(s) arrive(s) for {string} within {int}s`: counts all
 *   mail to that address, including any that arrived before the window, so
 *   use a recipient unique to the scenario
 *
 * The email a step finds is kept as `world.recall<MailpitMessage>('lastEmail')`,
 * and a matched link as `world.recall<string>('lastEmailLink')`. Calling this
 * twice registers nothing more.
 */
export function registerMailpitSteps(options: MailpitStepOptions = {}): void {
  // A second registration would make every one of these steps ambiguous.
  if (registered) return
  registered = true

  const client = new MailpitClient(
    options.url ?? process.env.MAILPIT_URL ?? 'http://localhost:8025',
  )
  const address = (world: ComponentTestWorld, name: string) =>
    options.recipient ? options.recipient(world, name) : name
  const budget = serviceWaitTimeout(options)
  const step = { timeout: budget + STEP_HEADROOM }

  Then(
    'an email to {string} eventually arrives whose subject contains {string}',
    step,
    async function (this: ComponentTestWorld, name: string, subject: string) {
      const message = await client.waitForMessage({
        to: address(this, name),
        subjectContains: subject,
        timeoutMs: budget,
      })
      this.remember(LAST_EMAIL, message)
    },
  )

  Then(
    'an email to {string} eventually arrives containing {string}',
    step,
    async function (this: ComponentTestWorld, name: string, fragment: string) {
      const message = await client.waitForMessage({
        to: address(this, name),
        bodyContains: fragment,
        timeoutMs: budget,
      })
      this.remember(LAST_EMAIL, message)
    },
  )

  Then('that email contains {string}', function (this: ComponentTestWorld, fragment: string) {
    const message = lastEmail(this)
    if (!emailContains(message, fragment)) {
      throw new Error(
        `the email "${message.Subject}" doesn't contain "${fragment}". Its text:\n${message.Text}`,
      )
    }
  })

  Then(
    'that email has a link matching {string}',
    function (this: ComponentTestWorld, pattern: string) {
      const message = lastEmail(this)
      const regex = new RegExp(pattern)
      const links = emailLinks(message)
      const link = links.find((l) => regex.test(l))
      if (!link) {
        throw new Error(
          `the email "${message.Subject}" has no link matching /${pattern}/. ` +
            `Its links: ${links.length ? links.join(', ') : 'none'}`,
        )
      }
      this.remember(LAST_EMAIL_LINK, link)
    },
  )

  /**
   * Counts all mail to that address, including any that arrived before the
   * window, not only arrivals during it, so use a recipient unique to the
   * scenario.
   */
  Then(
    'exactly {int} email(s) arrive(s) for {string} within {int}s',
    { timeout: NO_STEP_TIMEOUT },
    async function (this: ComponentTestWorld, want: number, name: string, seconds: number) {
      const to = address(this, name)
      const count = async () => (await client.messagesTo(to)).length
      // Fails as soon as one too many arrives, rather than at the end.
      await holdsFor(
        async () => {
          const got = await count()
          if (got > want) throw new Error(`${got} emails to ${to} arrived, expected ${want}`)
        },
        { duration: seconds * 1_000, description: `watching the emails to ${to}` },
      )
      const got = await count()
      if (got !== want) throw new Error(`${got} emails to ${to} arrived, expected ${want}`)
    },
  )
}

function lastEmail(world: ComponentTestWorld): MailpitMessage {
  if (!world.values.has(LAST_EMAIL)) {
    throw new Error('No email found yet: use "an email to … eventually arrives …" first')
  }
  return world.recall<MailpitMessage>(LAST_EMAIL)
}
