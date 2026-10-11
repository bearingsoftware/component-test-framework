// `@bearingsoftware/component-test-framework/mailpit`: the Mailpit client and
// its opt-in email steps. Registers nothing on import.
export { MailpitClient, emailContains, emailLinks } from './clients/mailpit-client'
export type {
  MailpitAddress,
  MailpitMessage,
  MailpitMessageSummary,
  WaitForMessageOptions,
} from './clients/mailpit-client'
export { registerMailpitSteps, LAST_EMAIL, LAST_EMAIL_LINK } from './steps/mailpit.steps'
export type { MailpitStepOptions } from './steps/mailpit.steps'
