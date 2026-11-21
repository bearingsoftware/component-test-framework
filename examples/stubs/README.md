# examples/stubs

Capture servers for a service that sends events somewhere. `support/setup.js` starts an HTTP collector and a UDP syslog sink on free ports, resets them before each scenario and registers the stub steps. The scenarios script a one-shot 503, take the collector down and up, and wait for a datagram.

It needs nothing running. Run it from the repository root:

```sh
npm run examples:test
```

See [Capture stubs](../../docs/stubs.md) for the API and the matching syntax.
