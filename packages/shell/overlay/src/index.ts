/**
 * @deepseek-ai/dsh-shell-overlay — Authoritative ELIX OS Overlay Core capability.
 *
 * Owns temporary shell surfaces such as context menus, flyouts, anchored panels,
 * Dock previews, Status Bar flyouts, Quick Settings panels, transient AI panels,
 * and nested submenus with deterministic placement, monitor selection, stacking,
 * focus policy, dismissal, and safe multi-owner cleanup.
 *
 * @module @deepseek-ai/dsh-shell-overlay
 */

export * from './types.ts'
export * from './anchor-resolver.ts'
export * from './placement-engine.ts'
export * from './definition-registry.ts'
export * from './instance-registry.ts'
export * from './service.ts'

import { OverlayService } from './service.ts'
export default OverlayService
