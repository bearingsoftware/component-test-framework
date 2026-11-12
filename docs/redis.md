# Valkey / Redis

`registerRedisSteps(options?)` adds steps for keys and pub/sub. They need `redisUrl`. The Redis client and step tests run in CI against both Redis 7 and Valkey 8 (`valkey/valkey:8-alpine`).

**Keys:**

| Step | Description |
|---|---|
| `When I wait for the Valkey key {string} to be set` | Poll until the key exists |
| `Then the Valkey key {string} exists` / `does not exist` | Check once |
| `Then the Valkey key {string} contains JSON matching {string}` | Partially match the value's JSON, once |
| `Then the Valkey key {string} eventually contains JSON matching {string}` (or `…matching:` with a doc string) | Poll until the value's JSON partially matches |

**Pub/sub:**

| Step | Description |
|---|---|
| `When I subscribe to Valkey channel {string}` | Subscribe, and keep the subscription for later steps |
| `When I subscribe to Valkey pattern {string}` | The same with a glob pattern (PSUBSCRIBE), such as `events:user:*` |
| `Then I receive a message on the subscribed Valkey channel` (or `pattern`) | The next message |
| `Then I receive a message with type {string} on the subscribed Valkey channel` (or `pattern`) | The next message whose JSON has that `type` |
| `Then I receive a message on the subscribed Valkey channel matching JSON {string}` (or `…JSON:` with a doc string) | The next message whose JSON partially matches |
| `Then I receive a message on the subscribed Valkey channel with fields:` | The next message whose JSON has every path and value in the table |
| `Then the last Valkey message matches JSON {string}` | Partially match the message last received |
| `When I wait for a message on Valkey channel {string}` | Subscribe, wait for one message, then unsubscribe |
| `When I publish {string} to Valkey channel {string}` (or `…channel {string}:` with a doc string) | Publish |
| `When I publish {string} to Valkey channel {string} until a subscriber hears it` | Publish every 500ms until at least one subscriber receives it |

Subscribing in its own step, before the step that causes the message, means the message can't be missed. The waits skip messages that don't match, and those messages are gone, so a later step doesn't see them.

Pass the suite's options to set how long the waiting steps wait: `registerRedisSteps(options)`, the same object you give `registerHooks`. They wait for `serviceWaitTimeout`, which defaults to 30s, and each step's Cucumber timeout is 1s longer. That way a suite left on Cucumber's 5s default still gets the step's own message, not "function timed out".

Only the first registration's options count. Importing the package root registers the steps with the defaults, so a suite that imports the root and wants a different wait should use the `/core` entry point. Without options, a `serviceWaitTimeout` in the config still applies, but only up to 30s.

When a wait times out, it says how many messages arrived that didn't match, and shows the last. "Partially" means what it does for the response steps: fields the expectation leaves out are ignored, and `null` matches any value.

A table row is a path and a value:

```gherkin
When I subscribe to Valkey pattern "events:user:*"
And I send the request orders/create to the createOrder operation
Then I receive a message on the subscribed Valkey pattern with fields:
  | type          | "order.created" |
  | order.total   | 42              |
  | items[0].sku  | ABC-1           |
```

A value that parses as JSON (`42`, `true`, `"text"`, `{…}`) is compared as JSON. Anything else is compared as text.

The subscriptions a scenario's steps open stay open until the scenario ends, so one subscription can receive several messages. The After hook closes them all.

Publishing until a subscriber hears it can deliver the message more than once. Use it only when the subscriber tolerates repeats.

From code, `this.redis` is the `RedisClient`:
- `subscribe(...channels)` and `psubscribe(...patterns)` return a subscription. Its `waitForMessage(timeoutMs?)` or `waitForMessage(predicate, timeoutMs?)` resolves to `{ channel, message, pattern? }`.
- `publish(channel, message)` returns how many subscribers received the message.
- `publishUntilHeard(channel, message, { timeoutMs, intervalMs, until })` keeps publishing until the message is heard and `until()` holds.
- `waitForValue(key, expected, { timeoutMs, intervalMs })` takes one of three things:
  - a string, matched exactly;
  - a function, which returns false or throws while the value doesn't match;
  - anything else, which the value's JSON is partially matched against.

**Parallel runs:** `workerIsolation.redis` gives each worker its own database, but pub/sub channels belong to the whole server, whatever the database. Two workers publishing to `events` see each other's messages. Give each scenario its own channel names, for example by building them from an id the scenario created, or from `this.uniqueId('channel')` in your own steps.
