# examples/spa

A static page (`web/index.html`) that fetches `/api/greeting` and shows the answer. The SPA server serves `web/` and forwards `/api/*` to WireMock, so the scenario decides what the page sees.

- `support/setup.js` registers the SPA server, a page object, the UI and waiting steps, and the WireMock steps.
- `features/greeting.feature` is tagged `@ui`, so it runs in Chromium (`npx playwright install chromium`).

Run it from the repository root with WireMock up (the image is in `.github/workflows/ci.yml`):

```sh
npm run examples:test
```

It reads `WIREMOCK_URL` and `WEB_PORT`. See [Testing a single-page app](../../docs/spa.md) and [UI steps](../../docs/ui-playwright.md).
