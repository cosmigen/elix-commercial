/**
 * Bounded messages exchanged between the Home service and its loopback renderer.
 * Renderer coordinates are CSS pixels relative to the monitor surface; Home converts
 * them to canonical physical virtual-screen coordinates before invoking domain APIs.
 *
 * @module @deepseek-ai/dsh-home/renderer-protocol
 */

import type { FolderColor } from './folder.ts'
import type { HomeItemType } from './items.ts'
import type { WallpaperFit, WallpaperKind } from './wallpaper.ts'

/** Renderer-local point measured in CSS pixels from the WebView client origin. */
export interface RendererPoint {
  readonly x: number
  readonly y: number
}

/** Renderer-local rectangle measured in CSS pixels. */
export interface RendererRect extends RendererPoint {
  readonly width: number
  readonly height: number
}

/** Miniature descriptor for an item contained in an App Folder preview/overlay. */
export interface HomeRendererFolderChild {
  readonly id: string
  readonly label: string
  readonly type: HomeItemType
  readonly iconUrl?: string | undefined
}

/** Visual item projection that omits executable targets and filesystem metadata. */
export interface HomeRendererItem {
  readonly id: string
  readonly type: HomeItemType
  readonly label: string
  readonly rect: RendererRect
  readonly selected: boolean
  readonly iconUrl?: string | undefined
  readonly folderColor?: string | undefined
  readonly folderItemCount?: number | undefined
  readonly isFilesystemFolder?: boolean | undefined
  readonly isOpen?: boolean | undefined
  readonly folderChildren?: readonly HomeRendererFolderChild[] | undefined
  readonly widgetType?: string | undefined
  readonly isRenaming?: boolean | undefined
}

/** Visual widget instance projection rendered inside Home surface. */
export interface HomeRendererWidget {
  readonly id: string
  readonly definitionId: string
  readonly title: string
  readonly rect: RendererRect
  readonly resizable: boolean
  readonly zOrder: number
  readonly contentHtml: string
  readonly state: Record<string, unknown>
  readonly minSize?: { readonly width: number; readonly height: number } | undefined
  readonly maxSize?: { readonly width: number; readonly height: number } | undefined
}

/** Wallpaper projection for one Home renderer. */
export interface HomeRendererWallpaper {
  readonly kind: WallpaperKind
  readonly fit: WallpaperFit
  readonly source: string
  readonly blur: number
  readonly saturation: number
  readonly dim: number
  readonly assetUrl?: string | undefined
}

/** Complete immutable render projection for one monitor. */
export interface HomeRendererSnapshot {
  readonly monitorId: string
  readonly monitorName: string
  readonly cssWidth: number
  readonly cssHeight: number
  readonly scaleFactor: number
  /** Preferred desktop icon extent in renderer CSS pixels. */
  readonly iconSize: number
  readonly wallpaperRuntime: WallpaperRuntimeState
  readonly wallpaper: HomeRendererWallpaper
  readonly items: readonly HomeRendererItem[]
  readonly widgets: readonly HomeRendererWidget[]
  readonly exclusions: readonly RendererRect[]
  readonly debugExclusions: boolean
  readonly openFolderId?: string | undefined
  readonly themeTokens?: Readonly<Record<string, string>> | undefined
}

/** Renderer-controlled wallpaper execution state. */
export type WallpaperRuntimeState = 'active' | 'throttled' | 'suspended' | 'disposed'

/** User intent accepted from the unprivileged Home document. */
export type HomeRendererIntent =
  | { readonly type: 'select'; readonly itemId: string; readonly additive: boolean }
  | { readonly type: 'clearSelection' }
  | { readonly type: 'selectAll' }
  | { readonly type: 'marquee'; readonly rect: RendererRect; readonly additive: boolean }
  | {
    readonly type: 'moveItems'
    readonly primaryItemId: string
    readonly additionalItemIds: readonly string[]
    readonly start: RendererPoint
    readonly end: RendererPoint
    readonly folderTargetArmed?: boolean | undefined
    readonly armedTargetItemId?: string | undefined
  }
  | {
    readonly type: 'contextMenu'
    readonly targetType?: 'desktop' | 'item' | 'folder' | 'widget' | undefined
    readonly itemId?: string | undefined
    readonly widgetId?: string | undefined
    readonly position: RendererPoint
  }
  | { readonly type: 'activate'; readonly itemId: string }
  | { readonly type: 'resizeItem'; readonly itemId: string; readonly size: { readonly width: number; readonly height: number } }
  | { readonly type: 'moveWidget'; readonly instanceId: string; readonly position: RendererPoint }
  | { readonly type: 'resizeWidget'; readonly instanceId: string; readonly size: { readonly width: number; readonly height: number } }
  | { readonly type: 'removeWidget'; readonly instanceId: string }
  | { readonly type: 'widgetAction'; readonly instanceId: string; readonly action: string; readonly payload?: unknown }
  | { readonly type: 'renameItem'; readonly itemId: string; readonly newName: string }
  | { readonly type: 'cancelRename' }
  | { readonly type: 'deleteItem'; readonly itemId: string }
  | { readonly type: 'openFolder'; readonly folderId: string }
  | { readonly type: 'closeFolder'; readonly folderId?: string | undefined }
  | { readonly type: 'setFolderColor'; readonly folderId: string; readonly color: FolderColor }
  | { readonly type: 'reorderFolderItems'; readonly folderId: string; readonly itemIds: readonly string[] }
  | { readonly type: 'addItemToFolder'; readonly folderId: string; readonly itemId: string }
  | { readonly type: 'removeItemFromFolder'; readonly folderId: string; readonly itemId: string }
  | { readonly type: 'deleteFolder'; readonly folderId: string }

/** Maximum accepted renderer intent body. */
export const MAX_RENDERER_INTENT_BYTES = 16 * 1024

const FOLDER_COLORS: ReadonlySet<FolderColor> = new Set([
  'mint',
  'sky',
  'violet',
  'amber',
  'rose',
  'graphite',
])

/**
 * Parse and validate one renderer intent from the HTTP trust boundary.
 * @param value - Untrusted JSON-parsed payload.
 * @returns Validated Home renderer intent.
 */
export function parseHomeRendererIntent(value: unknown): HomeRendererIntent {
  const object = asRecord(value)
  const type = requireString(object.type, 'type', 32)
  switch (type) {
    case 'select':
      return {
        type,
        itemId: requireString(object.itemId, 'itemId'),
        additive: requireBoolean(object.additive, 'additive'),
      }
    case 'clearSelection':
    case 'selectAll':
    case 'cancelRename':
      return { type }
    case 'marquee':
      return {
        type,
        rect: requireRect(object.rect, 'rect'),
        additive: requireBoolean(object.additive, 'additive'),
      }
    case 'moveItems': {
      if (!Array.isArray(object.additionalItemIds) || object.additionalItemIds.length > 256) {
        throw new Error('additionalItemIds must be an array of at most 256 item identifiers.')
      }
      return {
        type,
        primaryItemId: requireString(object.primaryItemId, 'primaryItemId'),
        additionalItemIds: object.additionalItemIds.map((id, index) => requireString(id, `additionalItemIds[${index}]`)),
        start: requirePoint(object.start, 'start'),
        end: requirePoint(object.end, 'end'),
        ...(typeof object.folderTargetArmed === 'boolean' ? { folderTargetArmed: object.folderTargetArmed } : {}),
        ...(typeof object.armedTargetItemId === 'string' ? { armedTargetItemId: object.armedTargetItemId } : {}),
      }
    }
    case 'contextMenu': {
      const targetType = object.targetType === 'widget' || object.targetType === 'item' || object.targetType === 'folder' || object.targetType === 'desktop'
        ? object.targetType
        : undefined
      return {
        type,
        targetType,
        ...(object.itemId === undefined ? {} : { itemId: requireString(object.itemId, 'itemId') }),
        ...(object.widgetId === undefined ? {} : { widgetId: requireString(object.widgetId, 'widgetId') }),
        position: requirePoint(object.position, 'position'),
      }
    }
    case 'activate':
      return { type, itemId: requireString(object.itemId, 'itemId') }
    case 'resizeItem': {
      const sizeObj = asRecord(object.size)
      return {
        type,
        itemId: requireString(object.itemId, 'itemId'),
        size: {
          width: requirePositiveNumber(sizeObj.width, 'size.width'),
          height: requirePositiveNumber(sizeObj.height, 'size.height'),
        },
      }
    }
    case 'moveWidget':
      return {
        type,
        instanceId: requireString(object.instanceId, 'instanceId'),
        position: requirePoint(object.position, 'position'),
      }
    case 'resizeWidget': {
      const sizeObj = asRecord(object.size)
      return {
        type,
        instanceId: requireString(object.instanceId, 'instanceId'),
        size: {
          width: requirePositiveNumber(sizeObj.width, 'size.width'),
          height: requirePositiveNumber(sizeObj.height, 'size.height'),
        },
      }
    }
    case 'removeWidget':
      return {
        type,
        instanceId: requireString(object.instanceId, 'instanceId'),
      }
    case 'widgetAction':
      return {
        type,
        instanceId: requireString(object.instanceId, 'instanceId'),
        action: requireString(object.action, 'action', 64),
        payload: object.payload,
      }
    case 'renameItem':
      return {
        type,
        itemId: requireString(object.itemId, 'itemId'),
        newName: requireString(object.newName, 'newName', 256),
      }
    case 'deleteItem':
      return {
        type,
        itemId: requireString(object.itemId, 'itemId'),
      }
    case 'openFolder':
    case 'deleteFolder':
      return {
        type,
        folderId: requireString(object.folderId, 'folderId'),
      }
    case 'closeFolder':
      return {
        type,
        ...(object.folderId === undefined ? {} : { folderId: requireString(object.folderId, 'folderId') }),
      }
    case 'setFolderColor':
      return {
        type,
        folderId: requireString(object.folderId, 'folderId'),
        color: requireFolderColor(object.color),
      }
    case 'reorderFolderItems': {
      if (!Array.isArray(object.itemIds) || object.itemIds.length > 256) {
        throw new Error('itemIds must be an array of at most 256 item identifiers.')
      }
      return {
        type,
        folderId: requireString(object.folderId, 'folderId'),
        itemIds: object.itemIds.map((id, index) => requireString(id, `itemIds[${index}]`)),
      }
    }
    case 'addItemToFolder':
    case 'removeItemFromFolder':
      return {
        type,
        folderId: requireString(object.folderId, 'folderId'),
        itemId: requireString(object.itemId, 'itemId'),
      }
    default:
      throw new Error(`Unsupported Home renderer intent '${type}'.`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Home renderer intent must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error(`${field} must be a non-empty string of at most ${maximum} characters.`)
  }
  return value
}

function requireFolderColor(value: unknown): FolderColor {
  const color = requireString(value, 'color', 16) as FolderColor
  if (!FOLDER_COLORS.has(color)) {
    throw new Error('color must be one of mint, sky, violet, amber, rose, or graphite.')
  }
  return color
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean.`)
  return value
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000) {
    throw new Error(`${field} must be a finite renderer coordinate.`)
  }
  return value
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100_000) {
    throw new Error(`${field} must be a positive finite dimension.`)
  }
  return value
}

function requirePoint(value: unknown, field: string): RendererPoint {
  const object = asRecord(value)
  return {
    x: requireFiniteNumber(object.x, `${field}.x`),
    y: requireFiniteNumber(object.y, `${field}.y`),
  }
}

function requireRect(value: unknown, field: string): RendererRect {
  const object = asRecord(value)
  const width = requireFiniteNumber(object.width, `${field}.width`)
  const height = requireFiniteNumber(object.height, `${field}.height`)
  if (width < 0 || height < 0) throw new Error(`${field} dimensions must not be negative.`)
  return {
    x: requireFiniteNumber(object.x, `${field}.x`),
    y: requireFiniteNumber(object.y, `${field}.y`),
    width,
    height,
  }
}
