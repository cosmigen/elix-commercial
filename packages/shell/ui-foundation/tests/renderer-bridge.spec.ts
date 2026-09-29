import { describe, expect, it } from 'vitest'
import {
  createUiFoundationRendererBridgeScript,
  createUiFoundationStateMessage,
  DEFAULT_UI_PREFERENCES,
} from '../src/index.ts'

describe('UI Foundation - renderer bridge', () => {
  it('serializes only renderer-facing shared state', () => {
    const message = createUiFoundationStateMessage({
      revision: 7,
      resolved: {
        desired: DEFAULT_UI_PREFERENCES,
        applied: DEFAULT_UI_PREFERENCES,
        resolvedColorScheme: 'dark',
        degradedReasons: [],
        scopeFallbacks: [],
      },
      tokens: { '--elix-accent': '#38bdf8' },
    })

    expect(message).toEqual({
      type: 'elix/ui-foundation/state',
      revision: 7,
      resolvedColorScheme: 'dark',
      density: 'standard',
      reduceMotion: false,
      tokens: { '--elix-accent': '#38bdf8' },
    })
    expect(JSON.stringify(message)).not.toMatch(/hwnd|pid|notification/i)
  })

  it('installs WebView2 state application and system media reporting', () => {
    const script = createUiFoundationRendererBridgeScript()
    expect(script).toContain('elix/ui-foundation/state')
    expect(script).toContain('elix/ui-foundation/system-appearance')
    expect(script).toContain('prefers-color-scheme: light')
    expect(script).toContain('forced-colors: active')
    expect(script).toContain('prefers-reduced-motion: reduce')
    expect(script).toContain('root.style.setProperty')
  })
})
