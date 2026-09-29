import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NativeBridgeError,
  NativeNamespaceWatcherAdapter,
  createNativeBridge,
} from '../src/index.ts'
import type { NativeBridgeClient } from '../src/client.ts'
import type { WatcherChangeEvent } from '../src/types.ts'
import { ShellNamespaceEngine } from '../../../services/shell-namespace/src/engine.ts'

describe('Phase 5 Hardening & Resilience Suite', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elix-phase5-hardening-'))
  })

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  // 1. Outbound native queue saturation & container-invalidated survival
  it('handles native queue saturation and guarantees container-invalidated delivery with rearming', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      const receivedEvents: WatcherChangeEvent[] = []
      const sub = await bridge.watcher.watch(tempDir, (ev) => {
        receivedEvents.push(ev)
      })

      expect(sub.subscriptionId).toBeDefined()

      const initialStats = await sub.getStats()
      expect(initialStats.isInvalidated).toBe(false)
      expect(initialStats.containerEventCount).toBe(0)

      // Trigger native-side container saturation / simulated overflow
      const overflowSimulated = await bridge.simulateOverflow(sub.subscriptionId)
      expect(overflowSimulated).toBe(true)

      // Wait for priority delivery of container-invalidated signal
      const start = Date.now()
      while (!receivedEvents.some(e => e.changeType === 'container-invalidated') && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      const invalidationEvent = receivedEvents.find(
        e => e.changeType === 'container-invalidated',
      )
      expect(invalidationEvent).toBeDefined()
      expect(path.resolve(invalidationEvent!.containerPath).toLowerCase()).toBe(
        path.resolve(tempDir).toLowerCase(),
      )

      const saturatedStats = await sub.getStats()
      expect(saturatedStats.isInvalidated).toBe(true)

      // While invalidated, duplicate simulateOverflow calls do not spam priority queue
      const secondOverflow = await bridge.simulateOverflow(sub.subscriptionId)
      expect(secondOverflow).toBe(true)
      const invalidationCount = receivedEvents.filter(e => e.changeType === 'container-invalidated').length
      expect(invalidationCount).toBe(1)

      // Rearm container to restore normal event delivery
      const rearmed = await sub.rearm()
      expect(rearmed).toBe(true)

      const rearmedStats = await sub.getStats()
      expect(rearmedStats.isInvalidated).toBe(false)
      expect(rearmedStats.containerEventCount).toBe(0)

      await sub.unwatch()
    } finally {
      await bridge.dispose()
    }
  })

  it('handles high event volume under normal drain without permanent false saturation', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      const receivedChanges: string[] = []
      const sub = await bridge.watcher.watch(tempDir, (ev) => {
        receivedChanges.push(ev.changeType)
      })

      // Generate 150 file operations rapidly (exceeding 128 per-container limit if counts leaked)
      for (let i = 0; i < 150; i++) {
        const f = path.join(tempDir, `burst-${i}.txt`)
        fs.writeFileSync(f, `burst ${i}`)
      }

      // Wait for notifications to drain through stdout
      const start = Date.now()
      while (receivedChanges.length < 150 && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(receivedChanges.length).toBeGreaterThanOrEqual(150)
      // Verify no unexpected false container-invalidated occurred since queue drained normally
      expect(receivedChanges).not.toContain('container-invalidated')

      await sub.unwatch()
    } finally {
      await bridge.dispose()
    }
  })

  // 2. Node stdout consumer stall / pipe backpressure
  it('handles pipe backpressure on writeToStdin with drain listening', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      // Create a mock stream that exerts backpressure
      const mockStream = new PassThrough({ highWaterMark: 10 })
      let drained = false
      mockStream.on('drain', () => {
        drained = true
      })

      // Writing payload that exceeds highWaterMark (10 bytes) triggers false on write()
      const writePromise = bridge.writeToStdinForTest(
        mockStream,
        '{"test":"backpressure-data-that-exceeds-high-water-mark"}',
        () => false,
      )

      // Start consuming the stream so drain event is emitted
      setTimeout(() => {
        mockStream.resume()
      }, 50)

      await expect(writePromise).resolves.toBeUndefined()
      expect(drained).toBe(true)
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects writeToStdin when cancelled before write', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const mockStream = new PassThrough()

      const cancelledWrite = bridge.writeToStdinForTest(
        mockStream,
        '{"test":"cancelled"}',
        () => true, // Cancelled flag true
      )
      await expect(cancelledWrite).rejects.toThrow(NativeBridgeError)
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects writeToStdin when cancelled while waiting for drain', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const mockStream = new PassThrough({ highWaterMark: 5 })
      let cancelTrigger: (() => void) | null = null

      const writePromise = bridge.writeToStdinForTest(
        mockStream,
        '{"test":"large-payload-that-blocks-pipe"}',
        () => false,
        (cb) => {
          cancelTrigger = cb
        },
      )

      // Cancel while waiting for drain
      expect(cancelTrigger).toBeDefined()
      cancelTrigger!()

      await expect(writePromise).rejects.toThrow(NativeBridgeError)
    } finally {
      await bridge.dispose()
    }
  })

  it('rejects a blocked stdin write when the child exits before drain', async () => {
    const bridge = createNativeBridge()
    const stream = new Writable({
      highWaterMark: 1,
      write() {},
    })
    const child = new EventEmitter() as ChildProcess
    const writePromise = bridge.writeToStdinForTest(
      stream,
      '{"blocked":true}',
      () => false,
      undefined,
      child,
    )

    child.emit('exit', 42, null)
    await expect(writePromise).rejects.toMatchObject({ code: 'HOST_TERMINATED' })
    stream.destroy()
  })

  it('rejects a blocked stdin write when the stream errors before drain', async () => {
    const bridge = createNativeBridge()
    const stream = new Writable({
      highWaterMark: 1,
      write() {},
    })
    const writePromise = bridge.writeToStdinForTest(
      stream,
      '{"blocked":true}',
      () => false,
    )

    stream.emit('error', new Error('injected stdin failure'))
    await expect(writePromise).rejects.toMatchObject({ code: 'PIPE_ERROR' })
    stream.destroy()
  })

  it('applies the request deadline while the payload is blocked on stdin backpressure', async () => {
    const bridge = createNativeBridge()
    const stream = new Writable({
      highWaterMark: 1,
      write() {},
    })
    const child = Object.assign(new EventEmitter(), {
      stdin: stream,
      killed: false,
      exitCode: null,
      signalCode: null,
    }) as unknown as ChildProcess
    const internals = bridge as unknown as {
      status: string
      hostGeneration: number
      child: ChildProcess | null
      pendingRequests: Map<number, unknown>
    }
    internals.status = 'ready'
    internals.hostGeneration = 1
    internals.child = child

    await expect(bridge.sendRequest('bridge/ping', {}, 25)).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    })
    expect(internals.pendingRequests.size).toBe(0)

    internals.status = 'closed'
    internals.child = null
    stream.destroy()
  })

  it('rejects an oversized request before writing an NDJSON frame', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      await expect(
        bridge.sendRequest('bridge/ping', { payload: 'x'.repeat(1024 * 1024) }),
      ).rejects.toMatchObject({ code: 'REQUEST_TOO_LARGE' })
      expect(await bridge.ping()).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })

  // 3. Reconciliation after invalidation in ShellNamespaceEngine
  it('triggers authoritative reconciliation in ShellNamespaceEngine when container is invalidated', async () => {
    const bridge = createNativeBridge()
    await bridge.connect()

    const engine = new ShellNamespaceEngine({
      bridgeClient: bridge,
      preferNative: true,
    })

    try {
      // 1. Create file on disk
      const testFile = path.join(tempDir, 'initial.txt')
      fs.writeFileSync(testFile, 'initial content', 'utf8')

      // 2. Watch directory through ShellNamespaceEngine
      let containerChangedCount = 0
      engine.on('container-changed', (p) => {
        if (p.toLowerCase() === tempDir.toLowerCase()) {
          containerChangedCount++
        }
      })

      const sub = engine.watch(tempDir)

      // Initial listing to prime catalog
      const items = await engine.listPath(tempDir)
      expect(items.length).toBe(1)
      expect(items[0]?.displayName).toBe('initial.txt')

      // 3. Mutate filesystem while simulating container invalidation
      const newFile = path.join(tempDir, 'added-during-invalidation.txt')
      fs.writeFileSync(newFile, 'reconciled content', 'utf8')

      // Get internal client sub id and trigger invalidation
      const firstSubId = bridge.getActiveWatcherIds()[0]
      expect(firstSubId).toBeDefined()

      await bridge.simulateOverflow(firstSubId!)

      // Wait for immediate container invalidation -> reconciliation loop
      const start = Date.now()
      while (containerChangedCount < 1 && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(containerChangedCount).toBeGreaterThanOrEqual(1)

      // Verify catalog now has the new file after authoritative reconciliation
      const reconciledItems = await engine.listPath(tempDir)
      const found = reconciledItems.find(i => i.displayName === 'added-during-invalidation.txt')
      expect(found).toBeDefined()

      sub.dispose()
    } finally {
      engine.dispose()
      await bridge.dispose()
    }
  })

  it('rearms only after every reconciliation listener completes successfully', async () => {
    let nativeListener: ((event: WatcherChangeEvent) => void) | undefined
    const sequence: string[] = []
    let finishReconciliation: (() => void) | undefined
    const fakeClient = {
      watcher: {
        watch: async (_containerPath: string, listener: (event: WatcherChangeEvent) => void) => {
          nativeListener = listener
          return { unwatch: async () => true }
        },
        rearm: async () => {
          sequence.push('rearm')
          return true
        },
      },
    } as unknown as NativeBridgeClient
    const adapter = new NativeNamespaceWatcherAdapter(fakeClient)
    adapter.watch(tempDir, async () => {
      sequence.push('reconcile-start')
      await new Promise<void>((resolve) => {
        finishReconciliation = resolve
      })
      sequence.push('reconcile-end')
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    nativeListener!({
      subscriptionId: 1,
      containerPath: tempDir,
      changeType: 'container-invalidated',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sequence).toEqual(['reconcile-start'])

    finishReconciliation!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(sequence).toEqual(['reconcile-start', 'reconcile-end', 'rearm'])
    adapter.dispose()
  })

  it('keeps a native watcher degraded when reconciliation fails', async () => {
    let nativeListener: ((event: WatcherChangeEvent) => void) | undefined
    let rearmCount = 0
    const fakeClient = {
      watcher: {
        watch: async (_containerPath: string, listener: (event: WatcherChangeEvent) => void) => {
          nativeListener = listener
          return { unwatch: async () => true }
        },
        rearm: async () => {
          rearmCount++
          return true
        },
      },
    } as unknown as NativeBridgeClient
    const adapter = new NativeNamespaceWatcherAdapter(fakeClient)
    adapter.watch(tempDir, async () => {
      throw new Error('injected reconciliation failure')
    })
    await new Promise(resolve => setTimeout(resolve, 0))

    nativeListener!({
      subscriptionId: 1,
      containerPath: tempDir,
      changeType: 'container-invalidated',
    })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(rearmCount).toBe(0)
    adapter.dispose()
  })

  // 4. Forced native-host crash and automatic restart
  it('detects forced native-host crash, bumps generation, and automatically restarts', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 50,
      },
    })

    try {
      await bridge.connect()
      expect(bridge.getStatus()).toBe('ready')
      const gen1 = bridge.getHostGeneration()
      expect(gen1).toBe(1)

      // Force crash the native host process
      await bridge.crashHost()

      // Wait for supervisor to detect exit and perform reconnect
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getStatus()).toBe('ready')
      const gen2 = bridge.getHostGeneration()
      expect(gen2).toBeGreaterThan(gen1)

      // Bridge is fully operational again
      const pingTime = await bridge.ping()
      expect(pingTime).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })

  // 5. Watcher restoration across host crash and restart
  it('declaratively preserves and restores live watchers across host restart', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 50,
      },
    })

    try {
      await bridge.connect()

      const events: WatcherChangeEvent[] = []
      const sub = await bridge.watcher.watch(tempDir, (ev) => {
        events.push(ev)
      })

      expect(bridge.getActiveWatchersCount()).toBe(1)

      // Crash host
      await bridge.crashHost()

      // Wait for restart & restoration
      const start = Date.now()
      while (
        (bridge.getStatus() !== 'ready' || !events.some(e => e.changeType === 'container-invalidated')) &&
        Date.now() - start < 2000
      ) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.getActiveWatchersCount()).toBe(1)

      // Verify container-invalidated signal was emitted to client listener upon restoration
      const invalidationEvent = events.find(e => e.changeType === 'container-invalidated')
      expect(invalidationEvent).toBeDefined()
      expect(invalidationEvent?.subscriptionId).toBe(sub.subscriptionId)

      await sub.unwatch()
      expect(bridge.getActiveWatchersCount()).toBe(0)
    } finally {
      await bridge.dispose()
    }
  })

  // 6. Filesystem changes during native-host downtime reconciled
  it('reconciles filesystem changes that occurred during native-host downtime', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 80,
      },
    })
    await bridge.connect()

    const engine = new ShellNamespaceEngine({
      bridgeClient: bridge,
      preferNative: true,
    })

    try {
      // Create f1.txt
      const f1 = path.join(tempDir, 'file-before-downtime.txt')
      fs.writeFileSync(f1, 'v1', 'utf8')

      const sub = engine.watch(tempDir)
      const initialItems = await engine.listPath(tempDir)
      const initialId = initialItems[0]!.id
      const addedNames: string[] = []
      const removedIds: string[] = []
      engine.on('item-added', item => addedNames.push(item.displayName))
      engine.on('item-removed', itemId => removedIds.push(itemId))
      while (bridge.getActiveWatchersCount() !== 1) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }

      // Crash native host
      await bridge.crashHost()

      // Perform file mutations WHILE host is down
      fs.unlinkSync(f1)
      const f2 = path.join(tempDir, 'file-created-during-downtime.txt')
      fs.writeFileSync(f2, 'v2', 'utf8')

      // Wait for supervisor to reconnect host, restore watcher, and trigger invalidation
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      // Observe normalized events only; listPath() would perform the enumeration under test.
      const recStart = Date.now()
      while (
        (!addedNames.includes('file-created-during-downtime.txt') ||
          !removedIds.includes(initialId)) &&
        Date.now() - recStart < 2_000
      ) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(addedNames).toContain('file-created-during-downtime.txt')
      expect(removedIds).toContain(initialId)

      sub.dispose()
    } finally {
      engine.dispose()
      await bridge.dispose()
    }
  })

  // 7. Disposed subscriptions are never resurrected
  it('does not resurrect subscriptions disposed prior to or during reconnect', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 100,
      },
    })

    try {
      await bridge.connect()
      const sub = await bridge.watcher.watch(tempDir, () => {})
      expect(bridge.getActiveWatchersCount()).toBe(1)

      // Dispose subscription
      await sub.unwatch()
      expect(bridge.getActiveWatchersCount()).toBe(0)

      // Crash host
      await bridge.crashHost()

      // Wait for restart
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }
      expect(bridge.getStatus()).toBe('ready')

      // Active watchers count must remain 0
      expect(bridge.getActiveWatchersCount()).toBe(0)
    } finally {
      await bridge.dispose()
    }
  })

  it('cannot let disposal from generation one unwatch a reused generation-two watcher ID', async () => {
    const secondDir = path.join(tempDir, 'second')
    fs.mkdirSync(secondDir)
    const bridge = createNativeBridge({
      supervisor: { autoRestart: true, initialBackoffMs: 100 },
    })
    try {
      await bridge.connect()
      let firstEvents = 0
      const secondEvents: WatcherChangeEvent[] = []
      const first = await bridge.watcher.watch(tempDir, () => firstEvents++)
      const second = await bridge.watcher.watch(secondDir, event => secondEvents.push(event))
      const firstGenerationBinding = bridge.getNativeWatcherBindingForTest(first.subscriptionId)
      expect(firstGenerationBinding?.id).toBe(1)

      await bridge.crashHost()
      while (bridge.getStatus() !== 'reconnecting') {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      await first.unwatch()

      const reconnectStart = Date.now()
      while (
        (bridge.getStatus() !== 'ready' ||
          bridge.getNativeWatcherBindingForTest(second.subscriptionId) === null) &&
        Date.now() - reconnectStart < 3_000
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      const secondGenerationBinding = bridge.getNativeWatcherBindingForTest(second.subscriptionId)
      expect(secondGenerationBinding?.id).toBe(firstGenerationBinding?.id)
      expect(bridge.getActiveWatcherIds()).toEqual([second.subscriptionId])

      expect(await second.rearm()).toBe(true)
      secondEvents.length = 0
      fs.writeFileSync(path.join(secondDir, 'still-watched.txt'), 'content')
      const eventStart = Date.now()
      while (!secondEvents.some(event => event.changeType === 'added') && Date.now() - eventStart < 2_000) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(secondEvents.some(event => event.changeType === 'added')).toBe(true)
      expect(firstEvents).toBe(0)
      await second.unwatch()
    } finally {
      await bridge.dispose()
    }
  })

  // 8. Dispose during reconnect
  it('terminates cleanly and cancels backoff when disposed during reconnect', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 500, // Longer backoff so we catch it during reconnect
      },
    })

    await bridge.connect()

    // Crash host
    await bridge.crashHost()
    await new Promise(r => setTimeout(r, 50))
    expect(bridge.getStatus()).toBe('reconnecting')

    // Dispose while reconnecting
    await bridge.dispose()

    expect(bridge.getStatus()).toBe('closed')
    expect(bridge.isReady()).toBe(false)

    // Wait past the scheduled backoff time
    await new Promise(r => setTimeout(r, 600))
    expect(bridge.getStatus()).toBe('closed')
  })

  // 9. Rapid double restart protection with actual process crashes
  it('handles rapid sequential crashes with bounded backoff without unbounded loop', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        maxRestarts: 5,
        initialBackoffMs: 30,
        maxBackoffMs: 100,
      },
    })

    try {
      await bridge.connect()
      expect(bridge.getStatus()).toBe('ready')
      const gen1 = bridge.getHostGeneration()

      // Crash host 1st time
      await bridge.crashHost()

      // Wait for generation to bump and become ready
      const start1 = Date.now()
      while ((bridge.getStatus() !== 'ready' || bridge.getHostGeneration() <= gen1) && Date.now() - start1 < 2000) {
        await new Promise(r => setTimeout(r, 30))
      }
      expect(bridge.getStatus()).toBe('ready')
      const gen2 = bridge.getHostGeneration()
      expect(gen2).toBeGreaterThan(gen1)

      // Crash host 2nd time immediately
      await bridge.crashHost()

      // Wait for generation to bump again and become ready
      const start2 = Date.now()
      while ((bridge.getStatus() !== 'ready' || bridge.getHostGeneration() <= gen2) && Date.now() - start2 < 2000) {
        await new Promise(r => setTimeout(r, 30))
      }
      expect(bridge.getStatus()).toBe('ready')
      const gen3 = bridge.getHostGeneration()
      expect(gen3).toBeGreaterThan(gen2)

      const pingTime = await bridge.ping()
      expect(pingTime).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })

  it('enters a terminal faulted state when handshaking hosts keep crash-flapping', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        maxRestarts: 2,
        initialBackoffMs: 20,
        maxBackoffMs: 20,
        stabilityWindowMs: 5_000,
      },
    })
    try {
      await bridge.connect()
      for (let restart = 0; restart < 2; restart++) {
        const generation = bridge.getHostGeneration()
        await bridge.crashHost()
        const start = Date.now()
        while (
          (bridge.getStatus() !== 'ready' || bridge.getHostGeneration() === generation) &&
          Date.now() - start < 2_000
        ) {
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        expect(bridge.getStatus()).toBe('ready')
      }

      await bridge.crashHost()
      const faultStart = Date.now()
      while (bridge.getStatus() !== 'faulted' && Date.now() - faultStart < 2_000) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(bridge.getStatus()).toBe('faulted')
    } finally {
      await bridge.dispose()
    }
  })

  it('resets the restart budget only after the host satisfies the stability window', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        maxRestarts: 1,
        initialBackoffMs: 20,
        stabilityWindowMs: 80,
      },
    })
    try {
      await bridge.connect()
      await bridge.crashHost()
      while (bridge.getStatus() !== 'ready') {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      const stableGeneration = bridge.getHostGeneration()
      await new Promise(resolve => setTimeout(resolve, 120))

      await bridge.crashHost()
      const start = Date.now()
      while (
        (bridge.getStatus() !== 'ready' || bridge.getHostGeneration() === stableGeneration) &&
        Date.now() - start < 2_000
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.getHostGeneration()).toBeGreaterThan(stableGeneration)
    } finally {
      await bridge.dispose()
    }
  })

  // 10. Duplicate-watcher prevention in adapter
  it('prevents duplicate native watchers when same directory is watched multiple times', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const adapter = new NativeNamespaceWatcherAdapter(bridge)

      let _callback1Count = 0
      let _callback2Count = 0

      const sub1 = adapter.watch(tempDir, () => {
        _callback1Count++
      })
      const sub2 = adapter.watch(tempDir, () => {
        _callback2Count++
      })

      // Wait for watch registration to settle
      await new Promise(r => setTimeout(r, 100))

      // Adapter must consolidate watches onto a single registration
      expect(bridge.getActiveWatchersCount()).toBe(1)

      sub1.dispose()
      // Since sub2 is still active, watch remains
      expect(bridge.getActiveWatchersCount()).toBe(1)

      sub2.dispose()
      // Wait for unwatch to settle
      await new Promise(r => setTimeout(r, 100))

      // Now it's unmounted
      expect(bridge.getActiveWatchersCount()).toBe(0)

      adapter.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  // 11. Stale-generation response/event rejection
  it('rejects previously valid request and watcher IDs solely because their host generation is stale', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const generationOne = bridge.getHostGeneration()
      let watcherEventCount = 0
      const watcher = await bridge.watcher.watch(tempDir, () => {
        watcherEventCount++
      })
      const generationOneBinding = bridge.getNativeWatcherBindingForTest(watcher.subscriptionId)
      expect(generationOneBinding?.generation).toBe(generationOne)

      const delayedRequest = bridge.sendRequest('bridge/delay', { ms: 5_000 })
      const pendingRequests = (bridge as unknown as {
        pendingRequests: Map<number, unknown>
        child: ChildProcess
      }).pendingRequests
      const generationOneRequestId = Array.from(pendingRequests.keys()).at(-1)
      expect(generationOneRequestId).toBeDefined()

      ;(bridge as unknown as { child: ChildProcess }).child.kill()
      await expect(delayedRequest).rejects.toMatchObject({ code: 'HOST_TERMINATED' })

      const reconnectStart = Date.now()
      while (
        (bridge.getStatus() !== 'ready' ||
          bridge.getHostGeneration() === generationOne ||
          bridge.getNativeWatcherBindingForTest(watcher.subscriptionId) === null) &&
        Date.now() - reconnectStart < 3_000
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      const generationTwo = bridge.getHostGeneration()
      const generationTwoBinding = bridge.getNativeWatcherBindingForTest(watcher.subscriptionId)
      expect(generationTwo).toBeGreaterThan(generationOne)
      expect(generationTwoBinding?.generation).toBe(generationTwo)
      expect(generationTwoBinding?.id).toBe(generationOneBinding?.id)

      const staleBefore = bridge.getDiscardedStaleFrameCountForTest()
      bridge.handleIncomingLineForTest(
        JSON.stringify({ id: generationOneRequestId, result: { stale: true } }),
        generationOne,
      )
      bridge.handleIncomingLineForTest(
        JSON.stringify({
          event: 'watcher/change',
          payload: {
            subscriptionId: generationOneBinding?.id,
            containerPath: tempDir,
            changeType: 'modified',
          },
        }),
        generationOne,
      )

      expect(bridge.getDiscardedStaleFrameCountForTest()).toBe(staleBefore + 2)
      expect(watcherEventCount).toBe(1)
      expect(bridge.isReady()).toBe(true)
      await watcher.unwatch()
    } finally {
      await bridge.dispose()
    }
  })

  it('replays an invalidation that arrives before its watcher binding is installed', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      const events: WatcherChangeEvent[] = []

      bridge.handleIncomingLineForTest(
        JSON.stringify({
          event: 'watcher/change',
          payload: {
            subscriptionId: 1,
            containerPath: tempDir,
            changeType: 'container-invalidated',
          },
        }),
        bridge.getHostGeneration(),
      )

      const watcher = await bridge.watcher.watch(tempDir, event => events.push(event))
      expect(bridge.getNativeWatcherBindingForTest(watcher.subscriptionId)?.id).toBe(1)
      expect(events).toContainEqual(expect.objectContaining({
        subscriptionId: watcher.subscriptionId,
        changeType: 'container-invalidated',
      }))
      await watcher.unwatch()
    } finally {
      await bridge.dispose()
    }
  })

  // 12. Graceful cleanup with zero leaked child process/watchers/handles
  it('gracefully disposes client with zero leaked child process and cleared handles', async () => {
    const bridge = createNativeBridge()
    await bridge.connect()

    await bridge.watcher.watch(tempDir, () => {})

    expect(bridge.isChildKilled()).toBe(false)

    const childPid = bridge.getChildProcessIdForTest()
    expect(childPid).toBeDefined()
    await bridge.dispose()

    expect(bridge.getStatus()).toBe('closed')
    expect(bridge.getActiveWatchersCount()).toBe(0)
    expect(bridge.isReady()).toBe(false)
    expect(bridge.isChildKilled()).toBe(true)
    expect(() => process.kill(childPid!, 0)).toThrow()
  })

  // 13. Queue and execute requests submitted while bridge is reconnecting
  it('queues and executes requests submitted while bridge is reconnecting', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 80,
      },
    })

    try {
      await bridge.connect()
      expect(bridge.getStatus()).toBe('ready')

      // Crash host
      await bridge.crashHost()
      await new Promise(r => setTimeout(r, 20))
      expect(bridge.getStatus()).toBe('reconnecting')

      let pingWrites = 0
      const internals = bridge as unknown as {
        sendRequestInternal: (...args: readonly unknown[]) => Promise<unknown>
      }
      const sendRequestInternal = internals.sendRequestInternal.bind(bridge)
      internals.sendRequestInternal = async (...args: readonly unknown[]) => {
        if (args[0] === 'bridge/ping') pingWrites++
        return sendRequestInternal(...args)
      }

      const pingPromise = bridge.ping()

      // Should seamlessly await reconnect and resolve
      const res = await pingPromise
      expect(res).toBeGreaterThan(0)
      expect(bridge.getStatus()).toBe('ready')
      expect(pingWrites).toBe(1)
    } finally {
      await bridge.dispose()
    }
  })

  // 14. Purge watcher for directory deleted during downtime
  it('cleanly purges watchers for directories deleted during host downtime', async () => {
    const subFolder = path.join(tempDir, 'deleted-during-downtime')
    fs.mkdirSync(subFolder, { recursive: true })

    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 50,
      },
    })

    try {
      await bridge.connect()

      let invalidationEmitted = false
      await bridge.watcher.watch(subFolder, (ev) => {
        if (ev.changeType === 'container-invalidated') {
          invalidationEmitted = true
        }
      })
      expect(bridge.getActiveWatchersCount()).toBe(1)

      // Crash host
      await bridge.crashHost()

      // Delete the watched folder while host is down
      fs.rmSync(subFolder, { recursive: true, force: true })

      // Wait for host to reconnect and process restoration
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      // Active watcher count must drop to 0 because directory no longer exists
      const restStart = Date.now()
      while (bridge.getActiveWatchersCount() > 0 && Date.now() - restStart < 2000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getActiveWatchersCount()).toBe(0)
      expect(invalidationEmitted).toBe(true)
    } finally {
      await bridge.dispose()
    }
  })

  // 15. Preserves active watchers across host crashes occurring during reconnection
  it('preserves active watchers across host crashes occurring during reconnection', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 30,
        maxRestarts: 5,
      },
    })

    try {
      await bridge.connect()
      await bridge.watcher.watch(tempDir, () => {})
      expect(bridge.getActiveWatchersCount()).toBe(1)

      // Cause first crash
      await bridge.crashHost()

      // Immediately cause another crash before or during restoreWatchers
      await new Promise(r => setTimeout(r, 40))
      await bridge.crashHost()

      // Wait for bridge to stabilize in ready state
      const start = Date.now()
      while (bridge.getStatus() !== 'ready' && Date.now() - start < 3000) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(bridge.getStatus()).toBe('ready')
      // Watcher must not have been deleted from activeWatchers by host crash
      expect(bridge.getActiveWatchersCount()).toBe(1)

      const pingRes = await bridge.ping()
      expect(pingRes).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })

  it('retries without losing watcher intent when the reconnecting host dies during restoration', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 20,
        maxBackoffMs: 40,
        maxRestarts: 4,
      },
    })
    let releaseRestore: (() => void) | undefined
    let restorationStarted: (() => void) | undefined
    const restoreGate = new Promise<void>((resolve) => {
      releaseRestore = resolve
    })
    const enteredRestore = new Promise<void>((resolve) => {
      restorationStarted = resolve
    })
    const internals = bridge as unknown as {
      child: ChildProcess | null
      restoreWatchers: (generation: number) => Promise<void>
    }
    const restoreWatchers = internals.restoreWatchers.bind(bridge)
    internals.restoreWatchers = async (generation: number) => {
      if (generation > 1) {
        restorationStarted!()
        await restoreGate
      }
      await restoreWatchers(generation)
    }

    try {
      await bridge.connect()
      const watcher = await bridge.watcher.watch(tempDir, () => {})
      const firstGeneration = bridge.getHostGeneration()

      await bridge.crashHost()
      await enteredRestore
      expect(bridge.getHostGeneration()).toBeGreaterThan(firstGeneration)
      internals.child!.kill()
      releaseRestore!()

      const recoveryStart = Date.now()
      while (
        (bridge.getStatus() !== 'ready' ||
          bridge.getHostGeneration() < firstGeneration + 2 ||
          bridge.getNativeWatcherBindingForTest(watcher.subscriptionId) === null) &&
        Date.now() - recoveryStart < 3_000
      ) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }

      expect(bridge.getStatus()).toBe('ready')
      expect(bridge.getHostGeneration()).toBeGreaterThanOrEqual(firstGeneration + 2)
      expect(bridge.getActiveWatcherIds()).toContain(watcher.subscriptionId)
      expect(bridge.getNativeWatcherBindingForTest(watcher.subscriptionId)?.generation)
        .toBe(bridge.getHostGeneration())
      await watcher.unwatch()
    } finally {
      releaseRestore?.()
      await bridge.dispose()
    }
  })

  // 16. Request times out with REQUEST_TIMEOUT when reconnect wait exceeds deadline
  it('rejects queued requests with REQUEST_TIMEOUT when reconnect deadline is exceeded', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        initialBackoffMs: 1000, // Long backoff so reconnect does not complete quickly
      },
    })

    try {
      await bridge.connect()

      // Crash host so it enters reconnecting
      await bridge.crashHost()
      await new Promise(r => setTimeout(r, 30))
      expect(bridge.getStatus()).toBe('reconnecting')

      // Submit request with short timeout override (100ms)
      const fastRequest = bridge.sendRequest('bridge/ping', {}, 100)

      await expect(fastRequest).rejects.toThrow(NativeBridgeError)
      await expect(fastRequest).rejects.toMatchObject({
        code: 'REQUEST_TIMEOUT',
        retryable: true,
      })
    } finally {
      await bridge.dispose()
    }
  })

  // 17. Rejects all pending requests with BRIDGE_FAULTED when max restarts reached
  it('rejects all pending requests with BRIDGE_FAULTED when supervisor reaches max restarts', async () => {
    const bridge = createNativeBridge({
      supervisor: {
        autoRestart: true,
        maxRestarts: 1,
        initialBackoffMs: 20,
      },
      // Invalid binary so reconnection fails
      binaryPath: 'C:/non_existent_binary_that_cannot_run.exe',
    })

    try {
      // Connect will fail and transition to faulted
      await expect(bridge.connect()).rejects.toThrow(NativeBridgeError)
      expect(bridge.getStatus()).toBe('faulted')

      // Requests while faulted reject immediately with BRIDGE_FAULTED
      const req = bridge.sendRequest('bridge/ping')
      await expect(req).rejects.toMatchObject({
        code: 'BRIDGE_FAULTED',
        retryable: false,
      })
    } finally {
      await bridge.dispose()
    }
  })

  // 18. Graceful shutdown sends bridge/shutdown before process termination
  it('sends graceful shutdown RPC before terminating process on dispose', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()
      expect(bridge.getStatus()).toBe('ready')

      // Spy on sendRequestInternal to confirm bridge/shutdown is sent
      let shutdownRpcSent = false
      type InternalSender = (
        method: string,
        params?: unknown,
        timeout?: number,
        gen?: number,
      ) => Promise<unknown>
      const bridgeInternal = bridge as unknown as { sendRequestInternal: InternalSender }
      const origSend = bridgeInternal.sendRequestInternal.bind(bridge)
      bridgeInternal.sendRequestInternal = async (
        method: string,
        params?: unknown,
        timeout?: number,
        gen?: number,
      ): Promise<unknown> => {
        if (method === 'bridge/shutdown') {
          shutdownRpcSent = true
        }
        return origSend(method, params, timeout, gen)
      }

      await bridge.dispose()
      expect(shutdownRpcSent).toBe(true)
      expect(bridge.getStatus()).toBe('closed')
    } finally {
      await bridge.dispose()
    }
  })

  // 19. Bidirectional protocol negotiation rejects incompatible clientVersion
  it('rejects handshake if the explicit client protocol version is incompatible', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      const incompatibleReq = bridge.sendRequest('bridge/handshake', {
        protocolVersion: 2,
        clientVersion: '0.1.0',
      })

      await expect(incompatibleReq).rejects.toThrow(NativeBridgeError)
      await expect(incompatibleReq).rejects.toMatchObject({
        code: 'INCOMPATIBLE_PROTOCOL',
        retryable: false,
      })
    } finally {
      await bridge.dispose()
    }
  })

  // 20. Immediate PROTOCOL_ERROR rejection on malformed JSON from host
  it('rejects pending requests with PROTOCOL_ERROR immediately on malformed stdout', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      // Submit a delayed request
      const pendingPromise = bridge.sendRequest('bridge/delay', { ms: 2000 })

      // Inject malformed JSON line into incoming line handler
      const clientAny = bridge as unknown as {
        handleIncomingLine: (line: string, generation: number) => void
        hostGeneration: number
      }
      clientAny.handleIncomingLine('CORRUPTED_NON_JSON_LINE {{{', clientAny.hostGeneration)

      // Request must fail immediately with PROTOCOL_ERROR rather than timing out
      await expect(pendingPromise).rejects.toThrow(NativeBridgeError)
      await expect(pendingPromise).rejects.toMatchObject({
        code: 'PROTOCOL_ERROR',
        retryable: false,
      })
    } finally {
      await bridge.dispose()
    }
  })

  // 21. Adapter dispose race guard unwatches cleanly even if disposed before watchPromise resolves
  it('unwatches native watcher even if dispose occurs before watchPromise resolves', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      const adapter = new NativeNamespaceWatcherAdapter(bridge, { debounceMs: 50 })
      let listenerCalled = false

      // Register watch
      const sub = adapter.watch(tempDir, () => {
        listenerCalled = true
      })

      // Synchronously dispose subscription before async bridge.watch resolves
      sub.dispose()

      // Wait 150ms for background watch promise to settle
      await new Promise(r => setTimeout(r, 150))

      // Trigger a file write in tempDir
      fs.writeFileSync(path.join(tempDir, 'race-test.txt'), 'content')

      // Wait another 150ms
      await new Promise(r => setTimeout(r, 150))

      // Listener must not be called because it was disposed
      expect(listenerCalled).toBe(false)

      adapter.dispose()
    } finally {
      await bridge.dispose()
    }
  })

  // 22. Stderr stream is continuously drained
  it('drains stderr stream so native process never blocks on diagnostic output', async () => {
    const bridge = createNativeBridge()
    try {
      await bridge.connect()

      // Check child process stderr is listening
      const clientAny = bridge as unknown as { child: { stderr: { listenerCount: (ev: string) => number } } }
      expect(clientAny.child.stderr.listenerCount('data')).toBeGreaterThan(0)

      // Ping to verify host is responsive
      const pingRes = await bridge.ping()
      expect(pingRes).toBeGreaterThan(0)
    } finally {
      await bridge.dispose()
    }
  })
})
