/**
 * Deterministic Placement Engine for ELIX Overlay Core.
 *
 * Implements deterministic popup placement with strict separation between:
 * - Placement preference (primary direction and alignment)
 * - Auto-placement (selection based on available monitor space)
 * - Flip (switching to opposite edge when insufficient room exists)
 * - Shift (sliding along the edge axis to remain fully visible)
 * - Clamp (ensuring absolute boundary safety within available work area/bounds)
 *
 * @module @deepseek-ai/dsh-shell-overlay/placement-engine
 */

import type { PhysicalBounds } from '@deepseek-ai/dsh-surface'
import type { PhysicalPixelRect, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import type { OverlayPlacement, OverlaySize, PlacementResult } from './types.ts'

/** Options controlling deterministic placement calculation. */
export interface PlacementOptions {
  /** Canonical physical rectangle of the anchor in virtual-screen coordinates. */
  readonly anchorRect: PhysicalPixelRect
  /** Target dimensions and size constraints for the popup. */
  readonly size: OverlaySize
  /** Requested placement preference (defaulting to 'auto'). */
  readonly requestedPlacement?: OverlayPlacement | undefined
  /** Margin gap offset in physical pixels between the anchor and popup surface. */
  readonly offset?: number | undefined
  /** Usable bounding box within which the overlay must stay. */
  readonly availableBounds: PhysicalPixelRect
  /** Authoritative target monitor. */
  readonly monitor: WindowsMonitor
}

type Side = 'top' | 'bottom' | 'left' | 'right'
type Alignment = 'start' | 'end' | 'center'

interface ParsedPlacement {
  readonly side: Side
  readonly align: Alignment
}

/**
 * Parses an OverlayPlacement string into its constituent side and alignment components.
 *
 * @param placement - The placement string.
 * @returns Parsed side and alignment.
 */
function parsePlacement(placement: OverlayPlacement): ParsedPlacement {
  if (placement === 'auto') {
    return { side: 'bottom', align: 'start' }
  }

  const [sideStr, alignStr] = placement.split('-') as [Side, string | undefined]
  const align: Alignment = alignStr === 'start' || alignStr === 'end' ? alignStr : 'center'
  return { side: sideStr, align }
}

/**
 * Constructs an OverlayPlacement identifier from side and alignment.
 *
 * @param side - The placement side.
 * @param align - The alignment along the side.
 * @returns Combined OverlayPlacement string.
 */
function formatPlacement(side: Side, align: Alignment): OverlayPlacement {
  if (align === 'center') return side
  return `${side}-${align}`
}

/**
 * Determines the optimal side when 'auto' placement is requested.
 *
 * Checks available room in all four directions. By default for shell popups/menus:
 * prefers below (bottom-start), then above (top-start), then right (right-start),
 * then left (left-start), falling back to whichever vertical side has greater room.
 *
 * @param anchor - Canonical physical anchor rectangle.
 * @param width - Popup width.
 * @param height - Popup height.
 * @param offset - Gap offset.
 * @param bounds - Available boundary rectangle.
 * @returns Optimal side for placement.
 */
function resolveAutoSide(
  anchor: PhysicalPixelRect,
  width: number,
  height: number,
  offset: number,
  bounds: PhysicalPixelRect,
): Side {
  const minX = bounds.x
  const minY = bounds.y
  const maxX = bounds.x + bounds.width
  const maxY = bounds.y + bounds.height

  const spaceBelow = maxY - (anchor.y + anchor.height + offset)
  const spaceAbove = (anchor.y - offset) - minY
  const spaceRight = maxX - (anchor.x + anchor.width + offset)
  const spaceLeft = (anchor.x - offset) - minX

  if (spaceBelow >= height) return 'bottom'
  if (spaceAbove >= height) return 'top'
  if (spaceRight >= width) return 'right'
  if (spaceLeft >= width) return 'left'

  return spaceBelow >= spaceAbove ? 'bottom' : 'top'
}

/**
 * Computes deterministic physical bounds and placement results for an overlay.
 *
 * Guarantees that the returned physical rectangle is completely contained within
 * `availableBounds`, applying flip, shift, and clamp in strict deterministic order.
 *
 * @param options - Placement computation inputs.
 * @returns Authoritative PlacementResult.
 */
export function computePlacement(options: PlacementOptions): PlacementResult {
  const {
    anchorRect,
    size,
    requestedPlacement = 'auto',
    offset = 4,
    availableBounds,
    monitor,
  } = options

  // 1. Resolve target width and height within size constraints
  let targetWidth = Math.round(size.width)
  let targetHeight = Math.round(size.height)

  if (size.minWidth !== undefined) targetWidth = Math.max(targetWidth, Math.round(size.minWidth))
  if (size.maxWidth !== undefined) targetWidth = Math.min(targetWidth, Math.round(size.maxWidth))
  if (size.minHeight !== undefined) targetHeight = Math.max(targetHeight, Math.round(size.minHeight))
  if (size.maxHeight !== undefined) targetHeight = Math.min(targetHeight, Math.round(size.maxHeight))

  let clamped = false

  // Clamp sizes if they exceed the entire available region
  if (targetWidth > availableBounds.width) {
    targetWidth = availableBounds.width
    clamped = true
  }
  if (targetHeight > availableBounds.height) {
    targetHeight = availableBounds.height
    clamped = true
  }

  const minX = availableBounds.x
  const minY = availableBounds.y
  const maxX = availableBounds.x + availableBounds.width
  const maxY = availableBounds.y + availableBounds.height

  const ax = anchorRect.x
  const ay = anchorRect.y
  const aw = anchorRect.width
  const ah = anchorRect.height

  // 2. Resolve initial side and alignment
  let side: Side
  let align: Alignment

  if (requestedPlacement === 'auto') {
    side = resolveAutoSide(anchorRect, targetWidth, targetHeight, offset, availableBounds)
    align = 'start'
  } else {
    const parsed = parsePlacement(requestedPlacement)
    side = parsed.side
    align = parsed.align
  }

  // 3. Calculate initial coordinates
  let x = 0
  let y = 0

  switch (side) {
    case 'top':
      y = ay - offset - targetHeight
      break
    case 'bottom':
      y = ay + ah + offset
      break
    case 'left':
      x = ax - offset - targetWidth
      break
    case 'right':
      x = ax + aw + offset
      break
  }

  // Calculate cross-axis alignment
  if (side === 'top' || side === 'bottom') {
    switch (align) {
      case 'start':
        x = ax
        break
      case 'end':
        x = ax + aw - targetWidth
        break
      case 'center':
        x = ax + Math.round((aw - targetWidth) / 2)
        break
    }
  } else {
    switch (align) {
      case 'start':
        y = ay
        break
      case 'end':
        y = ay + ah - targetHeight
        break
      case 'center':
        y = ay + Math.round((ah - targetHeight) / 2)
        break
    }
  }

  let flipped = false
  let effectiveSide = side

  // 4. Flip: check if primary axis overflows and opposite side provides better/sufficient room
  if (side === 'bottom') {
    if (y + targetHeight > maxY) {
      const spaceAbove = (ay - offset) - minY
      const spaceBelow = maxY - (ay + ah + offset)
      if (spaceAbove >= targetHeight || spaceAbove > spaceBelow) {
        y = ay - offset - targetHeight
        effectiveSide = 'top'
        flipped = true
      }
    }
  } else if (side === 'top') {
    if (y < minY) {
      const spaceBelow = maxY - (ay + ah + offset)
      const spaceAbove = (ay - offset) - minY
      if (spaceBelow >= targetHeight || spaceBelow > spaceAbove) {
        y = ay + ah + offset
        effectiveSide = 'bottom'
        flipped = true
      }
    }
  } else if (side === 'right') {
    if (x + targetWidth > maxX) {
      const spaceLeft = (ax - offset) - minX
      const spaceRight = maxX - (ax + aw + offset)
      if (spaceLeft >= targetWidth || spaceLeft > spaceRight) {
        x = ax - offset - targetWidth
        effectiveSide = 'left'
        flipped = true
      }
    }
  } else {
    if (x < minX) {
      const spaceRight = maxX - (ax + aw + offset)
      const spaceLeft = (ax - offset) - minX
      if (spaceRight >= targetWidth || spaceRight > spaceLeft) {
        x = ax + aw + offset
        effectiveSide = 'right'
        flipped = true
      }
    }
  }

  // 5. Shift: slide along the cross-axis to stay within available bounds
  let shifted = false

  if (effectiveSide === 'top' || effectiveSide === 'bottom') {
    if (x + targetWidth > maxX) {
      x = maxX - targetWidth
      shifted = true
    }
    if (x < minX) {
      x = minX
      shifted = true
    }
  } else {
    if (y + targetHeight > maxY) {
      y = maxY - targetHeight
      shifted = true
    }
    if (y < minY) {
      y = minY
      shifted = true
    }
  }

  // 6. Clamp: final safety boundary check
  const finalX = Math.max(minX, Math.min(x, maxX - targetWidth))
  const finalY = Math.max(minY, Math.min(y, maxY - targetHeight))

  if (finalX !== x || finalY !== y) {
    clamped = true
  }

  x = finalX
  y = finalY

  const finalBounds: PhysicalBounds = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(targetWidth),
    height: Math.round(targetHeight),
  }

  const effectivePlacement = formatPlacement(effectiveSide, align)

  return {
    bounds: finalBounds,
    effectivePlacement,
    flipped,
    shifted,
    clamped,
    monitor,
    availableBounds,
  }
}
