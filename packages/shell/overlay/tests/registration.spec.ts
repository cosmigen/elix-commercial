import { describe, expect, it } from 'vitest'
import { OverlayDefinitionRegistry } from '../src/definition-registry.ts'
import type { OverlayDefinition } from '../src/types.ts'
import { createTestEnvironment } from './test-utils.ts'

describe('Overlay Definition Registry', () => {
  const validDef: OverlayDefinition = {
    id: 'test-context-menu',
    ownerId: 'home',
    size: { width: 220, height: 320 },
    defaultPlacement: 'auto',
    focusPolicy: 'activate',
    renderer: {
      type: 'html',
      target: '<div class="menu">Context Menu</div>',
    },
    dismiss: {
      outsideClick: true,
      escape: true,
    },
  }

  it('registers and retrieves a valid definition', () => {
    const registry = new OverlayDefinitionRegistry()
    const disposer = registry.register(validDef)

    expect(registry.get('test-context-menu')).toEqual(validDef)
    expect(registry.list()).toHaveLength(1)

    disposer()
    expect(registry.get('test-context-menu')).toBeUndefined()
    expect(registry.list()).toHaveLength(0)
  })

  it('rejects empty or missing identifiers', () => {
    const registry = new OverlayDefinitionRegistry()

    expect(() => {
      registry.register({ ...validDef, id: '' })
    }).toThrow(/id must be a non-empty string/)

    expect(() => {
      registry.register({ ...validDef, ownerId: '' })
    }).toThrow(/ownerId must be a non-empty string/)
  })

  it('rejects non-positive dimensions', () => {
    const registry = new OverlayDefinitionRegistry()

    expect(() => {
      registry.register({ ...validDef, size: { width: 0, height: 100 } })
    }).toThrow(/must be positive/)

    expect(() => {
      registry.register({ ...validDef, size: { width: 100, height: -10 } })
    }).toThrow(/must be positive/)
  })

  describe('Security boundary and renderer validation', () => {
    it('accepts loopback HTTP, HTTPS, and about:blank URLs', () => {
      const registry = new OverlayDefinitionRegistry()

      registry.register({
        ...validDef,
        id: 'def-localhost',
        renderer: { type: 'url', target: 'http://localhost:5173/menu' },
      })
      registry.register({
        ...validDef,
        id: 'def-127',
        renderer: { type: 'url', target: 'http://127.0.0.1:8080' },
      })
      registry.register({
        ...validDef,
        id: 'def-blank',
        renderer: { type: 'url', target: 'about:blank' },
      })

      expect(registry.list()).toHaveLength(3)
    })

    it('rejects remote external URLs, file: URLs, and empty HTML targets', () => {
      const registry = new OverlayDefinitionRegistry()

      expect(() => {
        registry.register({
          ...validDef,
          renderer: { type: 'url', target: 'https://example.com' },
        })
      }).toThrow(/Security violation: non-loopback host/)

      expect(() => {
        registry.register({
          ...validDef,
          renderer: { type: 'url', target: 'file:///C:/windows/system32/calc.exe' },
        })
      }).toThrow(/Unsupported renderer URL protocol/)

      expect(() => {
        registry.register({
          ...validDef,
          renderer: { type: 'html', target: '   ' },
        })
      }).toThrow(/HTML target must not be empty/)
    })
  })

  describe('Ownership and conflict handling', () => {
    it('allows same owner to update or replace an existing definition', () => {
      const registry = new OverlayDefinitionRegistry()
      registry.register(validDef)

      const updatedDef: OverlayDefinition = {
        ...validDef,
        size: { width: 300, height: 400 },
      }
      registry.register(updatedDef)

      expect(registry.get('test-context-menu')?.size).toEqual({ width: 300, height: 400 })
      expect(registry.list()).toHaveLength(1)
    })

    it('rejects registration of an existing ID by a different owner', () => {
      const registry = new OverlayDefinitionRegistry()
      registry.register(validDef) // owner: 'home'

      expect(() => {
        registry.register({
          ...validDef,
          ownerId: 'status-bar', // conflict!
        })
      }).toThrow(/is already registered by owner 'home'. Owner 'status-bar' cannot claim it/)
    })

    it('prevents stale disposer from unregistering a newer version', () => {
      const registry = new OverlayDefinitionRegistry()
      const disposerV1 = registry.register(validDef)

      const disposerV2 = registry.register({
        ...validDef,
        size: { width: 280, height: 350 },
      })

      // Calling stale disposerV1 should NOT remove V2
      disposerV1()
      expect(registry.get('test-context-menu')).toBeDefined()
      expect(registry.get('test-context-menu')?.size.width).toBe(280)

      // Calling disposerV2 removes the definition
      disposerV2()
      expect(registry.get('test-context-menu')).toBeUndefined()
    })

    it('removes all definitions registered by a specific owner', () => {
      const registry = new OverlayDefinitionRegistry()

      registry.register({ ...validDef, id: 'home-menu-1', ownerId: 'home' })
      registry.register({ ...validDef, id: 'home-menu-2', ownerId: 'home' })
      registry.register({ ...validDef, id: 'dock-preview', ownerId: 'dock' })

      expect(registry.list()).toHaveLength(3)

      const removed = registry.removeByOwner('home')
      expect(removed).toEqual(['home-menu-1', 'home-menu-2'])
      expect(registry.list()).toHaveLength(1)
      expect(registry.get('dock-preview')).toBeDefined()
    })

    it('prevents stale disposer from unregistering newer definition or closing its instances in OverlayService', async () => {
      const { ctx } = await createTestEnvironment()
      const disposerV1 = ctx.overlay.register(validDef)

      const disposerV2 = ctx.overlay.register({
        ...validDef,
        size: { width: 300, height: 400 },
      })

      const inst = await ctx.overlay.open({
        definitionId: validDef.id,
        anchor: { type: 'point', x: 100, y: 100 },
      })
      expect(inst.state).toBe('OPEN')

      // Calling stale disposerV1 should NOT remove V2 or close its instances
      disposerV1()
      expect(ctx.overlay.getDefinition(validDef.id)).toBeDefined()
      expect(ctx.overlay.getActive()).toHaveLength(1)

      // Calling disposerV2 removes definition and closes instance
      disposerV2()
      expect(ctx.overlay.getDefinition(validDef.id)).toBeUndefined()
      expect(ctx.overlay.getActive()).toHaveLength(0)
    })
  })
})
