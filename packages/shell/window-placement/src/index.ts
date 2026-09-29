/**
 * @deepseek-ai/dsh-window-placement — Phase 17B manual window placement authority.
 *
 * Computes work-area-aware placement policy from stable WindowId, Shell Layout and
 * Windows Context state, then delegates all native mutation to Window Control.
 * Automatic tiling and drag-edge replacement are intentionally out of scope.
 *
 * @module @deepseek-ai/dsh-window-placement
 */

export * from './types.ts'
export * from './geometry.ts'
export * from './service.ts'

import { WindowPlacementService } from './service.ts'
export default WindowPlacementService
