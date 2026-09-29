import { describe, expect, it } from 'vitest'
import { ProcessObservationState } from '../src/state.ts'
import type { NativeProcessSnapshot } from '../src/types.ts'

function snapshot(
  capturedAt: number,
  processes: NativeProcessSnapshot['processes'],
): NativeProcessSnapshot {
  return { capturedAt, processes }
}

describe('ProcessObservationState', () => {
  it('commits an initial immutable snapshot and suppresses identical refreshes', () => {
    const state = new ProcessObservationState()
    const first = state.apply(snapshot(1000, [{
      processId: 10,
      parentProcessId: 1,
      processCreationTime: 111,
      executablePath: 'C:/Apps/A.exe',
      executableName: 'A.exe',
    }]))

    expect(first?.reason).toBe('initial')
    expect(first?.started).toHaveLength(1)
    expect(first?.snapshot.processes[0]).toMatchObject({
      identity: { pid: 10, creationTime: 111 },
      identityKey: '10:111',
      identityQuality: 'stable',
    })

    expect(state.apply(snapshot(2000, [{
      processId: 10,
      parentProcessId: 1,
      processCreationTime: 111,
      executablePath: 'C:/Apps/A.exe',
      executableName: 'A.exe',
    }]))).toBeUndefined()
    expect(state.getSnapshot().revision).toBe(1)
  })

  it('emits started, exited, and metadata updates atomically', () => {
    const state = new ProcessObservationState()
    state.apply(snapshot(1000, [{
      processId: 10,
      parentProcessId: 1,
      processCreationTime: 111,
      executableName: 'A.exe',
    }, {
      processId: 20,
      parentProcessId: 1,
      processCreationTime: 222,
      executableName: 'B.exe',
    }]))

    const change = state.apply(snapshot(2000, [{
      processId: 10,
      parentProcessId: 1,
      processCreationTime: 111,
      executableName: 'A-renamed.exe',
    }, {
      processId: 30,
      parentProcessId: 10,
      processCreationTime: 333,
      executableName: 'C.exe',
    }]))

    expect(change?.started.map(process => process.identity.pid)).toEqual([30])
    expect(change?.exited.map(process => process.identity.pid)).toEqual([20])
    expect(change?.updated.map(process => process.identity.pid)).toEqual([10])
    expect(change?.snapshot.revision).toBe(2)
  })

  it('treats PID reuse as old process exit plus new process start', () => {
    const state = new ProcessObservationState()
    state.apply(snapshot(1000, [{
      processId: 42,
      parentProcessId: 1,
      processCreationTime: 100,
      executableName: 'old.exe',
    }]))

    const change = state.apply(snapshot(2000, [{
      processId: 42,
      parentProcessId: 1,
      processCreationTime: 200,
      executableName: 'new.exe',
    }]))

    expect(change?.exited[0]?.identityKey).toBe('42:100')
    expect(change?.started[0]?.identityKey).toBe('42:200')
    expect(change?.updated).toHaveLength(0)
  })

  it('retains inaccessible processes as explicit PID-only identities', () => {
    const state = new ProcessObservationState()
    const change = state.apply(snapshot(1000, [{
      processId: 4,
      parentProcessId: 0,
      processCreationTime: 0,
      executableName: 'System',
    }]))

    expect(change?.snapshot.processes[0]).toMatchObject({
      identityKey: '4:unknown',
      identityQuality: 'pid-only',
      executableName: 'System',
    })
  })
})
