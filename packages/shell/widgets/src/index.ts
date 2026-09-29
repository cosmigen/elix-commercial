/**
 * @deepseek-ai/dsh-shell-widgets — ELIX OS Widget Runtime.
 *
 * Owns desktop widget definitions, instances, lifecycle, persistent state,
 * placement metadata, resize constraints, and Home surface integration.
 *
 * @module @deepseek-ai/dsh-shell-widgets
 */

import { WidgetService } from './service.ts'

export * from './types.ts'
export * from './definition-registry.ts'
export * from './instance-registry.ts'
export * from './renderer-registry.ts'
export * from './builtin-widgets.ts'
export * from './service.ts'

export const WidgetPlugin = WidgetService
export default WidgetService
