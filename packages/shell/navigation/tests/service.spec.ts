import { Context } from '@deepseek-ai/cordis'
import type {
  GlobalHotkeyBinding,
  GlobalHotkeyEvent,
  GlobalInputSource,
  NormalizedGlobalHotkeyBinding,
} from '@deepseek-ai/dsh-global-input'
import type {
  ObservedSpaceSnapshot,
  SpaceId,
  SpacesCapabilities,
  SpacesSnapshot,
  SpacesSource,
} from '@deepseek-ai/dsh-spaces'
import type { WindowControlSource } from '@deepseek-ai/dsh-window-control'
import type {
  WindowId,
  WindowRegistrySnapshot,
  WindowRegistrySource,
  WindowSnapshot,
} from '@deepseek-ai/dsh-window-registry'
import { describe, expect, it, vi } from 'vitest'
import ShellNavigationService, { DEFAULT_SHELL_NAVIGATION_BINDINGS } from '../src/index.ts'

const A = 'space:11111111-1111-1111-1111-111111111111' as SpaceId
const B = 'space:22222222-2222-2222-2222-222222222222' as SpaceId
const C = 'space:33333333-3333-3333-3333-333333333333' as SpaceId
const W1 = 'win_task_1' as WindowId
const W2 = 'win_task_2' as WindowId
const W3 = 'win_task_3' as WindowId

class FakeInput implements GlobalInputSource {
  private readonly bindings = new Map<string, NormalizedGlobalHotkeyBinding>()
  private readonly listeners = new Set<(event: GlobalHotkeyEvent) => void>()
  conflictId: string | undefined

  getCapabilities() {
    return {
      provider: 'win32-register-hot-key' as const,
      systemWideHotkeys: true,
      noRepeat: true,
      arbitraryKeyLogging: false as const,
    }
  }

  getBindings(): readonly NormalizedGlobalHotkeyBinding[] {
    return [...this.bindings.values()]
  }

  async register(binding: GlobalHotkeyBinding): Promise<NormalizedGlobalHotkeyBinding> {
    if (binding.id === this.conflictId) {
      const error = new Error('conflict') as Error & { code: string }
      error.code = 'HOTKEY_CONFLICT'
      throw error
    }
    const normalized: NormalizedGlobalHotkeyBinding = {
      id: binding.id,
      key: binding.key,
      virtualKey: binding.key.length === 1 ? binding.key.toUpperCase().charCodeAt(0) : 1,
      modifiers: {
        alt: binding.modifiers.alt === true,
        control: binding.modifiers.control === true,
        shift: binding.modifiers.shift === true,
        win: binding.modifiers.win === true,
      },
      noRepeat: binding.noRepeat !== false,
    }
    this.bindings.set(binding.id, normalized)
    return normalized
  }

  async unregister(bindingId: string): Promise<boolean> {
    return this.bindings.delete(bindingId)
  }

  subscribe(listener: (event: GlobalHotkeyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async reconcile(): Promise<void> {}

  fire(bindingId: string): void {
    const binding = this.bindings.get(bindingId)
    if (!binding) throw new Error(`missing fake binding ${bindingId}`)
    const event: GlobalHotkeyEvent = {
      bindingId,
      key: binding.key,
      virtualKey: binding.virtualKey,
      modifiers: binding.modifiers,
      sequence: 1,
      capturedAt: Date.now(),
    }
    for (const listener of [...this.listeners]) listener(event)
  }
}

class FakeSpaces implements SpacesSource {
  private current: SpaceId = A
  readonly switchSpace = vi.fn(async (spaceId: SpaceId) => {
    this.current = spaceId
    return this.getSnapshot()
  })

  getCapabilities(): SpacesCapabilities {
    return {
      provider: 'windows-shell-virtual-desktop',
      windowMembership: true,
      currentWindowMembership: true,
      moveWindow: true,
      enumerateSpaces: true,
      switchSpace: true,
      createSpace: true,
      removeSpace: true,
      renameSpace: true,
      nativeNotifications: true,
    }
  }

  getSnapshot(): SpacesSnapshot {
    const spaces: readonly ObservedSpaceSnapshot[] = [A, B, C].map((id, index) => ({
      id,
      index,
      name: `Desktop ${index + 1}`,
      windowIds: id === A ? [W1, W2, W3] : [],
      isCurrent: id === this.current,
    }))
    return {
      revision: 1,
      spaces,
      unresolvedWindowIds: [],
      currentSpaceId: this.current,
      capabilities: this.getCapabilities(),
      completeness: 'complete-shell-enumeration',
      capturedAt: Date.now(),
    }
  }

  getObservedSpaces() { return this.getSnapshot().spaces }
  getCurrentSpaceId() { return this.current }
  async getWindowSpace(): Promise<never> { throw new Error('unused') }
  async isWindowOnCurrentSpace(): Promise<never> { throw new Error('unused') }
  async moveWindowToSpace(): Promise<never> { throw new Error('unused') }
  async createSpace(): Promise<never> { throw new Error('unused') }
  async removeSpace(): Promise<never> { throw new Error('unused') }
  async renameSpace(): Promise<never> { throw new Error('unused') }
  async refresh() { return this.getSnapshot() }
  subscribe(): () => void { return () => undefined }
}

function taskWindow(id: WindowId, title: string, revision: number, foreground = false): WindowSnapshot {
  return {
    id,
    hwnd: 100 + revision,
    processId: 200 + revision,
    threadId: 300 + revision,
    processCreationTime: 400 + revision,
    executableName: `${title.toLowerCase()}.exe`,
    title,
    className: 'FakeWindow',
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    classification: 'APPLICATION',
    state: 'normal',
    isVisible: true,
    isMinimized: false,
    isMaximized: false,
    isCloaked: false,
    isToolWindow: false,
    isShellWindow: false,
    isEnabled: true,
    isForeground: foreground,
    firstSeen: 1000 + revision,
    updatedRevision: revision,
    generation: 1,
    capturedAt: Date.now(),
  }
}

class FakeRegistry implements WindowRegistrySource {
  private foregroundId: WindowId = W1
  private readonly windows = new Map<WindowId, WindowSnapshot>([
    [W1, taskWindow(W1, 'Browser', 3, true)],
    [W2, taskWindow(W2, 'Editor', 2)],
    [W3, taskWindow(W3, 'Notepad', 1)],
  ])

  setForeground(id: WindowId): void {
    this.foregroundId = id
    for (const [windowId, window] of this.windows) {
      this.windows.set(windowId, { ...window, isForeground: windowId === id })
    }
  }

  getSnapshot(): WindowRegistrySnapshot {
    return {
      generation: 1,
      revision: 1,
      windows: this.getWindows(),
      foregroundWindowId: this.foregroundId,
      capturedAt: Date.now(),
    }
  }

  getWindows(): readonly WindowSnapshot[] { return [...this.windows.values()] }
  getWindow(id: WindowId): WindowSnapshot | undefined { return this.windows.get(id) }
  getByHwnd(hwnd: number): WindowSnapshot | undefined { return this.getWindows().find(window => window.hwnd === hwnd) }
  getByProcessId(pid: number): readonly WindowSnapshot[] { return this.getWindows().filter(window => window.processId === pid) }
  getForegroundWindow(): WindowSnapshot | undefined { return this.windows.get(this.foregroundId) }
  getWindowsForMonitor(): readonly WindowSnapshot[] { return [] }
  async refresh(): Promise<WindowRegistrySnapshot> { return this.getSnapshot() }
  subscribe(): () => void { return () => undefined }
}

function fakeWindowControl(registry: FakeRegistry) {
  const activate = vi.fn(async (windowId: WindowId) => {
    registry.setForeground(windowId)
    return {
      windowId,
      action: 'activate' as const,
      hwnd: registry.getWindow(windowId)?.hwnd ?? 0,
      accepted: true,
      completed: true,
      observation: {
        exists: true,
        visible: true,
        minimized: false,
        maximized: false,
        foreground: true,
      },
    }
  })
  return {
    activate,
    source: { activate } as unknown as WindowControlSource,
  }
}

async function setup(input = new FakeInput(), spaces = new FakeSpaces()) {
  const ctx = new Context()
  const registry = new FakeRegistry()
  const control = fakeWindowControl(registry)
  await ctx.plugin(ShellNavigationService, {
    enabled: true,
    registerDefaultBindings: true,
    globalInput: input,
    spaces,
    windowRegistry: registry,
    windowControl: control.source,
  })
  await ctx.shellNavigation.initializeBindings()
  return { ctx, input, spaces, registry, control }
}

describe('ShellNavigationService', () => {
  it('uses portable arrows and explicit modifier chords for commit/cancel', () => {
    expect(DEFAULT_SHELL_NAVIGATION_BINDINGS.find(item => item.command === 'space.next')?.hotkey.key).toBe('ArrowRight')
    expect(DEFAULT_SHELL_NAVIGATION_BINDINGS.find(item => item.command === 'space.previous')?.hotkey.key).toBe('ArrowLeft')
    expect(DEFAULT_SHELL_NAVIGATION_BINDINGS.find(item => item.command === 'navigation.commit')?.hotkey.key).toBe('Enter')
    expect(DEFAULT_SHELL_NAVIGATION_BINDINGS.find(item => item.command === 'navigation.cancel')?.hotkey.key).toBe('Escape')
    expect(DEFAULT_SHELL_NAVIGATION_BINDINGS).toHaveLength(7)
  })

  it('switches next/previous Spaces through Phase 18A and wraps', async () => {
    const { ctx, spaces } = await setup()
    await ctx.shellNavigation.execute('space.previous')
    expect(spaces.getCurrentSpaceId()).toBe(C)
    await ctx.shellNavigation.execute('space.next')
    expect(spaces.getCurrentSpaceId()).toBe(A)
    expect(spaces.switchSpace).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('maps a global hotkey to a semantic Space command', async () => {
    const { ctx, input, spaces } = await setup()
    input.fire('shell-nav.space.next')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(spaces.getCurrentSpaceId()).toBe(B)
    await ctx.fiber.dispose()
  })

  it('selects real task candidates and commits the selected WindowId through Window Control', async () => {
    const { ctx, registry, control } = await setup()

    const first = await ctx.shellNavigation.execute('task-switcher.next')
    expect(first).toMatchObject({
      mode: 'task-switcher',
      taskSwitchOffset: 1,
      originalForegroundWindowId: W1,
      selectedWindowId: W2,
    })
    expect(first.taskCandidateIds).toEqual([W1, W2, W3])

    expect((await ctx.shellNavigation.execute('task-switcher.next')).selectedWindowId).toBe(W3)
    expect((await ctx.shellNavigation.execute('task-switcher.previous')).selectedWindowId).toBe(W2)

    const committed = await ctx.shellNavigation.executeLocalKey('Enter')
    expect(control.activate).toHaveBeenCalledWith(W2)
    expect(registry.getForegroundWindow()?.id).toBe(W2)
    expect(committed).toMatchObject({
      mode: 'idle',
      taskSwitchOffset: 0,
      lastCommand: 'navigation.commit',
    })
    expect(committed.taskCandidateIds).toEqual([])
    await ctx.fiber.dispose()
  })

  it('commits a task selection through a global modifier chord', async () => {
    const { ctx, input, registry, control } = await setup()
    input.fire('shell-nav.task-switcher.next')
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ctx.shellNavigation.getSnapshot().selectedWindowId).toBe(W2)

    input.fire('shell-nav.navigation.commit')
    await new Promise(resolve => setTimeout(resolve, 15))
    expect(control.activate).toHaveBeenCalledWith(W2)
    expect(registry.getForegroundWindow()?.id).toBe(W2)
    expect(ctx.shellNavigation.getSnapshot().mode).toBe('idle')
    await ctx.fiber.dispose()
  })

  it('cancels task switching without activating the selected candidate', async () => {
    const { ctx, registry, control } = await setup()
    expect((await ctx.shellNavigation.execute('task-switcher.next')).selectedWindowId).toBe(W2)
    const cancelled = await ctx.shellNavigation.executeLocalKey('Escape')
    expect(control.activate).not.toHaveBeenCalled()
    expect(registry.getForegroundWindow()?.id).toBe(W1)
    expect(cancelled).toMatchObject({ mode: 'idle', lastCommand: 'navigation.cancel' })
    await ctx.fiber.dispose()
  })

  it('keeps Overview UI-independent while toggle state is observable', async () => {
    const { ctx } = await setup()
    expect((await ctx.shellNavigation.execute('overview.toggle')).mode).toBe('overview')
    expect((await ctx.shellNavigation.execute('overview.toggle')).mode).toBe('idle')
    await ctx.fiber.dispose()
  })

  it('records one binding conflict without disabling the others', async () => {
    const input = new FakeInput()
    input.conflictId = 'shell-nav.overview.toggle'
    const { ctx } = await setup(input)
    const status = ctx.shellNavigation.getBindingStatuses()
    expect(status.find(item => item.bindingId === 'shell-nav.overview.toggle')?.state).toBe('conflict')
    expect(status.filter(item => item.state === 'registered')).toHaveLength(6)
    await ctx.fiber.dispose()
  })
})
