/**
 * Desktop Drag-and-Drop and Interaction Engine for ELIX Home Screen.
 * Handles single item drag, multi-selection movement, dropping into folders,
 * widget resizing, and layout commitment.
 *
 * @module @deepseek-ai/dsh-home/drag-drop
 */

import type { FolderManager } from './folder.ts'
import {
  isEligibleFolderItem,
  isEligibleFolderSourceItem,
  isEligibleFolderTargetItem,
  wouldCreateFolderCycle,
} from './folder.ts'
import type { FolderMetadata, HomeItem } from './items.ts'
import { HomeItemManager } from './items.ts'
import type { HomeLayoutEngine } from './layout.ts'
import { clampRectToBounds, intersectsAnyExclusionZone, rectsIntersect, snapToGrid } from './layout.ts'
import type { MonitorInfo } from './monitor.ts'
import type { ExternalDropPayload, Position, Rect, Size } from './types.ts'

/** Central inner hotspot ratio (55% of destination item dimension). */
export const INNER_HOTSPOT_RATIO = 0.55

/** Dwell delay required to arm a create-folder target gesture (in milliseconds). */
export const FOLDER_ARM_DELAY_MS = 600

/** Drag target intent state machine stages. */
export type DragTargetState = 'normal' | 'potential' | 'armed'

/** Options for updating pointer position with explicit time or force arming. */
export interface UpdatePointerOptions {
  readonly timestamp?: number | undefined
  readonly forceArm?: boolean | undefined
}

/** Compute the centered inner hotspot rectangle of an item. */
export function getItemInnerHotspot(
  position: Position,
  size: Size,
  ratio: number = INNER_HOTSPOT_RATIO,
): Rect {
  const insetX = (size.width * (1 - ratio)) / 2
  const insetY = (size.height * (1 - ratio)) / 2
  return {
    x: position.x + insetX,
    y: position.y + insetY,
    width: size.width * ratio,
    height: size.height * ratio,
  }
}

/** Test whether a point falls within a given rectangle. */
export function isPointInsideRect(point: Position, rect: Rect): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  )
}

/** Drag session interaction modes. */
export type DragMode = 'move' | 'resize' | 'external_drop'

/** Drop target model for drag interactions. */
export type DropTarget =
  | { readonly type: 'none' }
  | { readonly type: 'existing-folder'; readonly folderId: string }
  | { readonly type: 'create-folder'; readonly targetItemId: string; readonly armed: boolean }

/** State snapshot of an in-flight drag session. */
export interface DragSessionSnapshot {
  readonly mode: DragMode
  readonly primaryItemId: string
  readonly draggedItemIds: readonly string[]
  readonly startPointer: Position
  readonly currentPointer: Position
  readonly delta: Position
  readonly targetFolderId: string | null
  readonly isOverFolder: boolean
  readonly dropTarget: DropTarget
}

/** Configuration options to initiate a desktop drag session. */
export interface StartDragOptions {
  mode: DragMode
  primaryItemId?: string | undefined
  /** Additional selected item IDs moving simultaneously. */
  additionalItemIds?: readonly string[] | undefined
  startPointer: Position
  monitorId: string
  availableBounds: Rect
  resizeHandle?: 'se' | 's' | 'e' | undefined
  /** Data payload when dragging external files/shortcuts into Home. */
  externalData?: ExternalDropPayload | undefined
  /** Whether desktop grid snapping is strictly enforced. Defaults to true. */
  snapToGrid?: boolean | undefined
  /** Additional occupied rectangles (such as active widgets) that must be avoided. */
  additionalOccupied?: readonly Rect[] | undefined
  /** Monitors topology for cross-monitor drag detection. */
  monitors?: readonly MonitorInfo[] | undefined
  /** Callback to retrieve additional obstacles (like widgets) for a specific monitor. */
  getAdditionalOccupied?: ((monitorId: string) => readonly Rect[]) | undefined
}

/** Result outcome of committing a drop operation. */
export type DropResult =
  | {
    type: 'moved'
    items: ReadonlyArray<{ id: string; position: Position }>
  }
  | {
    type: 'folder_merged'
    targetFolderId: string
    mergedItemIds: readonly string[]
  }
  | {
    type: 'folder_created'
    folder: HomeItem<FolderMetadata>
    createdFolderId: string
    itemIds: readonly string[]
  }
  | {
    type: 'resized'
    itemId: string
    size: Size
  }
  | {
    type: 'external_dropped'
    item: HomeItem
    targetFolderId?: string | undefined
  }
  | {
    type: 'cancelled'
  }

/** Active drag session managing gestures, drag physics, and folder drop targeting. */
export class HomeDragSession {
  readonly mode: DragMode
  readonly primaryItemId: string
  readonly draggedItemIds: readonly string[]
  private currentMonitorId: string
  get monitorId(): string {
    return this.currentMonitorId
  }
  readonly snapToGrid: boolean
  private additionalOccupied: readonly Rect[]
  private availableBounds: Rect
  private readonly monitors: readonly MonitorInfo[]
  private readonly getAdditionalOccupied?: ((monitorId: string) => readonly Rect[]) | undefined

  private readonly initialPositions = new Map<string, Position>()
  private readonly initialSize: Size
  private readonly startPointer: Position
  private currentPointer: Position
  private targetFolderId: string | null = null
  private dropTarget: DropTarget = { type: 'none' }
  private targetState: DragTargetState = 'normal'
  private potentialTargetId: string | null = null
  private potentialTargetEnteredAt: number = 0
  private isArmed: boolean = false
  private armTimer: ReturnType<typeof setTimeout> | null = null
  private disposed: boolean = false
  private readonly externalData?: ExternalDropPayload | undefined

  constructor(
    options: StartDragOptions,
    private readonly itemManager: HomeItemManager,
    private readonly folderManager: FolderManager,
    private readonly layoutEngine: HomeLayoutEngine,
  ) {
    this.mode = options.mode
    this.primaryItemId = options.primaryItemId ?? 'external-drop-target'
    this.currentMonitorId = options.monitorId
    this.availableBounds = { ...options.availableBounds }
    this.startPointer = { ...options.startPointer }
    this.currentPointer = { ...options.startPointer }
    this.externalData = options.externalData
    this.snapToGrid = options.snapToGrid ?? true
    this.additionalOccupied = options.additionalOccupied ? [...options.additionalOccupied] : []
    this.monitors = options.monitors ? [...options.monitors] : []
    this.getAdditionalOccupied = options.getAdditionalOccupied

    const allIds = new Set<string>([this.primaryItemId, ...(options.additionalItemIds ?? [])])
    this.draggedItemIds = Array.from(allIds)

    for (const id of this.draggedItemIds) {
      const item = this.itemManager.getItem(id)
      if (item !== undefined) {
        this.initialPositions.set(id, { ...item.position })
      }
    }

    const primaryItem = this.itemManager.getItem(this.primaryItemId)
    this.initialSize = primaryItem !== undefined ? { ...primaryItem.size } : { width: 84, height: 96 }
  }

  /** Current delta vector from drag origin. */
  get delta(): Position {
    return {
      x: this.currentPointer.x - this.startPointer.x,
      y: this.currentPointer.y - this.startPointer.y,
    }
  }

  /** Current drag target state machine status ('normal' | 'potential' | 'armed'). */
  getTargetState(): DragTargetState {
    return this.targetState
  }

  /** Explicitly arm the current create-folder target if one is active. */
  armTarget(): void {
    if (this.dropTarget.type === 'create-folder') {
      this.isArmed = true
      this.targetState = 'armed'
      this.dropTarget = {
        type: 'create-folder',
        targetItemId: this.dropTarget.targetItemId,
        armed: true,
      }
    }
  }

  private clearArmTimer(): void {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer)
      this.armTimer = null
    }
  }

  /** Tear down the session and release any active arm timers. */
  dispose(): void {
    this.clearArmTimer()
    this.disposed = true
  }

  /** Current snapshot of the active drag session. */
  getSnapshot(): DragSessionSnapshot {
    return {
      mode: this.mode,
      primaryItemId: this.primaryItemId,
      draggedItemIds: this.draggedItemIds,
      startPointer: { ...this.startPointer },
      currentPointer: { ...this.currentPointer },
      delta: this.delta,
      targetFolderId: this.targetFolderId,
      isOverFolder: this.targetFolderId !== null,
      dropTarget: { ...this.dropTarget },
    }
  }

  /**
   * Update the pointer location during dragging and evaluate drop hover targets.
   * @param pointer - Current cursor coordinates in monitor space.
   * @param options - Optional timestamp or forced-arm state for deterministic tests or renderer intents.
   */
  updatePointer(pointer: Position, options?: UpdatePointerOptions | number): DragSessionSnapshot {
    this.currentPointer = { ...pointer }
    const now = typeof options === 'number' ? options : (options?.timestamp ?? Date.now())
    const forceArm = typeof options === 'object' ? (options.forceArm ?? false) : false

    if (this.monitors.length > 0) {
      for (const mon of this.monitors) {
        if (
          pointer.x >= mon.bounds.x &&
          pointer.x < mon.bounds.x + mon.bounds.width &&
          pointer.y >= mon.bounds.y &&
          pointer.y < mon.bounds.y + mon.bounds.height
        ) {
          if (mon.id !== this.currentMonitorId) {
            this.currentMonitorId = mon.id
            this.availableBounds = this.layoutEngine.getAvailableBounds(mon.id, mon.bounds)
            if (this.getAdditionalOccupied) {
              this.additionalOccupied = this.getAdditionalOccupied(mon.id)
            }
          }
          break
        }
      }
    }

    if (this.mode === 'move' || this.mode === 'external_drop') {
      this.evaluateDropTarget(now, forceArm)
    }

    return this.getSnapshot()
  }

  /**
   * Commit the drop operation and apply position or folder changes.
   */
  commit(): DropResult {
    this.clearArmTimer()
    this.disposed = true

    if (this.mode === 'move') {
      // 1. Check if dropped directly into an existing folder
      if (this.dropTarget.type === 'existing-folder') {
        const folderId = this.dropTarget.folderId
        const folderItem = this.itemManager.getItem(folderId)
        if (folderItem !== undefined && folderItem.type === 'folder') {
          const merged: string[] = []
          for (const id of this.draggedItemIds) {
            if (id !== folderId && this.folderManager.addItemToFolder(folderId, id)) {
              merged.push(id)
            }
          }
          if (merged.length > 0) {
            return {
              type: 'folder_merged',
              targetFolderId: folderId,
              mergedItemIds: merged,
            }
          }
        }
      }

      // 2. Check if dropped onto an eligible item to create a new folder (ONLY IF ARMED!)
      if (this.dropTarget.type === 'create-folder' && this.dropTarget.armed) {
        const targetItemId = this.dropTarget.targetItemId
        const targetItem = this.itemManager.getItem(targetItemId)
        if (
          targetItem !== undefined &&
          targetItem.folderId === undefined &&
          isEligibleFolderTargetItem(targetItem)
        ) {
          const eligibleDraggedIds = this.draggedItemIds.filter((id) => {
            if (id === targetItemId) return false
            const it = this.itemManager.getItem(id)
            return it !== undefined && it.folderId === undefined && isEligibleFolderSourceItem(it)
          })
          if (eligibleDraggedIds.length > 0) {
            const initialItemIds = [targetItemId, ...eligibleDraggedIds]

            // Ensure created folder placement respects legal work area and exclusion zones
            let folderPosition = { ...targetItem.position }
            const folderRect: Rect = {
              x: folderPosition.x,
              y: folderPosition.y,
              width: targetItem.size.width,
              height: targetItem.size.height,
            }
            const targetBounds = targetItem.monitorId === this.monitorId
              ? this.availableBounds
              : this.layoutEngine.getAvailableBounds(
                targetItem.monitorId,
                { x: targetItem.position.x, y: targetItem.position.y, width: 1920, height: 1080 },
              )
            const zones = this.layoutEngine.getExclusionZones(targetItem.monitorId)
            const isInsideBounds =
              folderRect.x >= targetBounds.x &&
              folderRect.x + folderRect.width <= targetBounds.x + targetBounds.width &&
              folderRect.y >= targetBounds.y &&
              folderRect.y + folderRect.height <= targetBounds.y + targetBounds.height
            const collidesExclusion = intersectsAnyExclusionZone(folderRect, zones, targetItem.monitorId)

            if (!isInsideBounds || collidesExclusion) {
              const otherOccupied = this.itemManager
                .getItems()
                .filter(it => !initialItemIds.includes(it.id) && it.folderId === undefined && it.monitorId === targetItem.monitorId)
                .map(it => ({ x: it.position.x, y: it.position.y, width: it.size.width, height: it.size.height }))
              folderPosition = this.layoutEngine.findNearestFreeSlot(
                folderRect,
                [...otherOccupied, ...this.additionalOccupied],
                targetItem.monitorId,
                targetBounds,
                this.snapToGrid,
              )
            }

            const folder = this.folderManager.createFolder({
              monitorId: targetItem.monitorId,
              position: folderPosition,
              initialItemIds,
            })
            return {
              type: 'folder_created',
              folder,
              createdFolderId: folder.id,
              itemIds: initialItemIds,
            }
          }
        }
      }

      // 3. Otherwise commit new desktop grid positions (NORMAL REPOSITION)
      const moved: Array<{ id: string; position: Position }> = []
      const grid = this.layoutEngine.getGridConfig()
      const newOccupied: HomeItem[] = this.itemManager
        .getItems()
        .filter(it => !this.draggedItemIds.includes(it.id))
      const zones = this.layoutEngine.getExclusionZones(this.monitorId)

      if (this.draggedItemIds.length > 1) {
        // Multi-selection: treat group consistently and preserve relative arrangement
        const primaryInit = this.initialPositions.get(this.primaryItemId) ?? { x: 0, y: 0 }
        const primaryRaw: Position = {
          x: primaryInit.x + this.delta.x,
          y: primaryInit.y + this.delta.y,
        }
        const primaryCandidate = this.snapToGrid
          ? snapToGrid(primaryRaw, this.availableBounds, grid)
          : primaryRaw
        const baseShiftX = primaryCandidate.x - primaryInit.x
        const baseShiftY = primaryCandidate.y - primaryInit.y

        const checkGroupFits = (shiftX: number, shiftY: number): boolean => {
          for (const id of this.draggedItemIds) {
            const init = this.initialPositions.get(id)
            const it = this.itemManager.getItem(id)
            if (init === undefined || it === undefined) return false
            const candX = init.x + shiftX
            const candY = init.y + shiftY
            if (
              candX < this.availableBounds.x ||
              candX + it.size.width > this.availableBounds.x + this.availableBounds.width ||
              candY < this.availableBounds.y ||
              candY + it.size.height > this.availableBounds.y + this.availableBounds.height
            ) {
              return false
            }
            const candRect: Rect = { x: candX, y: candY, width: it.size.width, height: it.size.height }
            if (intersectsAnyExclusionZone(candRect, zones, this.monitorId, grid.gap)) {
              return false
            }
            if (
              newOccupied.some(
                occ =>
                  occ.monitorId === this.monitorId &&
                  occ.folderId === undefined &&
                  rectsIntersect(
                    candRect,
                    { x: occ.position.x, y: occ.position.y, width: occ.size.width, height: occ.size.height },
                    grid.gap,
                  ),
              )
            ) {
              return false
            }
            if (this.additionalOccupied.some(w => rectsIntersect(candRect, w, grid.gap))) {
              return false
            }
          }
          return true
        }

        let chosenShiftX = baseShiftX
        let chosenShiftY = baseShiftY
        let groupResolved = checkGroupFits(baseShiftX, baseShiftY)

        if (!groupResolved) {
          const stepX = this.snapToGrid ? grid.cellWidth + grid.gap : Math.max(12, grid.gap)
          const stepY = this.snapToGrid ? grid.cellHeight + grid.gap : Math.max(12, grid.gap)
          const maxRadius = Math.ceil(
            Math.max(this.availableBounds.width, this.availableBounds.height) / Math.min(stepX, stepY),
          ) + 2

          searchLoop:
          for (let radius = 1; radius <= maxRadius; radius++) {
            const offsets: Array<[number, number]> = []
            for (let cross = -radius + 1; cross < radius; cross++) {
              offsets.push([radius, cross], [-radius, cross])
            }
            for (let cross = -radius; cross <= radius; cross++) {
              offsets.push([cross, -radius], [cross, radius])
            }
            for (const [colOff, rowOff] of offsets) {
              const testShiftX = baseShiftX + colOff * stepX
              const testShiftY = baseShiftY + rowOff * stepY
              if (checkGroupFits(testShiftX, testShiftY)) {
                chosenShiftX = testShiftX
                chosenShiftY = testShiftY
                groupResolved = true
                break searchLoop
              }
            }
          }
        }

        if (groupResolved) {
          for (const id of this.draggedItemIds) {
            const init = this.initialPositions.get(id)
            if (!init) continue
            const finalPos: Position = { x: init.x + chosenShiftX, y: init.y + chosenShiftY }
            this.itemManager.moveItem(id, finalPos, this.monitorId)
            moved.push({ id, position: finalPos })
          }
          return {
            type: 'moved',
            items: moved,
          }
        } else {
          // If multi-select group cannot be placed as a coherent unit without collision,
          // restore initial positions to preserve their relative arrangement.
          for (const id of this.draggedItemIds) {
            const init = this.initialPositions.get(id)
            if (!init) continue
            this.itemManager.moveItem(id, init, this.monitorId)
            moved.push({ id, position: init })
          }
          return {
            type: 'moved',
            items: moved,
          }
        }
      }

      // Single item placement. In grid mode, regular item↔item collisions use
      // deterministic reflow: the dragged item keeps the requested grid slot and
      // colliding desktop items move aside in the drag direction. Widgets and shell
      // exclusions remain immovable obstacles and make the dragged item resolve around them.
      for (const id of this.draggedItemIds) {
        const init = this.initialPositions.get(id)
        if (init === undefined) continue

        const item = this.itemManager.getItem(id)
        if (item === undefined) continue

        const rawPos: Position = {
          x: init.x + this.delta.x,
          y: init.y + this.delta.y,
        }

        const snapped = this.snapToGrid ? snapToGrid(rawPos, this.availableBounds, grid) : rawPos
        const clamped = clampRectToBounds(
          {
            x: snapped.x,
            y: snapped.y,
            width: item.size.width,
            height: item.size.height,
          },
          this.availableBounds,
        )

        const candidate: HomeItem = {
          ...item,
          monitorId: this.monitorId,
          position: { x: clamped.x, y: clamped.y },
        }
        const candidateRect: Rect = {
          x: clamped.x,
          y: clamped.y,
          width: item.size.width,
          height: item.size.height,
        }

        const collidingDesktopItems = newOccupied.filter(
          occ =>
            occ.monitorId === this.monitorId &&
            occ.folderId === undefined &&
            rectsIntersect(
              candidateRect,
              { x: occ.position.x, y: occ.position.y, width: occ.size.width, height: occ.size.height },
              0,
            ),
        )
        const blockedByFixedObstacle =
          this.additionalOccupied.some(rect => rectsIntersect(candidateRect, rect, grid.gap)) ||
          intersectsAnyExclusionZone(candidateRect, zones, this.monitorId, grid.gap)

        let finalPos: Position
        if (this.snapToGrid && collidingDesktopItems.length > 0 && !blockedByFixedObstacle) {
          const stepX = grid.cellWidth + grid.gap
          const stepY = grid.cellHeight + grid.gap
          const dominantHorizontal = Math.abs(this.delta.x) >= Math.abs(this.delta.y)
          const directionX = dominantHorizontal ? (this.delta.x >= 0 ? 1 : -1) : 0
          const directionY = dominantHorizontal ? 0 : (this.delta.y >= 0 ? 1 : -1)

          for (const blocker of collidingDesktopItems) {
            const blockerRect: Rect = {
              x: blocker.position.x,
              y: blocker.position.y,
              width: blocker.size.width,
              height: blocker.size.height,
            }
            const preferredRect = clampRectToBounds(
              {
                ...blockerRect,
                x: blockerRect.x + directionX * stepX,
                y: blockerRect.y + directionY * stepY,
              },
              this.availableBounds,
            )
            const occupiedForBlocker = newOccupied
              .filter(
                occ =>
                  occ.id !== blocker.id &&
                  occ.monitorId === this.monitorId &&
                  occ.folderId === undefined,
              )
              .map(occ => ({
                x: occ.position.x,
                y: occ.position.y,
                width: occ.size.width,
                height: occ.size.height,
              }))

            const blockerPosition = this.layoutEngine.findNearestFreeSlot(
              preferredRect,
              [candidateRect, ...occupiedForBlocker, ...this.additionalOccupied],
              this.monitorId,
              this.availableBounds,
              true,
            )

            this.itemManager.moveItem(blocker.id, blockerPosition, this.monitorId)
            moved.push({ id: blocker.id, position: blockerPosition })
            const occupiedIndex = newOccupied.findIndex(occ => occ.id === blocker.id)
            if (occupiedIndex >= 0) {
              newOccupied[occupiedIndex] = {
                ...blocker,
                monitorId: this.monitorId,
                position: blockerPosition,
              }
            }
          }

          const stillBlockedByItem = newOccupied.some(
            occ =>
              occ.monitorId === this.monitorId &&
              occ.folderId === undefined &&
              rectsIntersect(
                candidateRect,
                { x: occ.position.x, y: occ.position.y, width: occ.size.width, height: occ.size.height },
                grid.gap,
              ),
          )
          finalPos = stillBlockedByItem
            ? this.layoutEngine.resolvePlacement(
              candidate,
              newOccupied,
              this.availableBounds,
              true,
              this.additionalOccupied,
            )
            : { x: candidateRect.x, y: candidateRect.y }
        } else {
          finalPos = this.layoutEngine.resolvePlacement(
            candidate,
            newOccupied,
            this.availableBounds,
            this.snapToGrid,
            this.additionalOccupied,
          )
        }

        this.itemManager.moveItem(id, finalPos, this.monitorId)
        moved.push({ id, position: finalPos })
        newOccupied.push({
          ...candidate,
          position: finalPos,
        })
      }

      return {
        type: 'moved',
        items: moved,
      }
    }

    if (this.mode === 'external_drop') {
      if (this.externalData === undefined) return { type: 'cancelled' }

      if (this.targetFolderId !== null) {
        const createdItem = this.itemManager.addItem({
          type: this.externalData.type ?? 'file',
          monitorId: this.monitorId,
          position: { x: 0, y: 0 },
          size: { width: 84, height: 96 },
          metadata: {
            name: this.externalData.name,
            filename: this.externalData.name,
            path: this.externalData.path ?? '',
            target: this.externalData.target ?? '',
            extension: '',
            ...(this.externalData.metadata ?? {}),
          },
        })
        this.folderManager.addItemToFolder(this.targetFolderId, createdItem.id)
        const itemInFolder = this.itemManager.getItem(createdItem.id) ?? createdItem
        return {
          type: 'external_dropped',
          item: itemInFolder,
          targetFolderId: this.targetFolderId,
        }
      }

      const grid = this.layoutEngine.getGridConfig()
      const rawPos: Position = { x: this.currentPointer.x, y: this.currentPointer.y }
      const snapped = this.snapToGrid ? snapToGrid(rawPos, this.availableBounds, grid) : rawPos
      const clamped = clampRectToBounds(
        { x: snapped.x, y: snapped.y, width: 84, height: 96 },
        this.availableBounds,
      )

      const createdItem = this.itemManager.addItem({
        type: this.externalData.type ?? 'file',
        monitorId: this.monitorId,
        position: { x: clamped.x, y: clamped.y },
        size: { width: 84, height: 96 },
        metadata: {
          name: this.externalData.name,
          filename: this.externalData.name,
          path: this.externalData.path ?? '',
          target: this.externalData.target ?? '',
          extension: '',
          ...(this.externalData.metadata ?? {}),
        },
      })

      const resolvedPos = this.layoutEngine.resolvePlacement(
        createdItem,
        this.itemManager.getItems(),
        this.availableBounds,
        this.snapToGrid,
        this.additionalOccupied,
      )

      this.itemManager.moveItem(createdItem.id, resolvedPos, this.monitorId)
      return {
        type: 'external_dropped',
        item: this.itemManager.getItem(createdItem.id) ?? createdItem,
      }
    }

    // Mode is 'resize'
    const primaryItem = this.itemManager.getItem(this.primaryItemId)
    if (primaryItem === undefined) return { type: 'cancelled' }

    const rawWidth = Math.max(84, this.initialSize.width + this.delta.x)
    const rawHeight = Math.max(72, this.initialSize.height + this.delta.y)

    const grid = this.layoutEngine.getGridConfig()
    const stepW = grid.cellWidth + grid.gap
    const stepH = grid.cellHeight + grid.gap

    let finalWidth = this.snapToGrid ? Math.max(84, Math.round(rawWidth / stepW) * stepW || rawWidth) : rawWidth
    let finalHeight = this.snapToGrid ? Math.max(72, Math.round(rawHeight / stepH) * stepH || rawHeight) : rawHeight

    const maxAvailWidth = Math.max(84, (this.availableBounds.x + this.availableBounds.width) - primaryItem.position.x)
    const maxAvailHeight = Math.max(72, (this.availableBounds.y + this.availableBounds.height) - primaryItem.position.y)

    finalWidth = Math.min(finalWidth, maxAvailWidth)
    finalHeight = Math.min(finalHeight, maxAvailHeight)

    const otherItems = this.itemManager.getRootItemsForMonitor(this.monitorId)
      .filter(it => it.id !== primaryItem.id)
      .map(it => ({ x: it.position.x, y: it.position.y, width: it.size.width, height: it.size.height }))
    const zones = this.layoutEngine.getExclusionZones(this.monitorId).map(z => z.rect)
    const blockers = [...otherItems, ...this.additionalOccupied, ...zones]

    const x0 = primaryItem.position.x
    const y0 = primaryItem.position.y
    const w0 = primaryItem.size.width
    const h0 = primaryItem.size.height

    for (const blocker of blockers) {
      if (!rectsIntersect({ x: x0, y: y0, width: finalWidth, height: finalHeight }, blocker, grid.gap)) {
        continue
      }
      const inYPath = blocker.y - grid.gap < y0 + Math.min(h0, finalHeight) && blocker.y + blocker.height + grid.gap > y0
      const inXPath = blocker.x - grid.gap < x0 + Math.min(w0, finalWidth) && blocker.x + blocker.width + grid.gap > x0

      if (inYPath && !inXPath && blocker.x >= x0) {
        finalWidth = Math.min(finalWidth, Math.max(84, blocker.x - x0 - grid.gap))
      } else if (inXPath && !inYPath && blocker.y >= y0) {
        finalHeight = Math.min(finalHeight, Math.max(72, blocker.y - y0 - grid.gap))
      } else if (blocker.x >= x0 && blocker.y >= y0) {
        const maxW = Math.max(84, blocker.x - x0 - grid.gap)
        const maxH = Math.max(72, blocker.y - y0 - grid.gap)
        if (finalWidth > maxW && finalHeight > maxH) {
          if ((finalWidth - w0) >= (finalHeight - h0)) {
            finalHeight = maxH
          } else {
            finalWidth = maxW
          }
        }
      }
    }

    const testRect = { x: x0, y: y0, width: finalWidth, height: finalHeight }
    if (blockers.some(b => rectsIntersect(testRect, b, grid.gap))) {
      if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: finalWidth, height: h0 }, b, grid.gap))) {
        finalWidth = w0
      }
      if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: w0, height: finalHeight }, b, grid.gap))) {
        finalHeight = h0
      }
      if (blockers.some(b => rectsIntersect({ x: x0, y: y0, width: finalWidth, height: finalHeight }, b, grid.gap))) {
        finalWidth = w0
        finalHeight = h0
      }
    }

    const finalSize: Size = {
      width: finalWidth,
      height: finalHeight,
    }

    this.itemManager.resizeItem(this.primaryItemId, finalSize)
    return {
      type: 'resized',
      itemId: this.primaryItemId,
      size: finalSize,
    }
  }

  /**
   * Abort the drag operation and restore original item coordinates.
   */
  cancel(): void {
    this.clearArmTimer()
    this.disposed = true
    for (const [id, pos] of this.initialPositions) {
      this.itemManager.moveItem(id, pos, this.monitorId)
    }
    this.resetTargetState()
  }

  private resetTargetState(): void {
    this.clearArmTimer()
    this.potentialTargetId = null
    this.potentialTargetEnteredAt = 0
    this.isArmed = false
    this.targetState = 'normal'
    this.dropTarget = { type: 'none' }
    this.targetFolderId = null
  }

  private evaluateDropTarget(now: number = Date.now(), forceArm: boolean = false): void {
    const currentRect: Rect =
      this.mode === 'external_drop'
        ? {
          x: this.currentPointer.x - 42,
          y: this.currentPointer.y - 48,
          width: 84,
          height: 96,
        }
        : (() => {
          const primaryInit = this.initialPositions.get(this.primaryItemId)
          if (primaryInit === undefined) return { x: 0, y: 0, width: 0, height: 0 }
          return {
            x: primaryInit.x + this.delta.x,
            y: primaryInit.y + this.delta.y,
            width: this.initialSize.width,
            height: this.initialSize.height,
          }
        })()

    if (currentRect.width === 0) {
      this.resetTargetState()
      return
    }

    const pCenterX = currentRect.x + currentRect.width / 2
    const pCenterY = currentRect.y + currentRect.height / 2

    const primaryItem = this.itemManager.getItem(this.primaryItemId)
    const isPrimaryEligible = this.mode === 'external_drop' || isEligibleFolderSourceItem(primaryItem)

    // Check that all dragged items are eligible folder sources
    const allDraggedEligible = this.draggedItemIds.every((id) => {
      const it = this.itemManager.getItem(id)
      return it !== undefined && isEligibleFolderSourceItem(it)
    })

    // Candidates: all root items on this monitor or overlapping availableBounds, excluding dragged items
    const candidates = this.itemManager
      .getItems()
      .filter(
        item =>
          item.folderId === undefined &&
          !this.draggedItemIds.includes(item.id) &&
          isEligibleFolderItem(item) &&
          (item.monitorId === this.monitorId ||
            rectsIntersect(
              { x: item.position.x, y: item.position.y, width: item.size.width, height: item.size.height },
              this.availableBounds,
              0,
            )),
      )

    let bestExistingFolder: { folderId: string; dist: number } | null = null
    let bestCreateTarget: { targetItemId: string; dist: number } | null = null

    for (const cand of candidates) {
      const cCenterX = cand.position.x + cand.size.width / 2
      const cCenterY = cand.position.y + cand.size.height / 2
      const dist = Math.hypot(pCenterX - cCenterX, pCenterY - cCenterY)

      const hotspot = getItemInnerHotspot(cand.position, cand.size, INNER_HOTSPOT_RATIO)
      const inHotspot =
        isPointInsideRect(this.currentPointer, hotspot) ||
        isPointInsideRect({ x: pCenterX, y: pCenterY }, hotspot)

      if (cand.type === 'folder') {
        const inFolder = this.mode === 'external_drop'
          ? isPointInsideRect(this.currentPointer, { ...cand.position, ...cand.size })
          : inHotspot
        if (!inFolder) continue
        const canMergeAny =
          this.mode === 'external_drop' ||
          this.draggedItemIds.some(id => !wouldCreateFolderCycle(this.folderManager, cand.id, id))
        if (!canMergeAny) continue

        if (bestExistingFolder === null || dist < bestExistingFolder.dist) {
          bestExistingFolder = { folderId: cand.id, dist }
        }
      } else if (isPrimaryEligible && allDraggedEligible && this.mode === 'move' && isEligibleFolderTargetItem(cand)) {
        if (!inHotspot) continue

        if (
          primaryItem !== undefined &&
          (wouldCreateFolderCycle(this.folderManager, cand.id, primaryItem.id) ||
            wouldCreateFolderCycle(this.folderManager, primaryItem.id, cand.id))
        ) {
          continue
        }

        if (bestCreateTarget === null || dist < bestCreateTarget.dist) {
          bestCreateTarget = { targetItemId: cand.id, dist }
        }
      }
    }

    if (bestExistingFolder !== null) {
      this.clearArmTimer()
      this.potentialTargetId = null
      this.isArmed = false
      this.targetState = 'normal'
      this.dropTarget = { type: 'existing-folder', folderId: bestExistingFolder.folderId }
      this.targetFolderId = bestExistingFolder.folderId
      return
    }

    if (bestCreateTarget !== null) {
      const targetId = bestCreateTarget.targetItemId
      if (this.potentialTargetId === targetId) {
        if (forceArm) {
          this.isArmed = true
        } else if (!this.isArmed) {
          if (now - this.potentialTargetEnteredAt >= FOLDER_ARM_DELAY_MS) {
            this.isArmed = true
          }
        }
      } else {
        this.clearArmTimer()
        this.potentialTargetId = targetId
        this.potentialTargetEnteredAt = now
        this.isArmed = forceArm

        if (!this.isArmed) {
          this.armTimer = setTimeout(() => {
            if (!this.disposed && this.potentialTargetId === targetId) {
              this.isArmed = true
              this.targetState = 'armed'
              this.dropTarget = { type: 'create-folder', targetItemId: targetId, armed: true }
            }
          }, FOLDER_ARM_DELAY_MS)
        }
      }

      this.targetState = this.isArmed ? 'armed' : 'potential'
      this.dropTarget = { type: 'create-folder', targetItemId: targetId, armed: this.isArmed }
      this.targetFolderId = null
      return
    }

    this.resetTargetState()
  }
}
