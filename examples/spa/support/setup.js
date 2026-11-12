// A static SPA, the SPA server and WireMock. The server serves web/ and
// forwards /api/* to WireMock, so each scenario decides what the page sees.
const path = require('path')
const core = require('../../../dist/core')
const { BasePage, registerUiSteps } = require('../../../dist/playwright')
const { registerWiremockSteps } = require('../../../dist/wiremock')
const { registerSpaServer } = require('../../../dist/spa')

const SUITE = path.resolve(__dirname, '..')
const WIREMOCK_URL = process.env.WIREMOCK_URL ?? 'http://localhost:58443'

class HomePage extends BasePage {
  get url() {
    return '/'
  }
}

// The port comes from WEB_PORT.
const spa = registerSpaServer({
  distDir: path.join(SUITE, 'web'),
  apiUrl: WIREMOCK_URL,
  defaultPort: 3100,
})

const options = {
  ...core.loadConfig(),
  wiremockUrl: WIREMOCK_URL,
  apiBaseUrl: undefined,
  webBaseUrl: spa.baseUrl,
  fixturesDir: path.join(SUITE, 'fixtures'),
  pages: { home: HomePage },
  defaultStepTimeout: 30_000,
}
core.registerHooks(options)

registerWiremockSteps()
registerUiSteps()
core.registerWaitingSteps(options)
