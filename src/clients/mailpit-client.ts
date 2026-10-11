import { eventually } from '../support/eventually'

/** A name and address, as Mailpit reports them. */
export interface MailpitAddress {
  Name: string
  Address: string
}

/** One message in a search result: the envelope and a snippet, not the body. */
export interface MailpitMessageSummary {
  ID: string
  MessageID: string
  From: MailpitAddress
  To: MailpitAddress[]
  Cc: MailpitAddress[] | null
  Bcc: MailpitAddress[] | null
  Subject: string
  Created: string
  Snippet: string
}

/** One message, with its body. */
export interface MailpitMessage {
  ID: string
  MessageID: string
  From: MailpitAddress
  To: MailpitAddress[]
  Cc: MailpitAddress[] | null
  Bcc: MailpitAddress[] | null
  ReplyTo: MailpitAddress[] | null
  Subject: string
  Date: string
  Text: string
  HTML: string
}

/** What {@link MailpitClient.waitForMessage} looks for. */
export interface WaitForMessageOptions {
  /** The recipient, matched exactly (ignoring case) against To, Cc and Bcc. */
  to: string
  /** Text the subject must contain. */
  subjectContains?: string
  /** Text the plain-text or HTML body must contain; see {@link emailContains}. */
  bodyContains?: string
  /** How long to wait, in ms. Default 30s. */
  timeoutMs?: number
  /** Pause between searches, in ms. Default 250. */
  intervalMs?: number
}

// Mailpit's own search default is 50; a scenario that has sent more than this
// to one recipient has bigger problems.
const SEARCH_LIMIT = 500
const DEFAULT_TIMEOUT = 30_000
// One API call; a stalled Mailpit fails the step instead of hanging it.
const REQUEST_TIMEOUT = 10_000

/**
 * A client for Mailpit's API (v1): search the messages a service under test
 * sent, read one, wait for one to arrive, and delete them.
 *
 * Mailpit keeps every scenario's mail in one store, so narrow by recipient:
 * give each scenario its own address (`world.uniqueId('owner') +
 * '@example.test'`), which also keeps parallel workers apart.
 */
export class MailpitClient {
  private readonly baseUrl: string

  /** `url` is Mailpit's web/API address, e.g. `http://localhost:8025`. */
  constructor(url: string) {
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /**
   * Messages matching a Mailpit search query (`to:a@b.test subject:"Welcome"`),
   * newest first.
   */
  async search(query: string): Promise<MailpitMessageSummary[]> {
    const params = new URLSearchParams({ query, limit: String(SEARCH_LIMIT) })
    const body = (await this.request('GET', `/api/v1/search?${params}`)) as {
      messages?: MailpitMessageSummary[] | null
    }
    return body.messages ?? []
  }

  /**
   * Messages to `address` in To, Cc or Bcc, newest first. Mailpit's `to:`,
   * `cc:` and `bcc:` searches each look at one field and match part of an
   * address (`to:a@b.test` finds `extra-a@b.test`), so this runs all three
   * and keeps the messages with `address` itself, ignoring case.
   */
  async messagesTo(address: string): Promise<MailpitMessageSummary[]> {
    const wanted = address.toLowerCase()
    const results = await Promise.all(
      ['to', 'cc', 'bcc'].map((field) => this.search(`${field}:${address}`)),
    )
    const byId = new Map(results.flat().map((m) => [m.ID, m]))
    return [...byId.values()]
      .filter((m) =>
        [...(m.To ?? []), ...(m.Cc ?? []), ...(m.Bcc ?? [])].some(
          (a) => a.Address.toLowerCase() === wanted,
        ),
      )
      .sort((a, b) => Date.parse(b.Created) - Date.parse(a.Created))
  }

  /** One message, with its plain-text and HTML bodies. */
  async message(id: string): Promise<MailpitMessage> {
    return (await this.request(
      'GET',
      `/api/v1/message/${encodeURIComponent(id)}`,
    )) as MailpitMessage
  }

  /** One message's headers, each with all its values. */
  async headers(id: string): Promise<Record<string, string[]>> {
    return (await this.request(
      'GET',
      `/api/v1/message/${encodeURIComponent(id)}/headers`,
    )) as Record<string, string[]>
  }

  /**
   * Wait for a message to `to` whose subject and body contain the given text,
   * and return it, newest first if several match. Throws, saying what did
   * arrive for that address, if none does in time.
   */
  async waitForMessage(options: WaitForMessageOptions): Promise<MailpitMessage> {
    const { to, subjectContains, bodyContains } = options
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT
    const wanted = [
      `an email to ${to}`,
      subjectContains !== undefined && `whose subject contains "${subjectContains}"`,
      bodyContains !== undefined && `containing "${bodyContains}"`,
    ]
      .filter(Boolean)
      .join(' ')
    return eventually(
      async () => {
        const all = await this.messagesTo(to)
        const candidates = all.filter(
          (m) => subjectContains === undefined || m.Subject.includes(subjectContains),
        )
        for (const summary of candidates) {
          const message = await this.message(summary.ID)
          if (bodyContains === undefined || emailContains(message, bodyContains)) return message
        }
        throw new Error(
          all.length === 0
            ? `no email to ${to} has arrived`
            : `the emails to ${to} are: ${all.map((m) => JSON.stringify(m.Subject)).join(', ')}`,
        )
      },
      { timeout, interval: options.intervalMs, description: `waiting for ${wanted}` },
    )
  }

  /**
   * Delete messages: those matching a search query, or every message when
   * there's no query. A parallel run must pass a query, since other workers'
   * mail is in the same store.
   */
  async deleteMessages(query?: string): Promise<void> {
    if (query === undefined) {
      await this.request('DELETE', '/api/v1/messages')
      return
    }
    // Searched and deleted by id, a page at a time, which every Mailpit
    // version supports.
    for (;;) {
      const ids = (await this.search(query)).map((m) => m.ID)
      if (ids.length === 0) return
      await this.request('DELETE', '/api/v1/messages', { IDs: ids })
      if (ids.length < SEARCH_LIMIT) return
    }
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      })
    } catch (err) {
      throw new Error(`Mailpit at ${this.baseUrl} can't be reached: ${(err as Error).message}`)
    }
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Mailpit ${method} ${path} failed: HTTP ${res.status} ${text}`.trim())
    }
    if (!text) return undefined
    try {
      return JSON.parse(text)
    } catch {
      // DELETE answers "ok".
      return text
    }
  }
}

/**
 * True when the plain-text body, the HTML, or the HTML's visible text contains
 * `fragment`. The visible text has tags removed, entities decoded and
 * whitespace collapsed, so "Tom & Jerry" matches `Tom &amp;<br> Jerry`.
 */
export function emailContains(message: Pick<MailpitMessage, 'Text' | 'HTML'>, fragment: string) {
  const text = message.Text ?? ''
  const html = message.HTML ?? ''
  return (
    text.includes(fragment) ||
    html.includes(fragment) ||
    visibleText(html).includes(fragment.replace(/\s+/g, ' ').trim())
  )
}

/**
 * The links in a message: `href`s in the HTML, then URLs in the plain text,
 * each once, in order, with HTML entities decoded.
 */
export function emailLinks(message: Pick<MailpitMessage, 'Text' | 'HTML'>): string[] {
  const links: string[] = []
  for (const match of (message.HTML ?? '').matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    links.push(decodeEntities(match[1] ?? match[2]))
  }
  for (const match of (message.Text ?? '').matchAll(/\bhttps?:\/\/[^\s<>"')\]]+/g)) {
    links.push(match[0].replace(/[.,;:!?]+$/, ''))
  }
  return [...new Set(links)]
}

function visibleText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const point =
        code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(point) && point <= 0x10ffff ? String.fromCodePoint(point) : entity
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? entity
  })
}
