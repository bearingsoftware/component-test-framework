# Capture stubs

A service that sends events to a SIEM, a webhook receiver or a syslog host needs something to receive them. `startCaptureServer` from `@bearingsoftware/component-test-framework/stubs` starts one in the test process: it records every request, answers as scripted, and can be taken down and brought back. Nothing registers on import.

```typescript
import { startCaptureServer } from '@bearingsoftware/component-test-framework/stubs'

const hec = await startCaptureServer({ kind: 'https', tls: 'self-signed', portEnv: 'HEC_PORT' })
// give the service hec.url, and hec.ca to trust
hec.script({ match: { path: '/services/collector/event' }, respond: [503, 503, 200] })
// ... exercise the service ...
const sent = hec.requests({ path: '/services/collector/event' })
await hec.stop()
```

## Options

| Option | Meaning |
|---|---|
| `kind` | `'http'`, `'https'`, `'tcp'` or `'udp'` |
| `port` | The port to listen on. `0` or unset picks a free one; read it back from `server.port` |
| `portEnv` | The name of an environment variable holding the port. It wins over `port` when set |
| `tls` | `https` only: `{ cert, key }` as PEM, or `'self-signed'`, which makes a throwaway certificate with the `openssl` binary and exposes it as `server.ca` |

It listens on `127.0.0.1`. Under [`workerIsolation`](parallel.md) pass `port: workerPort(base)`, or leave the port unset.

## The server

| Member | Meaning |
|---|---|
| `url`, `port` | Where it listens: `http://127.0.0.1:port`, `https://…`, `tcp://…`, `udp://…` |
| `requests(filter?)` | The recorded requests, oldest first, narrowed by a [match](#matching) object |
| `reset()` | Forget the recorded requests and the scripted rules |
| `script(rule)` | http and https: answer matching requests. See below |
| `down()` / `up()` | Stop accepting connections, keeping the port; listen again on the same port |
| `stop()` | Close everything, and remove the certificate files |

A recorded request is `{ at, method?, path?, query?, headers?, body: Buffer, text, json? }`. `json` is set when the content type says JSON and the body parses. Header names are lower case. A tcp or udp record has `at`, `body` and `text` only: each `data` chunk of a tcp connection and each datagram is one record, so a sender that splits messages across writes is seen in pieces.

## Scripting

`script({ match?, respond, once? })` adds a rule. The first rule that matches the request and still has answers left decides the reply; with none, the answer is `200` (http and https). tcp and udp servers accept and never reply, and `script` on them throws.

- `respond: 503` answers every match with 503.
- `respond: [503, 503, 200]` answers matches in that order. Only matching requests use up the list; once it is spent the rule stops applying.
- `respond: [{ status: 429, body: '{"retry":1}', headers: { 'retry-after': '1' } }]` sets a body and headers.
- `once: true` answers one matching request, then the rule is spent.

## Matching

`{ path?, method?, query?, header?, bodyIncludes? }`: every field given must hold. `path` is the exact path without the query string, `method` ignores case, `query` and `header` compare values exactly (header names ignore case) and `bodyIncludes` looks in the text. A field a tcp or udp record lacks (`path`, `method`, `query`, `header`) never matches.

The steps take the same thing as a string, `;`-separated terms:

| Term | Matches |
|---|---|
| `path=/events` | The path |
| `method=POST` | The method |
| `query.NAME=value` | A query parameter |
| `header.NAME=value` | A request header |
| `body~text` | The body contains `text`. It takes the rest of the string, so put it last; it may contain `;` |

An empty string matches every request. `parseMatch(spec)` turns a string into the object.

## Steps

Opt-in. Name the servers; a value can be a function, for a server started in a hook:

```typescript
import { registerStubSteps } from '@bearingsoftware/component-test-framework/stubs'

registerStubSteps({ siem: () => siem, syslog }, { stubWaitTimeout: 10_000 })
```

| Step | Description |
|---|---|
| `Given the {word} stub answers {int} for requests matching {string}` | Every match gets that status |
| `Given the {word} stub answers {int} once for requests matching {string}` | The next match only |
| `Then the {word} stub saw {int} request(s) matching {string}` | Exactly that many so far |
| `Then I wait for the {word} stub to see {int} request(s) matching {string}` | At least that many, within `stubWaitTimeout` (10s by default) |
| `When the {word} stub is down` / `is up` | `down()` and `up()` |

Calling `registerStubSteps` again adds servers to the same steps. Servers keep their requests and rules across scenarios, so call `reset()` in a `Before` hook, or match on something unique to the scenario. The [`examples/stubs`](../examples/stubs/README.md) suite shows the setup.
