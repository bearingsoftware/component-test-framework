# Container control

`restartContainer`, `stopContainer` and `startContainer` drive a Docker container from a suite, for tests that need a dependency to go down or come back: a database restart, a service that drops off the network. They run the `docker` CLI with no shell, so the container name is checked against `^[A-Za-z0-9][A-Za-z0-9_.-]*$` first.

```typescript
import {
  restartContainer,
  startContainer,
  stopContainer,
} from '@bearingsoftware/component-test-framework/core'

await restartContainer('ctf-db', {
  readiness: { tcp: { host: '127.0.0.1', port: 5432 } },
  timeoutMs: 60_000,
})
```

Readiness is polled every 200 ms until it passes or `timeoutMs` (default 30s) runs out; the error names the container and the check:

- `tcp: { host, port }`: a TCP connection is accepted.
- `http: url`: a GET answers with a status below 400.
- `exec: argv`: `docker exec <name> …argv` exits 0.

`stopContainer` takes no readiness. Docker's own failures are rethrown with the container name and docker's stderr.

## Steps

`registerContainerSteps()` (from `/core`) registers three opt-in steps. They wait for no readiness:

```gherkin
When the "ctf-db" container is restarted
When the "ctf-db" container is stopped
When the "ctf-db" container is started
```

Each step waits up to 2 minutes. To wait for readiness, call the function from your own step.
