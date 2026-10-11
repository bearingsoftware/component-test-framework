import { describe, it, expect, beforeAll } from 'vitest'
import * as net from 'net'
import { MailpitClient, emailLinks } from './mailpit-client'

// Against a real Mailpit, which CI runs as a service. Skipped without
// MAILPIT_URL (the API) and MAILPIT_SMTP (host:port of its SMTP server).
const apiUrl = process.env.MAILPIT_URL
const smtp = process.env.MAILPIT_SMTP

/** Send one message over plain SMTP: enough of the protocol for Mailpit. */
async function sendMail(options: {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  html?: string
  text?: string
}): Promise<void> {
  const [host, port] = (smtp as string).split(':')
  const socket = net.connect(Number(port), host)
  socket.setEncoding('utf-8')
  let buffer = ''
  const replies: string[] = []
  const waiters: ((line: string) => void)[] = []
  socket.on('data', (chunk: string) => {
    buffer += chunk
    // A reply ends with a line whose code is followed by a space.
    let match: RegExpExecArray | null
    while ((match = /^(\d{3}) .*\r\n/m.exec(buffer))) {
      const end = match.index + match[0].length
      const reply = buffer.slice(0, end)
      buffer = buffer.slice(end)
      const waiter = waiters.shift()
      if (waiter) waiter(reply)
      else replies.push(reply)
    }
  })
  const reply = () =>
    new Promise<string>((resolve) =>
      replies.length > 0 ? resolve(replies.shift() as string) : waiters.push(resolve),
    )
  const command = async (line: string, expected: string) => {
    const pending = reply()
    socket.write(`${line}\r\n`)
    const got = await pending
    if (!got.startsWith(expected)) throw new Error(`SMTP ${line}: ${got}`)
  }
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  const greeting = await reply()
  if (!greeting.startsWith('220')) throw new Error(`SMTP greeting: ${greeting}`)
  await command('HELO ctf.test', '250')
  await command(`MAIL FROM:<${options.from}>`, '250')
  for (const to of [...options.to, ...(options.cc ?? [])]) await command(`RCPT TO:<${to}>`, '250')
  await command('DATA', '354')
  const boundary = 'ctf-boundary'
  const message = [
    `From: <${options.from}>`,
    `To: ${options.to.map((t) => `<${t}>`).join(', ')}`,
    ...(options.cc ? [`Cc: ${options.cc.map((t) => `<${t}>`).join(', ')}`] : []),
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.text ?? '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    options.html ?? '',
    `--${boundary}--`,
  ]
    // A line starting with a dot is escaped by doubling it.
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n')
  await command(`${message}\r\n.`, '250')
  await command('QUIT', '221')
  socket.end()
}

describe.skipIf(!apiUrl || !smtp)('MailpitClient against Mailpit (COMPONENT-16)', () => {
  const client = new MailpitClient(apiUrl ?? '')
  const run = Math.random().toString(36).slice(2, 8)
  const owner = `owner-${run}@example.test`

  beforeAll(async () => {
    await sendMail({
      from: 'noreply@service.test',
      to: [owner],
      subject: `Verify your address ${run}`,
      text: 'Verify: https://app.test/verify?token=abc&u=1',
      html: '<p>Tom &amp; Jerry</p><a href="https://app.test/verify?token=abc&amp;u=1">Verify</a>',
    })
    // Same domain, longer local part: Mailpit's to: search matches it too.
    await sendMail({
      from: 'noreply@service.test',
      to: [`co-${owner}`],
      subject: `Not for the owner ${run}`,
    })
    // Mailpit's to: search doesn't look at Cc.
    await sendMail({
      from: 'noreply@service.test',
      to: [`someone-${run}@example.test`],
      cc: [owner],
      subject: `Copied to the owner ${run}`,
    })
  })

  it('waits for the message, and reads its body and links', async () => {
    const message = await client.waitForMessage({
      to: owner,
      subjectContains: 'Verify',
      bodyContains: 'Tom & Jerry',
      timeoutMs: 10_000,
    })
    expect(message.Subject).toBe(`Verify your address ${run}`)
    expect(message.Text).toContain('https://app.test/verify')
    expect(emailLinks(message)).toContain('https://app.test/verify?token=abc&u=1')
    expect((await client.headers(message.ID)).Subject).toEqual([`Verify your address ${run}`])
  })

  it('finds To and Cc recipients, exactly, ignoring case', async () => {
    await client.waitForMessage({ to: owner, subjectContains: 'Copied', timeoutMs: 10_000 })
    const found = await client.messagesTo(owner.toUpperCase())
    // Sorted, since two messages sent in the same millisecond share a time.
    expect(found.map((m) => m.Subject).sort()).toEqual([
      `Copied to the owner ${run}`,
      `Verify your address ${run}`,
    ])
  })

  it('deletes only the messages a query matches', async () => {
    await client.waitForMessage({ to: `co-${owner}`, timeoutMs: 10_000 })
    await client.deleteMessages(`subject:"Not for the owner ${run}"`)
    expect(await client.messagesTo(`co-${owner}`)).toEqual([])
    expect(await client.messagesTo(owner)).toHaveLength(2)
  })
})
