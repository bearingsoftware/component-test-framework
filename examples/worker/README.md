# examples/worker

A background worker (`service/worker.js`) with no API. It takes jobs from the Redis channel `jobs`, writes a row in Postgres and leaves the result under the key `job:<id>`.

- `support/setup.js` starts the worker, leaves WireMock and the API out of `registerHooks`, and registers the database and Redis steps.
- `features/jobs.feature` publishes a job, then waits for the row and the key. The table is cleaned and Redis flushed after every scenario.

Run it from the repository root with Postgres and Redis up (the images are in `.github/workflows/ci.yml`):

```sh
npm run examples:test
```

It reads `DATABASE_URL`, `REDIS_URL` and `EXAMPLE_WORKER_PORT`. See [Valkey / Redis](../../docs/redis.md) and [Postgres](../../docs/postgres.md) for the steps.
