/**
 * In-memory reservation registry for ELIX Shell Layout with stale-disposer protection.
 *
 * @module @deepseek-ai/dsh-shell-layout/reservation-registry
 */

import type { PhysicalPixelRect } from '@deepseek-ai/dsh-windows-context'
import type {
  ShellReservation,
  ShellReservationHandle,
  ShellReservationSpec,
  ShellReservationUpdate,
} from './types.ts'

interface RegistryEntry {
  readonly reservation: ShellReservation
  readonly token: symbol
}

/**
 * Validates coordinate bounding rectangle.
 */
export function validatePhysicalRect(rect: PhysicalPixelRect, context: string): void {
  if (
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height)
  ) {
    throw new TypeError(`Invalid ${context} rect: all coordinates and dimensions must be finite numbers.`)
  }
  if (rect.width < 0 || rect.height < 0) {
    throw new RangeError(`Invalid ${context} rect: width and height cannot be negative.`)
  }
}

/**
 * Validates a reservation specification.
 */
export function validateReservationSpec(spec: ShellReservationSpec): void {
  if (!spec.id || typeof spec.id !== 'string' || spec.id.trim().length === 0) {
    throw new TypeError('Reservation "id" must be a non-empty string.')
  }
  if (!spec.monitorId || typeof spec.monitorId !== 'string' || spec.monitorId.trim().length === 0) {
    throw new TypeError('Reservation "monitorId" must be a non-empty string.')
  }
  if (!spec.ownerId || typeof spec.ownerId !== 'string' || spec.ownerId.trim().length === 0) {
    throw new TypeError('Reservation "ownerId" must be a non-empty string.')
  }
  if (
    spec.ownerGeneration !== undefined &&
    (!Number.isSafeInteger(spec.ownerGeneration) || spec.ownerGeneration < 0)
  ) {
    throw new RangeError('Reservation "ownerGeneration" must be a non-negative safe integer.')
  }
  if (spec.kind === 'edge' && !spec.edge) {
    throw new TypeError(`Edge reservation "${spec.id}" requires a valid "edge" ('top' | 'bottom' | 'left' | 'right').`)
  }
  if (spec.kind === 'floating' && spec.monitorId === 'all') {
    throw new TypeError(
      `Floating reservation "${spec.id}" cannot use monitorId "all"; floating reservations must target an explicit monitor.`,
    )
  }
  validatePhysicalRect(spec.rect, `reservation "${spec.id}"`)
}

/**
 * Normalizes a reservation specification with repository-consistent defaults.
 */
export function normalizeReservation(
  spec: ShellReservationSpec,
  existing?: ShellReservation,
): ShellReservation {
  const now = Date.now()
  const createdAt = existing?.createdAt ?? now
  const affectsWorkArea = spec.affectsWorkArea ?? (spec.kind === 'edge')
  const affectsHomeLayout = spec.affectsHomeLayout ?? true
  const visible = spec.visible ?? true
  const priority = spec.priority ?? 0
  const ownerGeneration = spec.ownerGeneration ?? existing?.ownerGeneration ?? 0
  const conflictPolicy = spec.conflictPolicy ?? existing?.conflictPolicy ?? 'stack'
  const suspendInFullscreen = spec.suspendInFullscreen ?? existing?.suspendInFullscreen ?? true

  return {
    id: spec.id.trim(),
    monitorId: spec.monitorId.trim(),
    ownerId: spec.ownerId.trim(),
    ownerGeneration,
    kind: spec.kind,
    rect: { ...spec.rect },
    ...(existing?.effectiveRect ? { effectiveRect: existing.effectiveRect } : {}),
    ...(spec.kind === 'edge' && spec.edge ? { edge: spec.edge } : {}),
    affectsWorkArea,
    affectsHomeLayout,
    visible,
    priority,
    conflictPolicy,
    suspendInFullscreen,
    ...(spec.hwnd !== undefined ? { hwnd: spec.hwnd } : {}),
    createdAt,
    updatedAt: now,
  }
}

/**
 * Thread-safe deterministic reservation registry with stale-disposer protection.
 */
export class ReservationRegistry {
  private readonly entries = new Map<string, RegistryEntry>()

  /**
   * Registers a new reservation or replaces an existing one with the same ID.
   *
   * @param spec - Reservation specification.
   * @param onMutated - Callback triggered when update or remove occurs via handle.
   * @returns Object containing the committed reservation and safe handle.
   */
  register(
    spec: ShellReservationSpec,
    onMutated?: (action: 'updated' | 'removed', reservation: ShellReservation) => void,
  ): {
    reservation: ShellReservation
    handle: ShellReservationHandle
    isReplacement: boolean
    previousReservation?: ShellReservation | undefined
  } {
    validateReservationSpec(spec)

    const existing = this.entries.get(spec.id)?.reservation
    const incomingGeneration = spec.ownerGeneration ?? existing?.ownerGeneration ?? 0

    if (
      existing &&
      spec.ownerGeneration !== undefined &&
      existing.ownerId === spec.ownerId &&
      incomingGeneration < existing.ownerGeneration
    ) {
      throw new Error(
        `Cannot replace shell reservation "${spec.id}" with stale owner generation ${incomingGeneration}; current generation is ${existing.ownerGeneration}.`,
      )
    }

    const isReplacement = existing !== undefined
    const reservation = normalizeReservation(spec, existing)
    const token = Symbol(spec.id)

    this.entries.set(spec.id, { reservation, token })

    const handle: ShellReservationHandle = {
      id: reservation.id,
      ownerId: reservation.ownerId,
      ownerGeneration: reservation.ownerGeneration,
      get: () => {
        const current = this.entries.get(reservation.id)
        return current !== undefined && current.token === token ? current.reservation : undefined
      },
      update: (patch: ShellReservationUpdate) => {
        const current = this.entries.get(reservation.id)
        if (current === undefined || current.token !== token) {
          throw new Error(
            `Cannot update shell reservation "${reservation.id}" via stale or replaced handle.`,
          )
        }
        const updated = this.update(reservation.id, patch)
        onMutated?.('updated', updated)
        return updated
      },
      dispose: () => {
        const current = this.entries.get(reservation.id)
        if (current !== undefined && current.token === token) {
          this.entries.delete(reservation.id)
          onMutated?.('removed', current.reservation)
          return true
        }
        return false
      },
    }

    return { reservation, handle, isReplacement, previousReservation: existing }
  }

  /**
   * Updates an existing reservation with partial properties.
   */
  update(id: string, patch: ShellReservationUpdate): ShellReservation {
    const existing = this.entries.get(id)
    if (existing === undefined) {
      throw new Error(`Cannot update non-existent shell reservation "${id}".`)
    }

    const unsafePatch = patch as Record<string, unknown>
    if ('ownerId' in unsafePatch || 'ownerGeneration' in unsafePatch) {
      throw new Error(`Cannot mutate lease identity for shell reservation "${id}".`)
    }

    const mergedSpec: ShellReservationSpec = {
      ...existing.reservation,
      ...patch,
      id,
      ownerId: existing.reservation.ownerId,
      ownerGeneration: existing.reservation.ownerGeneration,
      rect: patch.rect ? { ...patch.rect } : existing.reservation.rect,
    }

    validateReservationSpec(mergedSpec)
    const updated = normalizeReservation(mergedSpec, existing.reservation)
    this.entries.set(id, { reservation: updated, token: existing.token })
    return updated
  }

  /**
   * Reconciles the native approved rectangle into an existing reservation
   * without altering the desired specification or invalidating handles.
   */
  setEffectiveRect(id: string, effectiveRect: PhysicalPixelRect): ShellReservation | undefined {
    const entry = this.entries.get(id)
    if (!entry) return undefined

    const current = entry.reservation
    if (
      current.effectiveRect &&
      current.effectiveRect.x === effectiveRect.x &&
      current.effectiveRect.y === effectiveRect.y &&
      current.effectiveRect.width === effectiveRect.width &&
      current.effectiveRect.height === effectiveRect.height
    ) {
      return current
    }

    validatePhysicalRect(effectiveRect, `reservation "${id}" effective rect`)

    const updated: ShellReservation = {
      ...current,
      effectiveRect: { ...effectiveRect },
      updatedAt: Date.now(),
    }

    this.entries.set(id, { reservation: updated, token: entry.token })
    return updated
  }

  /** Removes a reservation by ID. */
  remove(id: string): { removed: boolean; reservation?: ShellReservation } {
    const existing = this.entries.get(id)
    if (existing === undefined) {
      return { removed: false }
    }
    this.entries.delete(id)
    return { removed: true, reservation: existing.reservation }
  }

  /** Removes reservations owned by exactly one owner generation. */
  removeOwner(ownerId: string, ownerGeneration: number): readonly ShellReservation[] {
    const removed: ShellReservation[] = []
    for (const [id, entry] of this.entries) {
      const reservation = entry.reservation
      if (
        reservation.ownerId === ownerId &&
        reservation.ownerGeneration === ownerGeneration
      ) {
        this.entries.delete(id)
        removed.push(reservation)
      }
    }
    return removed
  }

  /** Highest currently registered generation for one owner. */
  getHighestOwnerGeneration(ownerId: string): number | undefined {
    let highest: number | undefined
    for (const entry of this.entries.values()) {
      const reservation = entry.reservation
      if (reservation.ownerId !== ownerId) continue
      highest = highest === undefined
        ? reservation.ownerGeneration
        : Math.max(highest, reservation.ownerGeneration)
    }
    return highest
  }

  /** Retrieves reservations owned by one owner, optionally one generation. */
  getByOwner(ownerId: string, ownerGeneration?: number): readonly ShellReservation[] {
    return Array.from(this.entries.values())
      .map(entry => entry.reservation)
      .filter(reservation =>
        reservation.ownerId === ownerId &&
        (ownerGeneration === undefined || reservation.ownerGeneration === ownerGeneration),
      )
  }

  /** Retrieves a reservation by ID. */
  get(id: string): ShellReservation | undefined {
    return this.entries.get(id)?.reservation
  }

  /** Retrieves all currently registered reservations. */
  getAll(): readonly ShellReservation[] {
    return Array.from(this.entries.values()).map(entry => entry.reservation)
  }

  /** Retrieves all reservations affecting a specific monitor. */
  getByMonitor(monitorId: string): readonly ShellReservation[] {
    return Array.from(this.entries.values())
      .map(entry => entry.reservation)
      .filter(reservation => reservation.monitorId === monitorId || reservation.monitorId === 'all')
  }

  /** Clears all reservations from the registry. */
  clear(): readonly ShellReservation[] {
    const all = this.getAll()
    this.entries.clear()
    return all
  }
}
