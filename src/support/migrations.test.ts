import { describe, it, expect } from 'vitest'
import * as os from 'os'
import { redactPassword, redactUrl, runMigrationCommand, runMigrations } from './migrations'

const url = 'postgres://app:s3cret@db.example:5432/shop'

describe('redaction (COMPONENT-24)', () => {
  it('hides the password in a URL', () => {
    expect(redactUrl(url)).toBe('postgres://app:***@db.example:5432/shop')
    expect(redactUrl('postgres://app@db/shop')).toBe('postgres://app@db/shop')
  })

  it('hides the password wherever it appears, encoded or not', () => {
    const encoded = 'postgres://app:p%40ss@db/shop'
    expect(redactPassword('failed with p@ss and p%40ss', encoded)).toBe('failed with *** and ***')
    expect(redactPassword('pw is 100%', 'postgres://app:100%@db/shop')).toBe('pw is ***')
    expect(redactPassword('nothing to hide', 'postgres://app@db/shop')).toBe('nothing to hide')
  })
})

describe('the migrations command (COMPONENT-24)', () => {
  it('runs through the shell with DATABASE_URL set to the target, over any env of the same name', async () => {
    await expect(
      runMigrationCommand(url, {
        command: 'test "$DATABASE_URL" = "$EXPECTED" && test "$EXTRA" = yes',
        env: { DATABASE_URL: 'postgres://wrong/x', EXPECTED: url, EXTRA: 'yes' },
      }),
    ).resolves.toBeUndefined()
  })

  it('runs in the given directory', async () => {
    await expect(
      runMigrationCommand(url, {
        command: `test "$(pwd -P)" = "${os.tmpdir()}"`,
        cwd: os.tmpdir(),
      }),
    ).resolves.toBeUndefined()
  })

  it('names the command, the exit code and the last 40 lines, without the password', async () => {
    const err = await runMigrationCommand(url, {
      command: 'seq 1 100; echo "url $DATABASE_URL" >&2; exit 5',
    }).then(
      () => undefined,
      (e: Error) => e,
    )
    const message = err?.message ?? ''
    expect(message).toContain('exit code 5')
    expect(message).toContain('seq 1 100; echo "url $DATABASE_URL" >&2; exit 5')
    expect(message).toContain('url postgres://app:***@db.example:5432/shop')
    expect(message).not.toContain('s3cret')
    const lines = message.split('\n').slice(1)
    expect(lines).toHaveLength(40)
    expect(lines[0]).toBe('62')
  })

  it('reports a timeout', async () => {
    await expect(runMigrationCommand(url, { command: 'sleep 5', timeoutMs: 100 })).rejects.toThrow(
      /timed out after 100ms/,
    )
  })

  it('fails before running anything when the server is unreachable', async () => {
    await expect(
      runMigrations('postgres://u:hunter2@127.0.0.1:1/app', { command: 'true' }),
    ).rejects.toThrow()
  })
})
