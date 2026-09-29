import type { NativeRawWindow } from '@deepseek-ai/dsh-native-core'
import { describe, expect, it } from 'vitest'
import { WindowIdentityTracker } from '../src/identity.ts'

function mockRawWindow(overrides: Partial<NativeRawWindow> = {}): NativeRawWindow {
  return {
    hwnd: 0x1001,
    processId: 100,
    threadId: 200,
    processCreationTime: 1000,
    title: 'Test Window',
    className: 'TestWindowClass',
    bounds: { x: 100, y: 100, width: 800, height: 600 },
    isVisible: true,
    isMinimized: false,
    isMaximized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isEnabled: true,
    isForeground: false,
    ...overrides,
  }
}

describe('WindowIdentityTracker', () => {
  it('mints stable WindowId that is never equal to bare HWND number or string', () => {
    const tracker = new WindowIdentityTracker()
    const raw = mockRawWindow({ hwnd: 0x1234 })
    const res = tracker.reconcileWindow(raw)

    expect(res.isNew).toBe(true)
    expect(res.id).toBeTypeOf('string')
    expect(res.id).not.toBe('0x1234')
    expect(res.id).not.toBe('4660')
    expect(res.id.startsWith('win_')).toBe(true)
  })

  it('preserves WindowId for continuous window lifetime with matching evidence', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x1001, processId: 1234, processCreationTime: 5000, className: 'Chrome_WidgetWin_1' })
    const res1 = tracker.reconcileWindow(raw1)

    const raw2 = mockRawWindow({ hwnd: 0x1001, processId: 1234, processCreationTime: 5000, className: 'Chrome_WidgetWin_1', title: 'New Tab - Google Chrome' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(false)
    expect(res2.id).toBe(res1.id)
  })

  it('detects HWND recycling when processId differs', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x2001, processId: 100, processCreationTime: 5000, className: 'Notepad' })
    const res1 = tracker.reconcileWindow(raw1)

    // Window 1 is closed, OS gives same HWND to a new process
    const raw2 = mockRawWindow({ hwnd: 0x2001, processId: 200, processCreationTime: 6000, className: 'CalcFrame' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(true)
    expect(res2.id).not.toBe(res1.id)
    expect(res2.recycledOldEvidence?.id).toBe(res1.id)
    expect(res2.recycledOldEvidence?.processId).toBe(100)
  })

  it('detects HWND recycling when processCreationTime differs (PID reused by OS)', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x3001, processId: 500, processCreationTime: 1000, className: 'AppClass' })
    const res1 = tracker.reconcileWindow(raw1)

    // OS recycled the PID and HWND for a new process instance later
    const raw2 = mockRawWindow({ hwnd: 0x3001, processId: 500, processCreationTime: 2000, className: 'AppClass' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(true)
    expect(res2.id).not.toBe(res1.id)
    expect(res2.recycledOldEvidence?.id).toBe(res1.id)
  })

  it('detects HWND recycling when className differs', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x4001, processId: 500, processCreationTime: 1000, className: 'ClassA' })
    const res1 = tracker.reconcileWindow(raw1)

    const raw2 = mockRawWindow({ hwnd: 0x4001, processId: 500, processCreationTime: 1000, className: 'ClassB' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(true)
    expect(res2.id).not.toBe(res1.id)
  })

  it('reconciles complete snapshots preserving live windows and identifying destroyed/created', () => {
    const tracker = new WindowIdentityTracker()
    const w1 = mockRawWindow({ hwnd: 0x10, processId: 10, processCreationTime: 100, className: 'A' })
    const w2 = mockRawWindow({ hwnd: 0x20, processId: 20, processCreationTime: 200, className: 'B' })
    const res1 = tracker.reconcileSnapshot([w1, w2])

    expect(res1.created.length).toBe(2)
    const id1 = res1.created.find(c => c.raw.hwnd === 0x10)!.id
    const id2 = res1.created.find(c => c.raw.hwnd === 0x20)!.id

    // Next snapshot: w1 survives, w2 closed, w3 created, w4 takes recycled HWND of w2
    const w1Updated = mockRawWindow({ hwnd: 0x10, processId: 10, processCreationTime: 100, className: 'A', title: 'Updated' })
    const w3 = mockRawWindow({ hwnd: 0x30, processId: 30, processCreationTime: 300, className: 'C' })

    const res2 = tracker.reconcileSnapshot([w1Updated, w3])

    // w1 retained with same ID
    expect(res2.retained.get(0x10)?.id).toBe(id1)
    // w2 was destroyed
    expect(res2.destroyed.some(d => d.id === id2)).toBe(true)
    // w3 was created
    expect(res2.created.some(c => c.raw.hwnd === 0x30)).toBe(true)
  })

  it('reconciles recycled HWND in snapshot reconciliation', () => {
    const tracker = new WindowIdentityTracker()
    const w1 = mockRawWindow({ hwnd: 0x50, processId: 10, processCreationTime: 100, className: 'A' })
    const initial = tracker.reconcileSnapshot([w1])
    const oldId = initial.created[0]!.id

    // HWND 0x50 now belongs to a new process
    const w1Recycled = mockRawWindow({ hwnd: 0x50, processId: 99, processCreationTime: 999, className: 'Z' })
    const next = tracker.reconcileSnapshot([w1Recycled])

    expect(next.recycled.length).toBe(1)
    expect(next.recycled[0]!.oldEvidence.id).toBe(oldId)
    expect(next.created.length).toBe(1)
    expect(next.created[0]!.id).not.toBe(oldId)
  })

  it('detects HWND recycling when threadId differs even if PID matches', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x6001, processId: 500, threadId: 101, processCreationTime: 1000, className: 'Chrome_WidgetWin_1' })
    const res1 = tracker.reconcileWindow(raw1)

    // Different GUI thread inside the same process using the same HWND value later
    const raw2 = mockRawWindow({ hwnd: 0x6001, processId: 500, threadId: 102, processCreationTime: 1000, className: 'Chrome_WidgetWin_1' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(true)
    expect(res2.id).not.toBe(res1.id)
    expect(res2.recycledOldEvidence?.id).toBe(res1.id)
  })

  it('detects HWND recycling when executableName differs', () => {
    const tracker = new WindowIdentityTracker()
    const raw1 = mockRawWindow({ hwnd: 0x7001, processId: 500, className: 'Window', executableName: 'appA.exe' })
    const res1 = tracker.reconcileWindow(raw1)

    const raw2 = mockRawWindow({ hwnd: 0x7001, processId: 500, className: 'Window', executableName: 'appB.exe' })
    const res2 = tracker.reconcileWindow(raw2)

    expect(res2.isNew).toBe(true)
    expect(res2.id).not.toBe(res1.id)
  })

  it('safely handles access-denied processes with processCreationTime = 0 using TID evidence', () => {
    const tracker = new WindowIdentityTracker()
    // Protected process where GetProcessTimes returns 0
    const raw1 = mockRawWindow({ hwnd: 0x8001, processId: 4, threadId: 10, processCreationTime: 0, className: 'SystemClass' })
    const res1 = tracker.reconcileWindow(raw1)
    expect(res1.isNew).toBe(true)

    // Same continuous lifetime
    const rawCont = mockRawWindow({ hwnd: 0x8001, processId: 4, threadId: 10, processCreationTime: 0, className: 'SystemClass', title: 'Updated' })
    const resCont = tracker.reconcileWindow(rawCont)
    expect(resCont.isNew).toBe(false)
    expect(resCont.id).toBe(res1.id)

    // Recycled handle with different threadId
    const rawRecycled = mockRawWindow({ hwnd: 0x8001, processId: 4, threadId: 20, processCreationTime: 0, className: 'SystemClass' })
    const resRecycled = tracker.reconcileWindow(rawRecycled)
    expect(resRecycled.isNew).toBe(true)
    expect(resRecycled.id).not.toBe(res1.id)
  })

  it('tracks firstSeenGeneration and lastSeenGeneration across host generations', () => {
    const tracker = new WindowIdentityTracker()
    const w1 = mockRawWindow({ hwnd: 0x9001, processId: 10, processCreationTime: 100 })

    // Generation 1 snapshot
    const snap1 = tracker.reconcileSnapshot([w1], 1)
    const evidence1 = snap1.created[0]!.evidence
    expect(evidence1.firstSeenGeneration).toBe(1)
    expect(evidence1.lastSeenGeneration).toBe(1)
    const createdAt1 = evidence1.createdAt
    expect(createdAt1).toBeGreaterThan(0)

    // Generation 2 snapshot (after host restart)
    const snap2 = tracker.reconcileSnapshot([w1], 2)
    expect(snap2.retained.has(0x9001)).toBe(true)
    const evidence2 = snap2.retained.get(0x9001)!
    expect(evidence2.id).toBe(evidence1.id)
    expect(evidence2.firstSeenGeneration).toBe(1) // preserved!
    expect(evidence2.lastSeenGeneration).toBe(2) // updated!
    expect(evidence2.createdAt).toBe(createdAt1) // preserved!
  })
})
