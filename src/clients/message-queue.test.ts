import { describe, it, expect } from 'vitest'
import { MessageQueue } from './message-queue'

const msg = (message: string, channel = 'events') => ({ channel, message })

describe('MessageQueue (COMPONENT-15)', () => {
  it('returns buffered messages in arrival order', async () => {
    const queue = new MessageQueue('events')
    queue.push(msg('a'))
    queue.push(msg('b'))
    expect((await queue.next(undefined, 100)).message).toBe('a')
    expect((await queue.next(undefined, 100)).message).toBe('b')
  })

  it('wakes a waiter when a message arrives', async () => {
    const queue = new MessageQueue('events')
    const waiting = queue.next(undefined, 1_000)
    setTimeout(() => queue.push(msg('late')), 20)
    expect((await waiting).message).toBe('late')
  })

  it('skips messages the predicate rejects and takes them off the queue', async () => {
    const queue = new MessageQueue('events')
    queue.push(msg('reading'))
    queue.push(msg('optimiser'))
    queue.push(msg('reading'))
    const found = await queue.next((m) => m.message === 'optimiser', 100)
    expect(found.message).toBe('optimiser')
    // The skipped "reading" is gone; the one after the match is still there.
    expect((await queue.next(undefined, 100)).message).toBe('reading')
    await expect(queue.next(undefined, 20)).rejects.toThrow(/Timed out after 20ms/)
  })

  it('keeps waiting past rejected messages that arrive later', async () => {
    const queue = new MessageQueue('events')
    const waiting = queue.next((m) => m.message === 'wanted', 1_000)
    setTimeout(() => queue.push(msg('other')), 10)
    setTimeout(() => queue.push(msg('wanted')), 30)
    expect((await waiting).message).toBe('wanted')
  })

  it('says what it waited on, and what arrived that did not match', async () => {
    const queue = new MessageQueue('pattern events:*')
    queue.push(msg('{"type":"reading"}', 'events:u1'))
    await expect(queue.next(() => false, 20)).rejects.toThrow(
      'Timed out after 20ms waiting for a pub/sub message on pattern events:*; 1 message(s) ' +
        'arrived that didn\'t match, the last on events:u1: {"type":"reading"}',
    )
  })

  it('serves two waiters one message each', async () => {
    const queue = new MessageQueue('events')
    const first = queue.next(undefined, 1_000)
    const second = queue.next(undefined, 1_000)
    queue.push(msg('one'))
    queue.push(msg('two'))
    const got = [(await first).message, (await second).message].sort()
    expect(got).toEqual(['one', 'two'])
  })
})
