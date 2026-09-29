import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ShellRecoveryJournal } from '../src/index.ts'

describe('Shell Layout - Recovery Journal', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function createJournal(): { journal: ShellRecoveryJournal; path: string } {
    const root = mkdtempSync(join(tmpdir(), 'elix-shell-recovery-'))
    roots.push(root)
    const path = join(root, 'nested', 'shell-layout.json')
    return { journal: new ShellRecoveryJournal(path), path }
  }

  it('atomically arms and reads session-scoped replacement recovery evidence', () => {
    const { journal, path } = createJournal()

    const armed = journal.arm({
      sessionId: 'user:console',
      controllerGeneration: 17,
      previousMode: 'coexistence',
      desiredMode: 'replacement',
      nativeBarIds: ['bar-b', 'bar-a', 'bar-a'],
    })

    expect(armed.status).toBe('armed')
    expect(armed.nativeBarIds).toEqual(['bar-a', 'bar-b'])
    expect(journal.read()).toEqual(armed)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      version: 1,
      sessionId: 'user:console',
      controllerGeneration: 17,
      intendedMutation: 'taskbar-replacement',
    })
  })

  it('preserves unfinished evidence and only clears a completed recovery record', () => {
    const { journal } = createJournal()

    journal.arm({
      sessionId: 'user:console',
      controllerGeneration: 3,
      previousMode: 'coexistence',
      desiredMode: 'replacement',
      nativeBarIds: [],
    })

    expect(journal.clearRecovered()).toBe(false)
    expect(journal.markRestoring('manual-restore')?.status).toBe('restoring')
    expect(journal.clearRecovered()).toBe(false)
    expect(journal.markRecovered('verified-windows-shell')?.status).toBe('recovered')
    expect(journal.clearRecovered()).toBe(true)
    expect(journal.read()).toBeUndefined()
  })

  it('does not treat corrupt or incompatible data as valid recovery authority', () => {
    const { journal, path } = createJournal()

    // mkdir is exercised by arm first; then replace the completed file with corruption.
    journal.arm({
      sessionId: 'user:console',
      controllerGeneration: 1,
      previousMode: 'coexistence',
      desiredMode: 'replacement',
      nativeBarIds: [],
    })

    writeFileSync(path, '{ not valid json', 'utf8')
    expect(journal.read()).toBeUndefined()

    writeFileSync(path, JSON.stringify({ version: 999 }), 'utf8')
    expect(journal.read()).toBeUndefined()
  })

  it('rejects invalid session and generation metadata before writing', () => {
    const { journal } = createJournal()

    expect(() => journal.arm({
      sessionId: '',
      controllerGeneration: 1,
      previousMode: 'coexistence',
      desiredMode: 'replacement',
      nativeBarIds: [],
    })).toThrow(TypeError)

    expect(() => journal.arm({
      sessionId: 'user:console',
      controllerGeneration: -1,
      previousMode: 'coexistence',
      desiredMode: 'replacement',
      nativeBarIds: [],
    })).toThrow(RangeError)
  })
})
