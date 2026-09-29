/**
 * Anchor resolution and monitor selection engine for ELIX Overlay Core.
 *
 * Resolves cursor points, physical rectangles, and surface-relative rectangles
 * into canonical physical virtual-screen coordinates, and deterministically
 * selects the target monitor using point-containment or maximum-intersection area.
 *
 * @module @deepseek-ai/dsh-shell-overlay/anchor-resolver
 */

import type { PhysicalBounds } from '@deepseek-ai/dsh-surface'
import type { MonitorId, PhysicalPixelRect, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import type { OverlayAnchor } from './types.ts'

/** Synthetic default primary monitor used when no monitor topology is available. */
export const DEFAULT_SYNTHETIC_MONITOR: WindowsMonitor = {
  id: 'primary' as MonitorId,
  deviceName: 'DISPLAY1',
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  dpiX: 96,
  dpiY: 96,
  scaleFactor: 1.0,
  isPrimary: true,
}

/**
 * Resolves an OverlayAnchor into a canonical physical-pixel rectangle in virtual-screen coordinates.
 *
 * @param anchor - The abstract anchor specification.
 * @param getSurfaceBounds - Optional function to resolve parent/referent surface physical bounds.
 * @returns Physical pixel rectangle in virtual-screen coordinates.
 */
export function resolveAnchorRect(
  anchor: OverlayAnchor,
  getSurfaceBounds?: (surfaceId: string) => PhysicalBounds | undefined,
): PhysicalPixelRect {
  switch (anchor.type) {
    case 'point':
      return {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
        width: 0,
        height: 0,
      }

    case 'rect':
      return {
        x: Math.round(anchor.x),
        y: Math.round(anchor.y),
        width: Math.max(0, Math.round(anchor.width)),
        height: Math.max(0, Math.round(anchor.height)),
      }

    case 'surface-relative': {
      if (!getSurfaceBounds) {
        throw new Error('Cannot resolve surface-relative anchor: no surface bounds resolver provided.')
      }
      const parentBounds = getSurfaceBounds(anchor.surfaceId)
      if (!parentBounds) {
        throw new Error(`Surface '${anchor.surfaceId}' not found for surface-relative anchor.`)
      }
      return {
        x: Math.round(parentBounds.x + anchor.rect.x),
        y: Math.round(parentBounds.y + anchor.rect.y),
        width: Math.max(0, Math.round(anchor.rect.width)),
        height: Math.max(0, Math.round(anchor.rect.height)),
      }
    }
  }
}

/**
 * Deterministically selects the monitor associated with an anchor rectangle.
 *
 * - For point anchors (0 width & height): selects the monitor containing the point,
 *   or the closest monitor if outside all displays.
 * - For rectangular anchors: selects the monitor having the largest intersection area.
 *   If no intersection exists, selects the monitor closest to the anchor rectangle's center.
 *
 * @param anchorRect - Canonical physical rectangle in virtual-screen space.
 * @param monitors - Readonly array of connected Windows monitors.
 * @returns The authoritative selected WindowsMonitor.
 */
export function selectMonitor(
  anchorRect: PhysicalPixelRect,
  monitors: readonly WindowsMonitor[],
): WindowsMonitor {
  if (monitors.length === 0) {
    return DEFAULT_SYNTHETIC_MONITOR
  }

  // 1. Point anchor handling (width == 0 && height == 0)
  if (anchorRect.width === 0 && anchorRect.height === 0) {
    const px = anchorRect.x
    const py = anchorRect.y

    // Check direct containment
    for (const monitor of monitors) {
      const b = monitor.bounds
      if (px >= b.x && px < b.x + b.width && py >= b.y && py < b.y + b.height) {
        return monitor
      }
    }

    // Point outside all monitors: choose closest monitor to point
    const firstMonitor = monitors[0]
    if (!firstMonitor) return DEFAULT_SYNTHETIC_MONITOR
    let closestMonitor = firstMonitor
    let minDistance = Number.POSITIVE_INFINITY

    for (const monitor of monitors) {
      const b = monitor.bounds
      const cx = b.x + b.width / 2
      const cy = b.y + b.height / 2
      const dist = Math.hypot(cx - px, cy - py)
      if (dist < minDistance || (dist === minDistance && monitor.isPrimary)) {
        minDistance = dist
        closestMonitor = monitor
      }
    }

    return closestMonitor
  }

  // 2. Rectangular anchor handling (width > 0 or height > 0)
  let bestMonitor: WindowsMonitor | null = null
  let maxArea = 0

  for (const monitor of monitors) {
    const b = monitor.bounds
    const ix = Math.max(b.x, anchorRect.x)
    const iy = Math.max(b.y, anchorRect.y)
    const iw = Math.max(0, Math.min(b.x + b.width, anchorRect.x + anchorRect.width) - ix)
    const ih = Math.max(0, Math.min(b.y + b.height, anchorRect.y + anchorRect.height) - iy)
    const area = iw * ih

    if (area > maxArea) {
      maxArea = area
      bestMonitor = monitor
    } else if (area === maxArea && area > 0 && monitor.isPrimary && !bestMonitor?.isPrimary) {
      bestMonitor = monitor
    }
  }

  if (bestMonitor && maxArea > 0) {
    return bestMonitor
  }

  // If no intersection at all, find closest monitor to rectangle center
  const anchorCenterX = anchorRect.x + anchorRect.width / 2
  const anchorCenterY = anchorRect.y + anchorRect.height / 2

  const fallbackMonitor = monitors[0]
  if (!fallbackMonitor) return DEFAULT_SYNTHETIC_MONITOR
  let closestMonitor = fallbackMonitor
  let minDistance = Number.POSITIVE_INFINITY

  for (const monitor of monitors) {
    const b = monitor.bounds
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const dist = Math.hypot(cx - anchorCenterX, cy - anchorCenterY)
    if (dist < minDistance || (dist === minDistance && monitor.isPrimary)) {
      minDistance = dist
      closestMonitor = monitor
    }
  }

  return closestMonitor
}
