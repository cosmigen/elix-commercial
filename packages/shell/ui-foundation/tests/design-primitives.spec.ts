import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UI_PREFERENCES,
  generateUiFoundationCss,
  getUiPrimitiveContract,
  resolveDesignTokens,
  resolvePrimitiveKeyAction,
  resolveRovingFocusIndex,
  UI_PRIMITIVE_CONTRACTS,
} from '../src/index.ts'

describe('UI Foundation - design and interaction contracts', () => {
  it('resolves light, dark, and high-contrast semantic variants', () => {
    const base = {
      desired: DEFAULT_UI_PREFERENCES,
      applied: DEFAULT_UI_PREFERENCES,
      degradedReasons: [],
      scopeFallbacks: [],
    } as const

    expect(resolveDesignTokens({ ...base, resolvedColorScheme: 'dark' })['--elix-surface-background']).toBe('#090b10')
    expect(resolveDesignTokens({ ...base, resolvedColorScheme: 'light' })['--elix-surface-background']).toBe('#f4f6f8')
    expect(resolveDesignTokens({ ...base, resolvedColorScheme: 'high-contrast' })['--elix-focus-ring']).toBe('#ffff00')
  })

  it('contains contracts for every required shared primitive category', () => {
    expect(Object.keys(UI_PRIMITIVE_CONTRACTS).sort()).toEqual([
      'button', 'cancel', 'context-menu', 'dialog', 'empty', 'error', 'list', 'loading', 'menu', 'popover',
      'progress', 'search', 'segmented', 'sheet', 'slider', 'submenu', 'tabs', 'toast', 'toggle', 'tooltip',
    ].sort())
    expect(getUiPrimitiveContract('dialog')).toMatchObject({ role: 'dialog', restoresFocus: true, escapeDismisses: true })
    expect(getUiPrimitiveContract('tooltip').focusable).toBe(false)
  })

  it('normalizes keyboard activation, dismissal, and roving focus', () => {
    expect(resolvePrimitiveKeyAction('button', 'Enter')).toBe('activate')
    expect(resolvePrimitiveKeyAction('menu', 'Escape')).toBe('dismiss')
    expect(resolvePrimitiveKeyAction('menu', 'ArrowDown')).toBe('next')
    expect(resolveRovingFocusIndex(2, 3, 'next')).toBe(0)
    expect(resolveRovingFocusIndex(0, 3, 'previous')).toBe(2)
  })

  it('ships focus, disabled, high-contrast, and reduced-motion CSS behavior', () => {
    const css = generateUiFoundationCss()
    expect(css).toContain(':focus-visible')
    expect(css).toContain('aria-disabled')
    expect(css).toContain('forced-colors: active')
    expect(css).toContain('data-elix-reduce-motion')
    expect(css).toContain('.elix-tabs { display: flex; gap: var(--elix-space-1); overflow-x: auto;')
    expect(css).toContain('.elix-tab { min-height: var(--elix-hit-target); flex: 0 0 auto; white-space: nowrap;')
  })
})
