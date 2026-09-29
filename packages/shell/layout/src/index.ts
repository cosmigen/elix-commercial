/**
 * @deepseek-ai/dsh-shell-layout — Authoritative ELIX OS Shell Layout capability.
 *
 * Owns shell reservation geometry, per-monitor work-area calculation,
 * deterministic conflict handling, Home exclusion publication, native AppBar
 * synchronization, recovery evidence, and replacement authorization policy.
 *
 * @module @deepseek-ai/dsh-shell-layout
 */

export * from './types.ts'
export * from './reservation-registry.ts'
export * from './layout-engine.ts'
export * from './home-publisher.ts'
export * from './native-work-area-sync.ts'
export * from './recovery-journal.ts'
export * from './replacement-policy.ts'
export * from './service.ts'

import { ShellLayoutService } from './service.ts'
export default ShellLayoutService
