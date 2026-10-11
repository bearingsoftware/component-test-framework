import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import * as http from 'http'
import type { AddressInfo } from 'net'
import { MailpitClient, emailContains, emailLinks, type MailpitMessage } from './mailpit-client'

interface Recorded {
  method: string
  url: string
  body: unknown
}

const address = (Address: string) => ({ Name: '', Address })

function mail(id: string, to: string, subject: string, body: Partial<MailpitMessage> = {}) {
  return {
    ID: id,
    MessageID: `${id}@test`,
    From: address('noreply@service.test'),
    To: [address(to)],
    Cc: null,
    Bcc: null,
    ReplyTo: null,
    Subject: subject,
    Date: '2026-10-11T00:00:00Z',
    // Later ids arrived later.
    Created: new Date(Date.UTC(2026, 9, 11, 0, 0, Number(id) || 0)).toISOString(),
    Snippet: '',
    Text: '',
    HTML: '',
    ...body,
  }
}

// A stand-in for Mailpit's API. `to:`, `cc:` and `bcc:` each match part of
// an address in their own field, ignoring case, as Mailpit's do, so the
// client's merging and exact narrowing are exercised.
describe('MailpitClient (COMPONENT-16)', () => {
  let server: http.Server
  let baseUrl: string
  let recorded: Recorded[]
  let store: ReturnType<typeof mail>[]

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const url = new URL(req.url ?? '', 'http://mailpit.test')
        const body = raw ? JSON.parse(raw) : null
        recorded.push({ method: req.method ?? '', url: req.url ?? '', body })
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(value))
        }
        if (req.method === 'GET' && url.pathname === '/api/v1/search') {
          const query = url.searchParams.get('query') ?? ''
          const [, field, value] = /^(to|cc|bcc):(\S+)/.exec(query) ?? []
          const fields = { to: 'To', cc: 'Cc', bcc: 'Bcc' } as const
          const messages = store
            .filter(
              (m) =>
                !field ||
                (m[fields[field as keyof typeof fields]] ?? []).some((a) =>
                  a.Address.toLowerCase().includes(value.toLowerCase()),
                ),
            )
            .slice()
            .reverse()
          return json(200, { messages, messages_count: messages.length })
        }
        const one = /^\/api\/v1\/message\/([^/]+)(\/headers)?$/.exec(url.pathname)
        if (req.method === 'GET' && one) {
          const found = store.find((m) => m.ID === decodeURIComponent(one[1]))
          if (!found) return json(404, { error: 'not found' })
          return json(200, one[2] ? { Subject: [found.Subject] } : found)
        }
        if (req.method === 'DELETE' && url.pathname === '/api/v1/messages') {
          const ids: string[] | undefined = body?.IDs
          store = ids ? store.filter((m) => !ids.includes(m.ID)) : []
          res.writeHead(200, { 'Content-Type': 'text/plain' })
          return res.end('ok')
        }
        json(500, { error: `unexpected ${req.method} ${req.url}` })
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    recorded = []
    store = []
  })

  it('searches with the query, and a limit above the default', async () => {
    store.push(mail('1', 'a@x.test', 'Hello'))
    const found = await new MailpitClient(`${baseUrl}/`).search('subject:Hello')
    expect(found.map((m) => m.ID)).toEqual(['1'])
    const url = new URL(recorded[0].url, 'http://mailpit.test')
    expect(url.searchParams.get('query')).toBe('subject:Hello')
    expect(Number(url.searchParams.get('limit'))).toBeGreaterThan(50)
  })

  it('narrows messagesTo to the exact address, ignoring case', async () => {
    store.push(mail('1', 'owner@x.test', 'Mine'))
    store.push(mail('2', 'co-owner@x.test', 'Not mine'))
    store.push(mail('3', 'OWNER@x.test', 'Mine too'))
    store.push({ ...mail('4', 'someone@x.test', 'Copied'), Cc: [address('owner@x.test')] })
    store.push({ ...mail('5', 'someone@x.test', 'Blind'), Bcc: [address('owner@x.test')] })
    const found = await new MailpitClient(baseUrl).messagesTo('owner@x.test')
    expect(found.map((m) => m.ID)).toEqual(['5', '4', '3', '1'])
  })

  it('reads a message and its headers', async () => {
    store.push(mail('a/b', 'owner@x.test', 'Hi', { Text: 'body' }))
    const client = new MailpitClient(baseUrl)
    expect((await client.message('a/b')).Text).toBe('body')
    expect(await client.headers('a/b')).toEqual({ Subject: ['Hi'] })
    expect(recorded[0].url).toBe('/api/v1/message/a%2Fb')
  })

  it('waits for a message whose subject and body match, newest first', async () => {
    const client = new MailpitClient(baseUrl)
    setTimeout(() => {
      store.push(mail('1', 'owner@x.test', 'Your code', { Text: 'code 111' }))
      store.push(mail('2', 'owner@x.test', 'Your code', { Text: 'code 222' }))
      store.push(mail('3', 'owner@x.test', 'Welcome', { Text: 'code 333' }))
    }, 100)
    const message = await client.waitForMessage({
      to: 'owner@x.test',
      subjectContains: 'code',
      bodyContains: 'code',
      timeoutMs: 2_000,
      intervalMs: 20,
    })
    expect(message.ID).toBe('2')
  })

  it('says what did arrive when the wait times out', async () => {
    store.push(mail('1', 'owner@x.test', 'Welcome'))
    await expect(
      new MailpitClient(baseUrl).waitForMessage({
        to: 'owner@x.test',
        subjectContains: 'Reset',
        timeoutMs: 100,
        intervalMs: 20,
      }),
    ).rejects.toThrow(
      /waiting for an email to owner@x.test whose subject contains "Reset" \(timed out after 100ms\): the emails to owner@x.test are: "Welcome"/,
    )
  })

  it('says when nothing has arrived', async () => {
    await expect(
      new MailpitClient(baseUrl).waitForMessage({ to: 'nobody@x.test', timeoutMs: 50 }),
    ).rejects.toThrow(/no email to nobody@x.test has arrived/)
  })

  it('deletes everything without a query, and only the matches with one', async () => {
    const client = new MailpitClient(baseUrl)
    store.push(mail('1', 'a@x.test', 'A'), mail('2', 'b@x.test', 'B'))
    await client.deleteMessages('to:a@x.test')
    expect(store.map((m) => m.ID)).toEqual(['2'])
    expect(recorded.at(-1)).toMatchObject({ method: 'DELETE', body: { IDs: ['1'] } })

    await client.deleteMessages()
    expect(store).toEqual([])
    expect(recorded.at(-1)).toMatchObject({ method: 'DELETE', body: null })
  })

  it('reports an API error with its status', async () => {
    await expect(new MailpitClient(baseUrl).message('missing')).rejects.toThrow(
      /Mailpit GET \/api\/v1\/message\/missing failed: HTTP 404/,
    )
  })

  it('reports a Mailpit that is not there', async () => {
    await expect(new MailpitClient('http://127.0.0.1:1').search('')).rejects.toThrow(
      /Mailpit at http:\/\/127.0.0.1:1 can't be reached/,
    )
  })
})

describe('emailContains', () => {
  it('matches the text, the HTML, or the HTML as it reads', () => {
    const message = { Text: 'plain words', HTML: '<p>Tom &amp;<br>\n  <b>Jerry</b></p>' }
    expect(emailContains(message, 'plain')).toBe(true)
    expect(emailContains(message, '<b>Jerry')).toBe(true)
    expect(emailContains(message, 'Tom & Jerry')).toBe(true)
    expect(emailContains(message, 'Spike')).toBe(false)
  })

  it('reads block tags as breaks and inline tags as joined', () => {
    const blocks = { Text: '', HTML: '<p>Hello</p><p>World</p>' }
    expect(emailContains(blocks, 'Hello World')).toBe(true)
    const cells = { Text: '', HTML: '<table><tr><td>Total</td><td>£5</td></tr></table>' }
    expect(emailContains(cells, 'Total £5')).toBe(true)
    const inline = { Text: '', HTML: '<p>Tom &amp;<b> Jerry</b>, <span>re</span><i>set</i></p>' }
    expect(emailContains(inline, 'Tom & Jerry, reset')).toBe(true)
  })

  it("ignores scripts and styles in the HTML's text", () => {
    const message = { Text: '', HTML: '<style>p { color: red }</style><p>Hi</p>' }
    expect(emailContains(message, 'color')).toBe(true) // in the raw HTML
    expect(emailContains(message, 'red } Hi')).toBe(false)
  })
})

describe('emailLinks', () => {
  it('finds hrefs, decoded, then URLs in the text, each once', () => {
    const links = emailLinks({
      HTML: `<a href="https://app.test/verify?a=1&amp;b=2">Verify</a> <a href='/relative'>x</a>`,
      Text: 'Verify: https://app.test/verify?a=1&b=2.\nOr (https://app.test/other)',
    })
    expect(links).toEqual([
      'https://app.test/verify?a=1&b=2',
      '/relative',
      'https://app.test/other',
    ])
  })
})
