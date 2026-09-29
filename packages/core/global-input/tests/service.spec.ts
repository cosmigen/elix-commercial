import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import GlobalInputService, {
  GlobalInputError,
  normalizeGlobalHotkeyBinding,
  type GlobalHotkeyEvent,
  type GlobalInputNativeAdapter,
  type NativeGlobalHotkeyRegistration,
  type NativeGlobalInputSnapshot,
  type NormalizedGlobalHotkeyBinding,
} from '../src/index.ts'

class FakeNativeAdapter implements GlobalInputNativeAdapter {
  generation = 1
  readonly registrations = new Map<string, NativeGlobalHotkeyRegistration>()
  readonly events: GlobalHotkeyEvent[] = []
  registerCalls = 0
  conflictId: string | undefined

  getGeneration(): number {
    return this.generation
  }

  async register(binding: NormalizedGlobalHotkeyBinding): Promise<NativeGlobalHotkeyRegistration> {
    this.registerCalls++
    if (binding.id === this.conflictId) {
      const error = new Error('already registered') as Error & { code: string }
      error.code = 'HOTKEY_CONFLICT'
      throw error
    }
    const registration = { bindingId: binding.id, nativeId: this.registerCalls, binding }
    this.registrations.set(binding.id, registration)
    return registration
  }

  async unregister(bindingId: string): Promise<boolean> {
    return this.registrations.delete(bindingId)
  }

  async snapshot(): Promise<NativeGlobalInputSnapshot> {
    return {
      provider: 'win32-register-hot-key',
      registrations: [...this.registrations.values()],
    }
  }

  async drainEvents(): Promise<readonly GlobalHotkeyEvent[]> {
    return this.events.splice(0)
  }

  restart(): void {
    this.generation++
    this.registrations.clear()
  }
}

async function setup(adapter = new FakeNativeAdapter()) {
  const ctx = new Context()
  ctx.plugin(GlobalInputService, { enabled: true, nativeAdapter: adapter, pollIntervalMs: 20 })
  await new Promise(resolve => setTimeout(resolve, 5))
  return { ctx, adapter }
}

describe('GlobalInputService', () => {
  it('normalizes supported keys and rejects bare global keys', () => {
    expect(normalizeGlobalHotkeyBinding({
      id: 'space.next',
      key: 'page-down',
      modifiers: { control: true, alt: true, shift: true },
    })).toMatchObject({
      id: 'space.next',
      key: 'PageDown',
      virtualKey: 0x22,
      noRepeat: true,
    })

    expect(() => normalizeGlobalHotkeyBinding({
      id: 'unsafe-bare',
      key: 'A',
      modifiers: {},
    })).toThrowError(GlobalInputError)
  })

  it('registers explicit bindings and deduplicates an identical idempotent request', async () => {
    const { ctx, adapter } = await setup()
    const spec = {
      id: 'overview.toggle',
      key: 'O',
      modifiers: { control: true, alt: true, shift: true },
    } as const

    const first = await ctx.globalInput.register(spec)
    const second = await ctx.globalInput.register(spec)
    expect(second).toBe(first)
    expect(adapter.registerCalls).toBe(1)
    expect(ctx.globalInput.getBindings()).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('surfaces native registration conflicts without poisoning unrelated bindings', async () => {
    const adapter = new FakeNativeAdapter()
    adapter.conflictId = 'conflict'
    const { ctx } = await setup(adapter)

    await expect(ctx.globalInput.register({
      id: 'conflict',
      key: 'O',
      modifiers: { control: true, alt: true, shift: true },
    })).rejects.toMatchObject({ code: 'HOTKEY_CONFLICT' })

    await expect(ctx.globalInput.register({
      id: 'healthy',
      key: 'K',
      modifiers: { control: true, alt: true, shift: true },
    })).resolves.toMatchObject({ id: 'healthy' })
    await ctx.fiber.dispose()
  })

  it('delivers only events for desired bindings', async () => {
    const { ctx, adapter } = await setup()
    await ctx.globalInput.register({
      id: 'task.next',
      key: 'J',
      modifiers: { control: true, alt: true, shift: true },
    })
    const listener = vi.fn()
    ctx.globalInput.subscribe(listener)

    adapter.events.push({
      bindingId: 'task.next',
      key: 'J',
      virtualKey: 0x4a,
      modifiers: { control: true, alt: true, shift: true, win: false },
      sequence: 1,
      capturedAt: Date.now(),
    })
    await new Promise(resolve => setTimeout(resolve, 35))
    expect(listener).toHaveBeenCalledTimes(1)
    await ctx.fiber.dispose()
  })

  it('restores desired bindings after a native-host generation change', async () => {
    const { ctx, adapter } = await setup()
    await ctx.globalInput.register({
      id: 'space.previous',
      key: 'PageUp',
      modifiers: { control: true, alt: true, shift: true },
    })
    expect(adapter.registrations.has('space.previous')).toBe(true)

    adapter.restart()
    await new Promise(resolve => setTimeout(resolve, 45))
    expect(adapter.registrations.has('space.previous')).toBe(true)
    expect(adapter.registerCalls).toBeGreaterThanOrEqual(2)
    await ctx.fiber.dispose()
  })
})
