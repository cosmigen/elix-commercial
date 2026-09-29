/**
 * Authoritative Shell Layout Engine for computing per-monitor desktop work areas
 * and deterministic edge conflict resolution.
 *
 * @module @deepseek-ai/dsh-shell-layout/layout-engine
 */

import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type { MonitorLayoutState, ShellEdge, ShellReservation } from './types.ts'

const EDGES: readonly ShellEdge[] = ['top', 'bottom', 'left', 'right']

/**
 * Sorts edge reservations deterministically by priority descending,
 * with stable lexicographical id tie-breaking to eliminate registration-order dependency.
 */
export function sortReservationsDeterministically(
  reservations: readonly ShellReservation[],
): readonly ShellReservation[] {
  return [...reservations].sort((a, b) => {
    if (b.priority !== a.priority) {
      return b.priority - a.priority
    }
    return a.id.localeCompare(b.id)
  })
}

/**
 * Computes the reserved strip depth for an edge reservation.
 * Respects native-approved effective rectangle if present.
 */
export function getReservationDepth(reservation: ShellReservation): number {
  if (reservation.kind !== 'edge' || !reservation.edge) {
    return 0
  }
  const rect = reservation.effectiveRect ?? reservation.rect
  switch (reservation.edge) {
    case 'top':
    case 'bottom':
      return Math.max(0, rect.height)
    case 'left':
    case 'right':
      return Math.max(0, rect.width)
  }
}

/**
 * Derives the physical bounding rectangle for an edge reservation anchored to a specific monitor,
 * calculating coordinates from monitor bounds and reserved depth.
 */
export function deriveMonitorEdgeRect(
  edge: ShellEdge,
  depth: number,
  monitorBounds: PhysicalPixelRect,
): PhysicalPixelRect {
  const d = Math.max(0, depth)
  switch (edge) {
    case 'top':
      return {
        x: monitorBounds.x,
        y: monitorBounds.y,
        width: monitorBounds.width,
        height: d,
      }
    case 'bottom':
      return {
        x: monitorBounds.x,
        y: monitorBounds.y + monitorBounds.height - d,
        width: monitorBounds.width,
        height: d,
      }
    case 'left':
      return {
        x: monitorBounds.x,
        y: monitorBounds.y,
        width: d,
        height: monitorBounds.height,
      }
    case 'right':
      return {
        x: monitorBounds.x + monitorBounds.width - d,
        y: monitorBounds.y,
        width: d,
        height: monitorBounds.height,
      }
  }
}

/**
 * Computes how much of an ELIX edge reservation still needs to be
 * applied in software after accounting for the work-area boundary
 * already negotiated by Windows.
 */
export function getUnreflectedReservationDepth(
  reservation: ShellReservation,
  workArea: PhysicalPixelRect,
): number {
  if (
    reservation.kind !== 'edge' ||
    !reservation.edge ||
    !reservation.affectsWorkArea
  ) {
    return 0
  }

  const depth = getReservationDepth(reservation)
  if (depth <= 0) return 0

  const effective = reservation.effectiveRect
  if (!effective) return depth

  const workRight = workArea.x + workArea.width
  const workBottom = workArea.y + workArea.height
  const effectiveRight = effective.x + effective.width
  const effectiveBottom = effective.y + effective.height

  let reflectedDepth = 0

  switch (reservation.edge) {
    case 'top':
      reflectedDepth = workArea.y - effective.y
      break
    case 'bottom':
      reflectedDepth = effectiveBottom - workBottom
      break
    case 'left':
      reflectedDepth = workArea.x - effective.x
      break
    case 'right':
      reflectedDepth = effectiveRight - workRight
      break
  }

  const clampedReflectedDepth = Math.max(
    0,
    Math.min(depth, reflectedDepth),
  )

  return Math.max(0, depth - clampedReflectedDepth)
}

/** Computes authoritative layout state and work area for one monitor. */
export function computeMonitorLayout(
  monitorId: string,
  monitorBounds: PhysicalPixelRect,
  originalWorkArea: PhysicalPixelRect,
  reservations: readonly ShellReservation[],
  isFullscreenActive = false,
): MonitorLayoutState {
  const edgeThickness: Record<ShellEdge, number> = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  }

  const additionalEdgeThickness: Record<ShellEdge, number> = {
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  }

  const activeReservations: ShellReservation[] = []
  for (const reservation of reservations) {
    if (!reservation.visible) continue
    if (isFullscreenActive && reservation.suspendInFullscreen) continue

    if (reservation.monitorId === monitorId) {
      activeReservations.push(reservation)
    } else if (
      reservation.monitorId === 'all' &&
      reservation.kind === 'edge' &&
      reservation.edge
    ) {
      const depth = getReservationDepth(reservation)
      const derivedRect = deriveMonitorEdgeRect(
        reservation.edge,
        depth,
        monitorBounds,
      )
      activeReservations.push({
        ...reservation,
        monitorId,
        rect: derivedRect,
        ...(reservation.effectiveRect
          ? {
            effectiveRect: deriveMonitorEdgeRect(
              reservation.edge,
              getReservationDepth(reservation),
              monitorBounds,
            ),
          }
          : {}),
      })
    }
  }

  for (const edge of EDGES) {
    const onEdge = activeReservations.filter(
      reservation =>
        reservation.kind === 'edge' &&
        reservation.edge === edge &&
        reservation.affectsWorkArea,
    )
    const sorted = sortReservationsDeterministically(onEdge)
    let totalDepth = 0
    let additionalDepth = 0

    for (const reservation of sorted) {
      totalDepth += getReservationDepth(reservation)
      additionalDepth += getUnreflectedReservationDepth(
        reservation,
        originalWorkArea,
      )
    }

    edgeThickness[edge] = totalDepth
    additionalEdgeThickness[edge] = additionalDepth
  }

  let computedWorkArea: PhysicalPixelRect

  const totalDelta =
    additionalEdgeThickness.top +
    additionalEdgeThickness.bottom +
    additionalEdgeThickness.left +
    additionalEdgeThickness.right

  if (totalDelta === 0) {
    computedWorkArea = { ...originalWorkArea }
  } else {
    const startX = originalWorkArea.x + additionalEdgeThickness.left
    const startY = originalWorkArea.y + additionalEdgeThickness.top

    const availableWidth =
      originalWorkArea.width -
      additionalEdgeThickness.left -
      additionalEdgeThickness.right

    const availableHeight =
      originalWorkArea.height -
      additionalEdgeThickness.top -
      additionalEdgeThickness.bottom

    const clampedWidth = Math.max(0, availableWidth)
    const clampedHeight = Math.max(0, availableHeight)

    const maxX = monitorBounds.x + monitorBounds.width
    const maxY = monitorBounds.y + monitorBounds.height

    const clampedX = Math.max(monitorBounds.x, Math.min(maxX, startX))
    const clampedY = Math.max(monitorBounds.y, Math.min(maxY, startY))

    const finalWidth = Math.max(0, Math.min(clampedWidth, maxX - clampedX))
    const finalHeight = Math.max(0, Math.min(clampedHeight, maxY - clampedY))

    computedWorkArea = {
      x: clampedX,
      y: clampedY,
      width: finalWidth,
      height: finalHeight,
    }
  }

  return {
    monitorId,
    monitorBounds: { ...monitorBounds },
    originalWorkArea: { ...originalWorkArea },
    computedWorkArea,
    edgeThickness: Object.freeze(edgeThickness),
    reservations: Object.freeze([...activeReservations]),
    isFullscreenActive,
  }
}
