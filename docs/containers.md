# Container control

> **Warning:** these functions stop, start and restart real Docker containers. Suites must only target containers they created, and should use a unique name prefix (for example `myrepo-ct-`) so they never touch a container someone else runs.

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
- `http: url`: a GET answers with a 2xx status. A redirect (for example a login page) is not ready.
- `exec: argv`: `docker exec <name> …argv` exits 0.

Each readiness probe is capped at 1 s and at the time left before `timeoutMs`; a hung `docker exec` counts as not ready. Each docker call gets `timeoutMs` (30s for `stopContainer`, which takes no options) and fails with a timeout error if it doesn't return. Docker's own failures are rethrown with the container name and docker's stderr. A `readiness` with no kind set, or `exec: []`, is rejected before docker runs.

## Steps

`registerContainerSteps()` (from `/core`) registers three opt-in steps. They wait for no readiness:

```gherkin
When the "ctf-db" container is restarted
When the "ctf-db" container is stopped
When the "ctf-db" container is started
```

Each step waits up to 2 minutes. To wait for readiness, call the function from your own step.
