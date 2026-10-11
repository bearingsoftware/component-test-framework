/** One pub/sub message, as a subscription receives it. */
export interface PubSubMessage {
  /** The channel it was published to. */
  channel: string
  /** The message as published. */
  message: string
  /** The pattern that matched the channel, for a pattern subscription. */
  pattern?: string
}

/** Chooses which messages a wait returns. */
export type MessagePredicate = (message: PubSubMessage) => boolean

/**
 * Messages in arrival order, and waits for the next one, or the next one a
 * predicate accepts. A wait with a predicate takes the messages it skips off
 * the queue, so a later wait doesn't see them again.
 */
export class MessageQueue {
  private buffer: PubSubMessage[] = []
  private listeners: (() => void)[] = []

  /** @param describe What is subscribed to, for the timeout error. */
  constructor(private readonly describe: string) {}

  push(message: PubSubMessage): void {
    this.buffer.push(message)
    for (const listener of this.listeners.splice(0)) listener()
  }

  /** The next message `predicate` accepts (any message without one), or throw after `timeoutMs`. */
  async next(predicate: MessagePredicate | undefined, timeoutMs: number): Promise<PubSubMessage> {
    const deadline = Date.now() + timeoutMs
    let skipped = 0
    let lastSkipped: PubSubMessage | undefined
    for (;;) {
      let message: PubSubMessage | undefined
      while ((message = this.buffer.shift())) {
        if (!predicate || predicate(message)) return message
        skipped++
        lastSkipped = message
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        const unmatched = lastSkipped
          ? `; ${skipped} message(s) arrived that didn't match, the last on ${lastSkipped.channel}: ${truncate(lastSkipped.message)}`
          : ''
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for a pub/sub message on ${this.describe}${unmatched}`,
        )
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer)
          const index = this.listeners.indexOf(done)
          if (index >= 0) this.listeners.splice(index, 1)
          resolve()
        }
        const timer = setTimeout(done, remaining)
        this.listeners.push(done)
      })
    }
  }
}

function truncate(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
