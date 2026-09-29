/** Shared ELIX design-token resolver with light, dark, and accessibility variants. */

import type { UiResolvedPreferences } from './types.ts'

/** Foundation primitive tokens shared by every ELIX renderer. */
export const THEME_PRIMITIVE_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--elix-color-black': '#050608',
  '--elix-color-white': '#ffffff',
  '--elix-radius-sm': '4px',
  '--elix-radius-md': '8px',
  '--elix-radius-lg': '12px',
  '--elix-radius-xl': '14px',
  '--elix-radius-2xl': '18px',
  '--elix-radius-3xl': '26px',
  '--elix-radius-full': '9999px',
  '--elix-blur-sm': '8px',
  '--elix-blur-md': '12px',
  '--elix-blur-lg': '22px',
  '--elix-blur-xl': '48px',
  '--elix-font-ui': '"Segoe UI Variable", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, sans-serif',
  '--elix-font-mono': '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
  '--elix-text-xs': '12px',
  '--elix-text-sm': '13px',
  '--elix-text-md': '14px',
  '--elix-text-lg': '16px',
  '--elix-text-xl': '20px',
  '--elix-space-1': '4px',
  '--elix-space-2': '8px',
  '--elix-space-3': '12px',
  '--elix-space-4': '16px',
  '--elix-space-5': '20px',
  '--elix-space-6': '24px',
  '--elix-icon-sm': '16px',
  '--elix-icon-md': '20px',
  '--elix-icon-lg': '24px',
  '--elix-hit-target': '40px',
  '--elix-focus-ring-width': '2px',
  '--elix-motion-fast': '120ms',
  '--elix-motion-normal': '220ms',
  '--elix-motion-slow': '360ms',
  '--elix-ease-standard': 'cubic-bezier(0.16, 1, 0.3, 1)',
  '--elix-ease-spring': 'cubic-bezier(0.2, 0.84, 0.26, 1)',
  '--elix-ease-close': 'cubic-bezier(0.42, 0, 0.72, 0.18)',
})

/** Dark semantic token set preserving the current Home visual baseline. */
export const THEME_SEMANTIC_DARK_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--elix-surface-background': '#090b10',
  '--elix-surface-dim': 'var(--elix-color-black)',
  '--elix-surface-glass': 'rgba(15, 20, 32, 0.65)',
  '--elix-surface-glass-heavy': 'rgba(14, 16, 22, 0.74)',
  '--elix-surface-glass-hover': 'rgba(255, 255, 255, 0.08)',
  '--elix-surface-border': 'rgba(255, 255, 255, 0.12)',
  '--elix-surface-border-strong': 'rgba(255, 255, 255, 0.22)',
  '--elix-surface-border-subtle': 'rgba(255, 255, 255, 0.06)',
  '--elix-surface-shadow-sm': '0 4px 16px rgba(0, 0, 0, 0.25)',
  '--elix-surface-shadow-md': '0 16px 36px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.2)',
  '--elix-surface-shadow-lg': '0 32px 80px -12px rgba(0, 0, 0, 0.78), 0 1px 0 rgba(255,255,255,0.5) inset',
  '--elix-text-primary': '#f8fafc',
  '--elix-text-secondary': 'rgba(255, 255, 255, 0.65)',
  '--elix-text-muted': 'rgba(255, 255, 255, 0.45)',
  '--elix-accent': '#38bdf8',
  '--elix-accent-glow': 'rgba(56, 189, 248, 0.25)',
  '--elix-selection-background': 'rgba(56, 189, 248, 0.18)',
  '--elix-selection-border': 'rgba(56, 189, 248, 0.45)',
  '--elix-selection-shadow': 'var(--elix-surface-shadow-sm)',
  '--elix-focus-ring': 'var(--elix-accent)',
  '--elix-focus-ring-glow': 'var(--elix-accent-glow)',
  '--elix-danger': '#ef4444',
  '--elix-danger-hover': '#dc2626',
  '--elix-danger-bg': 'rgba(239, 68, 68, 0.14)',
  '--elix-warning': '#f59e0b',
  '--elix-success': '#22c55e',
  '--elix-disabled': 'rgba(255, 255, 255, 0.32)',
  '--elix-tooltip-background': '#111827',
  '--elix-tooltip-foreground': '#f8fafc',
  '--elix-divider': 'var(--elix-surface-border-subtle)',
})

/** Compatibility alias retained for existing Home imports. */
export const THEME_SEMANTIC_TOKENS = THEME_SEMANTIC_DARK_TOKENS

/** Light semantic token set. */
export const THEME_SEMANTIC_LIGHT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--elix-surface-background': '#f4f6f8',
  '--elix-surface-dim': '#e8ebef',
  '--elix-surface-glass': 'rgba(255, 255, 255, 0.78)',
  '--elix-surface-glass-heavy': 'rgba(255, 255, 255, 0.9)',
  '--elix-surface-glass-hover': 'rgba(15, 23, 42, 0.07)',
  '--elix-surface-border': 'rgba(15, 23, 42, 0.14)',
  '--elix-surface-border-strong': 'rgba(15, 23, 42, 0.25)',
  '--elix-surface-border-subtle': 'rgba(15, 23, 42, 0.08)',
  '--elix-surface-shadow-sm': '0 4px 16px rgba(15, 23, 42, 0.12)',
  '--elix-surface-shadow-md': '0 16px 36px rgba(15, 23, 42, 0.16)',
  '--elix-surface-shadow-lg': '0 30px 70px rgba(15, 23, 42, 0.22)',
  '--elix-text-primary': '#111827',
  '--elix-text-secondary': '#475569',
  '--elix-text-muted': '#64748b',
  '--elix-accent': '#0284c7',
  '--elix-accent-glow': 'rgba(2, 132, 199, 0.2)',
  '--elix-selection-background': 'rgba(2, 132, 199, 0.13)',
  '--elix-selection-border': 'rgba(2, 132, 199, 0.42)',
  '--elix-selection-shadow': 'var(--elix-surface-shadow-sm)',
  '--elix-focus-ring': '#0369a1',
  '--elix-focus-ring-glow': 'rgba(3, 105, 161, 0.18)',
  '--elix-danger': '#dc2626',
  '--elix-danger-hover': '#b91c1c',
  '--elix-danger-bg': 'rgba(220, 38, 38, 0.1)',
  '--elix-warning': '#b45309',
  '--elix-success': '#15803d',
  '--elix-disabled': 'rgba(15, 23, 42, 0.35)',
  '--elix-tooltip-background': '#111827',
  '--elix-tooltip-foreground': '#f8fafc',
  '--elix-divider': 'var(--elix-surface-border-subtle)',
})

/** Forced high-contrast semantic token set. */
export const THEME_SEMANTIC_HIGH_CONTRAST_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--elix-surface-background': '#000000',
  '--elix-surface-dim': '#000000',
  '--elix-surface-glass': '#000000',
  '--elix-surface-glass-heavy': '#000000',
  '--elix-surface-glass-hover': '#1a1a1a',
  '--elix-surface-border': '#ffffff',
  '--elix-surface-border-strong': '#ffffff',
  '--elix-surface-border-subtle': '#ffffff',
  '--elix-surface-shadow-sm': 'none',
  '--elix-surface-shadow-md': 'none',
  '--elix-surface-shadow-lg': 'none',
  '--elix-text-primary': '#ffffff',
  '--elix-text-secondary': '#ffffff',
  '--elix-text-muted': '#ffffff',
  '--elix-accent': '#00ffff',
  '--elix-accent-glow': 'transparent',
  '--elix-selection-background': '#000000',
  '--elix-selection-border': '#ffff00',
  '--elix-selection-shadow': 'none',
  '--elix-focus-ring': '#ffff00',
  '--elix-focus-ring-glow': 'transparent',
  '--elix-danger': '#ff8080',
  '--elix-danger-hover': '#ffffff',
  '--elix-danger-bg': '#000000',
  '--elix-warning': '#ffff00',
  '--elix-success': '#00ff00',
  '--elix-disabled': '#b3b3b3',
  '--elix-tooltip-background': '#000000',
  '--elix-tooltip-foreground': '#ffffff',
  '--elix-divider': '#ffffff',
})

/** Component tokens used by Home and future shell surfaces. */
export const THEME_COMPONENT_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  '--elix-home-background': 'var(--elix-surface-background)',
  '--elix-home-dim-background': 'var(--elix-surface-dim)',
  '--elix-home-empty-bg': 'var(--elix-surface-glass)',
  '--elix-home-empty-color': 'var(--elix-text-primary)',
  '--elix-home-empty-border': 'var(--elix-surface-border)',
  '--elix-home-selection-fill': 'var(--elix-selection-background)',
  '--elix-home-selection-border': 'var(--elix-selection-border)',
  '--elix-home-marquee-fill': 'var(--elix-home-selection-fill)',
  '--elix-home-marquee-border': 'var(--elix-home-selection-border)',
  '--elix-home-marquee-shadow': 'inset 0 0 16px rgba(56, 189, 248, 0.08)',
  '--elix-desktop-item-radius': 'var(--elix-radius-lg)',
  '--elix-desktop-item-label': 'var(--elix-text-primary)',
  '--elix-desktop-item-hover-bg': 'var(--elix-surface-glass-hover)',
  '--elix-desktop-item-hover-background': 'var(--elix-desktop-item-hover-bg)',
  '--elix-desktop-item-selected-bg': 'var(--elix-selection-background)',
  '--elix-desktop-item-selected-background': 'var(--elix-desktop-item-selected-bg)',
  '--elix-desktop-item-selected-border': 'var(--elix-selection-border)',
  '--elix-desktop-item-selected-shadow': 'var(--elix-selection-shadow)',
  '--elix-desktop-item-focus-border': 'var(--elix-focus-ring)',
  '--elix-desktop-item-focus-shadow': '0 0 0 2px var(--elix-focus-ring-glow)',
  '--elix-desktop-item-icon-radius': 'var(--elix-radius-xl)',
  '--elix-desktop-item-icon-bg': 'linear-gradient(145deg, rgba(255,255,255,.24), rgba(255,255,255,.06))',
  '--elix-desktop-item-icon-border': 'var(--elix-surface-border-strong)',
  '--elix-desktop-item-icon-shadow': 'var(--elix-surface-shadow-sm)',
  '--elix-desktop-item-shortcut-badge-bg': 'var(--elix-tooltip-background)',
  '--elix-desktop-item-shortcut-badge-color': 'var(--elix-accent)',
  '--elix-desktop-item-rename-bg': 'var(--elix-surface-glass-heavy)',
  '--elix-desktop-item-rename-border': 'var(--elix-accent)',
  '--elix-desktop-item-rename-color': 'var(--elix-text-primary)',
  '--elix-desktop-item-rename-shadow': '0 0 0 2px var(--elix-accent-glow)',
  '--elix-folder-tile-bg': 'linear-gradient(145deg, rgba(255,255,255,.18), rgba(255,255,255,.05))',
  '--elix-folder-tile-background': 'var(--elix-folder-tile-bg)',
  '--elix-folder-tile-border': 'var(--elix-surface-border)',
  '--elix-folder-tile-radius': 'var(--elix-radius-xl)',
  '--elix-folder-tile-shadow': 'var(--elix-surface-shadow-sm)',
  '--elix-folder-tile-blur': 'var(--elix-blur-md)',
  '--elix-folder-label-color': 'var(--elix-desktop-item-label)',
  '--elix-folder-overlay-backdrop': 'rgba(4, 6, 10, 0.42)',
  '--elix-folder-overlay-blur': '32px',
  '--elix-folder-overlay-background': 'var(--elix-surface-glass-heavy)',
  '--elix-folder-overlay-border': 'var(--elix-surface-border-strong)',
  '--elix-folder-overlay-radius': 'var(--elix-radius-3xl)',
  '--elix-folder-overlay-shadow': 'var(--elix-surface-shadow-lg)',
  '--elix-folder-overlay-window-blur': 'var(--elix-blur-xl)',
  '--elix-folder-title-color': 'var(--elix-text-primary)',
  '--elix-folder-title-hover-bg': 'var(--elix-surface-glass-hover)',
  '--elix-widget-background': 'var(--elix-surface-glass)',
  '--elix-widget-border': 'var(--elix-surface-border)',
  '--elix-widget-radius': 'var(--elix-radius-2xl)',
  '--elix-widget-shadow': 'var(--elix-surface-shadow-md)',
  '--elix-widget-blur': 'var(--elix-blur-lg)',
  '--elix-widget-title-color': 'var(--elix-text-secondary)',
  '--elix-widget-body-color': 'var(--elix-text-primary)',
  '--elix-folder-open-duration': 'var(--elix-motion-slow)',
  '--elix-folder-close-duration': '240ms',
  '--elix-folder-morph-easing': 'var(--elix-ease-standard)',
  '--elix-item-reorder-duration': 'var(--elix-motion-normal)',
  '--elix-ui-transition-fast': 'var(--elix-motion-fast)',
  '--elix-context-menu-bg': 'var(--elix-surface-glass-heavy)',
  '--elix-context-menu-border': 'var(--elix-surface-border)',
  '--elix-context-menu-radius': 'var(--elix-radius-md)',
  '--elix-context-menu-shadow': 'var(--elix-surface-shadow-md)',
  '--elix-context-menu-text': 'var(--elix-text-primary)',
  '--elix-context-menu-item-hover-bg': 'var(--elix-accent)',
})

/** Backward-compatible dark default token map. */
export const DEFAULT_THEME_TOKENS: Readonly<Record<string, string>> = Object.freeze({
  ...THEME_PRIMITIVE_TOKENS,
  ...THEME_SEMANTIC_DARK_TOKENS,
  ...THEME_COMPONENT_TOKENS,
})

/** Resolve complete design tokens for the current applied preference state. */
export function resolveDesignTokens(resolved: UiResolvedPreferences): Readonly<Record<string, string>> {
  const semantic = resolved.resolvedColorScheme === 'high-contrast'
    ? THEME_SEMANTIC_HIGH_CONTRAST_TOKENS
    : resolved.resolvedColorScheme === 'light'
      ? THEME_SEMANTIC_LIGHT_TOKENS
      : THEME_SEMANTIC_DARK_TOKENS
  const densityScale = resolved.applied.appearance.density === 'compact'
    ? 0.86
    : resolved.applied.appearance.density === 'comfortable'
      ? 1.14
      : 1
  const reduceMotion = resolved.applied.accessibility.reduceMotion
  const reduceTransparency = resolved.applied.accessibility.reduceTransparency || resolved.applied.appearance.material === 'opaque'
  const accent = resolved.applied.appearance.accentColor
  const surfaceBackground = semantic['--elix-surface-background'] ?? '#000000'
  const surfaceGlass = semantic['--elix-surface-glass'] ?? surfaceBackground
  const surfaceGlassHeavy = semantic['--elix-surface-glass-heavy'] ?? surfaceBackground

  return Object.freeze({
    ...THEME_PRIMITIVE_TOKENS,
    ...semantic,
    ...THEME_COMPONENT_TOKENS,
    '--elix-accent': accent,
    '--elix-focus-ring': resolved.resolvedColorScheme === 'high-contrast' ? '#ffff00' : accent,
    '--elix-text-scale': String(resolved.applied.accessibility.textScale),
    '--elix-density-scale': String(densityScale),
    '--elix-motion-intensity': String(reduceMotion ? 0 : resolved.applied.appearance.motionIntensity),
    '--elix-motion-fast': reduceMotion ? '0ms' : '120ms',
    '--elix-motion-normal': reduceMotion ? '0ms' : '220ms',
    '--elix-motion-slow': reduceMotion ? '0ms' : '360ms',
    '--elix-hit-target': resolved.applied.accessibility.largeHitTargets ? '48px' : '40px',
    '--elix-surface-glass': reduceTransparency ? surfaceBackground : surfaceGlass,
    '--elix-surface-glass-heavy': reduceTransparency ? surfaceBackground : surfaceGlassHeavy,
    '--elix-blur-sm': reduceTransparency ? '0px' : '8px',
    '--elix-blur-md': reduceTransparency ? '0px' : '12px',
    '--elix-blur-lg': reduceTransparency ? '0px' : '22px',
    '--elix-blur-xl': reduceTransparency ? '0px' : '48px',
    '--elix-focus-ring-width': resolved.applied.accessibility.alwaysShowFocus ? '3px' : '2px',
  })
}

/** Generate CSS declarations for backward-compatible Home token consumers. */
export function generateThemeTokensCss(overrides?: Readonly<Record<string, string>>): string {
  const merged = { ...DEFAULT_THEME_TOKENS, ...(overrides ?? {}) }
  return Object.entries(merged).map(([property, value]) => `${property}:${value};`).join('')
}
