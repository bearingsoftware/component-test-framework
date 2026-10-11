import { test, expect } from './fixtures'

// Each test stubs the same path with its own price. With two workers running
// at once, a test only sees its own price if each worker's stubs are kept
// apart on the shared WireMock, and reset between tests.
for (let i = 0; i < 8; i++) {
  const price = 100 + i
  test(`the shop shows this test's price ${price}, served by this worker`, async ({
    page,
    stubs,
    wiremock,
  }, info) => {
    await stubs.add({
      request: { method: 'GET', urlPath: '/pricing/prices/WIDGET' },
      response: { status: 200, jsonBody: { price } },
    })
    await page.goto('/')
    await expect(page.locator('#price')).toHaveText(String(price))
    await expect(page.locator('#worker')).toHaveText(String(info.parallelIndex))
    expect(await wiremock.getRequestCount('/pricing/prices/WIDGET')).toBe(1)
  })
}

test('stubs load from a directory of mappings', async ({ page, stubs }) => {
  await stubs.load('pricing')
  await page.goto('/')
  await expect(page.locator('#price')).toHaveText('7')
})

test('a login goes through the SPA server, and its token can be put in the page', async ({
  page,
  stubs,
  auth,
}) => {
  await stubs.load('login.json')
  const tokens = await auth.login('owner@example.com', 'Sup3rSecret!')
  expect(tokens.refreshToken).toBe('refresh-1')
  expect(auth.claims()).toMatchObject({ sub: 'owner@example.com', role: 'owner' })
  expect(auth.headers().Authorization).toBe(`Bearer ${tokens.accessToken}`)

  await auth.storeInLocalStorage(page, 'session')
  await page.goto('/')
  expect(await page.evaluate(() => localStorage.getItem('session'))).toBe(tokens.accessToken)
})

test('a failed login says why', async ({ auth }) => {
  await expect(auth.login('nobody@example.com', 'wrong')).rejects.toThrow(
    /login as nobody@example.com failed: 404/,
  )
})

test('tokens can be forged for tests that need a foreign or expired one', async ({ auth }) => {
  const token = auth.sign({ sub: 'mallory', exp: 0 }, 'not-the-real-secret')
  expect(auth.claims(token)).toEqual({ sub: 'mallory', exp: 0 })
})

test('nothing has loaded Cucumber', async () => {
  const loaded = Object.keys(require.cache).filter((file) => file.includes('/@cucumber/'))
  expect(loaded).toEqual([])
})
