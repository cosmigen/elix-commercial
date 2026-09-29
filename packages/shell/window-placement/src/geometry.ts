import type { WindowPlacementConstraints } from '@deepseek-ai/dsh-window-control'
import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { PlacementAdjustment, PlacementZone } from './types.ts'

export type HorizontalAnchor = 'start' | 'center' | 'end'
export type VerticalAnchor = 'start' | 'center' | 'end'

export interface PlacementAnchor {
  readonly horizontal: HorizontalAnchor
  readonly vertical: VerticalAnchor
}

export interface ConstrainedPlacement {
  readonly rect: PhysicalPixelRect
  readonly adjustments: readonly PlacementAdjustment[]
  readonly rejectedNonresizable: boolean
}

function positive(value: number): number {
  return Math.max(1, Math.round(value))
}

export function rectNear(
  left: PhysicalPixelRect,
  right: PhysicalPixelRect,
  tolerance = 2,
): boolean {
  return Math.abs(left.x - right.x) <= tolerance
    && Math.abs(left.y - right.y) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance
}

export function computeZoneRect(
  workArea: PhysicalPixelRect,
  zone: PlacementZone,
  currentBounds: PhysicalPixelRect,
): { readonly rect: PhysicalPixelRect; readonly anchor: PlacementAnchor } {
  const leftWidth = Math.floor(workArea.width / 2)
  const rightWidth = workArea.width - leftWidth
  const topHeight = Math.floor(workArea.height / 2)
  const bottomHeight = workArea.height - topHeight
  const rightX = workArea.x + leftWidth
  const bottomY = workArea.y + topHeight

  switch (zone) {
    case 'left-half':
      return {
        rect: { x: workArea.x, y: workArea.y, width: leftWidth, height: workArea.height },
        anchor: { horizontal: 'start', vertical: 'center' },
      }
    case 'right-half':
      return {
        rect: { x: rightX, y: workArea.y, width: rightWidth, height: workArea.height },
        anchor: { horizontal: 'end', vertical: 'center' },
      }
    case 'top-half':
      return {
        rect: { x: workArea.x, y: workArea.y, width: workArea.width, height: topHeight },
        anchor: { horizontal: 'center', vertical: 'start' },
      }
    case 'bottom-half':
      return {
        rect: { x: workArea.x, y: bottomY, width: workArea.width, height: bottomHeight },
        anchor: { horizontal: 'center', vertical: 'end' },
      }
    case 'top-left-quarter':
      return {
        rect: { x: workArea.x, y: workArea.y, width: leftWidth, height: topHeight },
        anchor: { horizontal: 'start', vertical: 'start' },
      }
    case 'top-right-quarter':
      return {
        rect: { x: rightX, y: workArea.y, width: rightWidth, height: topHeight },
        anchor: { horizontal: 'end', vertical: 'start' },
      }
    case 'bottom-left-quarter':
      return {
        rect: { x: workArea.x, y: bottomY, width: leftWidth, height: bottomHeight },
        anchor: { horizontal: 'start', vertical: 'end' },
      }
    case 'bottom-right-quarter':
      return {
        rect: { x: rightX, y: bottomY, width: rightWidth, height: bottomHeight },
        anchor: { horizontal: 'end', vertical: 'end' },
      }
    case 'fill':
      return {
        rect: { ...workArea },
        anchor: { horizontal: 'center', vertical: 'center' },
      }
    case 'center':
      // Center is position-only. It never silently turns into a resize operation.
      return {
        rect: {
          x: workArea.x + Math.floor((workArea.width - currentBounds.width) / 2),
          y: workArea.y + Math.floor((workArea.height - currentBounds.height) / 2),
          width: currentBounds.width,
          height: currentBounds.height,
        },
        anchor: { horizontal: 'center', vertical: 'center' },
      }
  }
}

export function preserveOffsetRect(
  currentBounds: PhysicalPixelRect,
  sourceWorkArea: PhysicalPixelRect,
  targetWorkArea: PhysicalPixelRect,
): PhysicalPixelRect {
  // Preserve relative physical-pixel offset first. The caller applies DPI-aware accessibility
  // clamping exactly once after structural/app constraints have been negotiated.
  return {
    x: targetWorkArea.x + (currentBounds.x - sourceWorkArea.x),
    y: targetWorkArea.y + (currentBounds.y - sourceWorkArea.y),
    width: currentBounds.width,
    height: currentBounds.height,
  }
}

function anchoredCoordinate(
  start: number,
  originalSize: number,
  nextSize: number,
  anchor: 'start' | 'center' | 'end',
): number {
  if (anchor === 'start') return start
  if (anchor === 'end') return start + originalSize - nextSize
  return start + Math.floor((originalSize - nextSize) / 2)
}

export function constrainPlacementRect(
  requested: PhysicalPixelRect,
  currentBounds: PhysicalPixelRect,
  workArea: PhysicalPixelRect,
  constraints: WindowPlacementConstraints,
  anchor: PlacementAnchor,
  requiresResize: boolean,
  titleBarVisiblePx: number,
): ConstrainedPlacement {
  if (
    requiresResize
    && !constraints.resizable
    && (requested.width !== currentBounds.width || requested.height !== currentBounds.height)
  ) {
    return { rect: { ...currentBounds }, adjustments: [], rejectedNonresizable: true }
  }

  const adjustments: PlacementAdjustment[] = []
  let width = positive(requested.width)
  let height = positive(requested.height)

  // A pure move (center/move-to-monitor) must never manufacture a resize for a window that
  // does not expose a sizing frame. Resize policies still negotiate available app min/max data.
  if (constraints.resizable || requiresResize) {
    const minWidth = constraints.minTrackWidth
    const minHeight = constraints.minTrackHeight
    const maxWidth = constraints.maxTrackWidth
    const maxHeight = constraints.maxTrackHeight

    if (minWidth !== undefined && minWidth > 0 && width < minWidth) {
      width = minWidth
      adjustments.push('minimum-width')
    }
    if (minHeight !== undefined && minHeight > 0 && height < minHeight) {
      height = minHeight
      adjustments.push('minimum-height')
    }
    if (maxWidth !== undefined && maxWidth > 0 && width > maxWidth) {
      width = Math.max(minWidth ?? 1, maxWidth)
      adjustments.push('maximum-width')
    }
    if (maxHeight !== undefined && maxHeight > 0 && height > maxHeight) {
      height = Math.max(minHeight ?? 1, maxHeight)
      adjustments.push('maximum-height')
    }
  }

  let rect: PhysicalPixelRect = {
    x: anchoredCoordinate(requested.x, requested.width, width, anchor.horizontal),
    y: anchoredCoordinate(requested.y, requested.height, height, anchor.vertical),
    width,
    height,
  }

  const clamped = clampRectFullyOrAccessibly(rect, workArea, titleBarVisiblePx, titleBarVisiblePx * 2)
  if (!rectNear(rect, clamped, 0)) {
    adjustments.push('work-area-clamp')
    rect = clamped
  }

  return {
    rect,
    adjustments: Object.freeze([...new Set(adjustments)]),
    rejectedNonresizable: false,
  }
}

/**
 * Keep ordinary windows completely within the work area. Oversized constrained windows retain
 * an accessible title-bar strip and horizontal grab area instead of being blindly forced offscreen.
 */
export function clampRectFullyOrAccessibly(
  rect: PhysicalPixelRect,
  workArea: PhysicalPixelRect,
  titleBarVisiblePx: number,
  horizontalVisiblePx: number,
): PhysicalPixelRect {
  const titleVisible = Math.max(1, titleBarVisiblePx)
  const horizontalVisible = Math.max(1, horizontalVisiblePx)

  let x: number
  if (rect.width <= workArea.width) {
    x = Math.min(
      Math.max(rect.x, workArea.x),
      workArea.x + workArea.width - rect.width,
    )
  } else {
    const minX = workArea.x - rect.width + Math.min(horizontalVisible, workArea.width)
    const maxX = workArea.x + workArea.width - Math.min(horizontalVisible, workArea.width)
    x = Math.min(Math.max(rect.x, minX), maxX)
  }

  let y: number
  if (rect.height <= workArea.height) {
    y = Math.min(
      Math.max(rect.y, workArea.y),
      workArea.y + workArea.height - rect.height,
    )
  } else {
    const maxY = workArea.y + workArea.height - Math.min(titleVisible, workArea.height)
    y = Math.min(Math.max(rect.y, workArea.y), maxY)
  }

  return { x, y, width: rect.width, height: rect.height }
}
