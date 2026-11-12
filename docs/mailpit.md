# Email: Mailpit

A service that sends email can send it to [Mailpit](https://mailpit.axllent.org), and the steps from `@bearingsoftware/component-test-framework/mailpit` assert on what arrived. They're opt-in:

```typescript
import { registerMailpitSteps } from '@bearingsoftware/component-test-framework/mailpit'

registerMailpitSteps({
  url: process.env.MAILPIT_URL, // the default, falling back to http://localhost:8025
  // A name a step uses, to the address it stands for. Default: the name is the address.
  recipient: (world, name) => (name === 'the owner' ? world.recall<string>('ownerEmail') : name),
})
```

| Step | Description |
|---|---|
| `Then an email to {string} eventually arrives whose subject contains {string}` | Wait for it, up to `serviceWaitTimeout` (30s by default) |
| `Then an email to {string} eventually arrives containing {string}` | The same, by its body |
| `Then that email contains {string}` | The plain-text body, the HTML, or the HTML's visible text contains it |
| `Then that email has a link matching {string}` | A regular expression; the first matching link is kept |
| `Then exactly {int} email(s) arrive(s) for {string} within {int}s` | Counts all mail to that address, so use a recipient unique to the scenario. Fails as soon as one too many arrives |

The email the steps find is kept as `world.recall<MailpitMessage>('lastEmail')` and a matched link as `world.recall<string>('lastEmailLink')`, so a step of your own can follow a magic link. Where several emails match, the newest is used.

Mailpit keeps every scenario's mail, and the steps never clear it, so give each scenario its own recipient, such as `` `${world.uniqueId('owner')}@example.test` ``. That also keeps parallel workers apart. The count in "exactly … arrive" includes every email to that address, not only those arriving during the window. A recipient matches exactly, ignoring case, in To, Cc or Bcc.

`MailpitClient` is the same API for your own steps: `search(query)`, `messagesTo(address)`, `message(id)`, `headers(id)`, `waitForMessage({ to, subjectContains, bodyContains, timeoutMs })` and `deleteMessages(query?)`. Without a query, `deleteMessages` deletes every message, other workers' too.
