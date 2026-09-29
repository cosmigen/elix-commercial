import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import UiFoundationService from '../src/index.ts'

class FakeHomeThemeConsumer extends Service {
  readonly updates: Record<string, string>[] = []

  constructor(ctx: Context) {
    super(ctx, 'home')
  }

  setThemeTokens(tokens: Record<string, string>): void {
    this.updates.push({ ...tokens })
  }
}

describe('UI Foundation - Home integration', () => {
  const roots: string[] = []
  const contexts: Context[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('pushes resolved tokens through Home existing hot-update API without recreating Home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elix-ui-home-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(FakeHomeThemeConsumer)
    const home = ctx.get('home') as unknown as FakeHomeThemeConsumer
    await ctx.plugin(UiFoundationService, {
      persistencePath: join(root, 'prefs.json'),
    })

    const initialCount = home.updates.length
    expect(initialCount).toBeGreaterThan(0)
    await ctx.uiFoundation.setUserPreferences({ appearance: { colorScheme: 'light' } })

    expect(home.updates.length).toBeGreaterThan(initialCount)
    expect(home.updates.at(-1)?.['--elix-surface-background']).toBe('#f4f6f8')
  })
})
