import type { WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import type { SpaceId } from './types.ts'

const SPACE_PREFIX = 'space:'
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const NULL_NATIVE_DESKTOP_ID = '00000000-0000-0000-0000-000000000000'

/** Returns true for GUID_NULL, which is not a usable virtual-desktop identity. */
export function isNullNativeDesktopId(desktopId: string): boolean {
  return desktopId.trim().toLowerCase() === NULL_NATIVE_DESKTOP_ID
}

/** Converts a native virtual-desktop GUID into an opaque ELIX SpaceId. */
export function spaceIdFromNativeDesktopId(desktopId: string): SpaceId {
  const normalized = desktopId.trim().toLowerCase()
  if (!GUID_PATTERN.test(normalized) || normalized === NULL_NATIVE_DESKTOP_ID) {
    throw new TypeError(`Invalid native virtual desktop GUID '${desktopId}'.`)
  }
  return `${SPACE_PREFIX}${normalized}` as SpaceId
}

/** Resolves an opaque SpaceId back to the native GUID used only at the native boundary. */
export function nativeDesktopIdFromSpaceId(spaceId: SpaceId): string | undefined {
  const value = String(spaceId)
  if (!value.startsWith(SPACE_PREFIX)) return undefined
  const desktopId = value.slice(SPACE_PREFIX.length).toLowerCase()
  if (!GUID_PATTERN.test(desktopId) || desktopId === NULL_NATIVE_DESKTOP_ID) return undefined
  return desktopId
}

/** Re-fences a WindowId against the exact lifetime evidence used by a native request. */
export function sameWindowLifetime(left: WindowSnapshot, right: WindowSnapshot): boolean {
  return left.id === right.id
    && left.hwnd === right.hwnd
    && left.processId === right.processId
    && left.threadId === right.threadId
    && left.processCreationTime === right.processCreationTime
    && left.className === right.className
    && left.generation === right.generation
}
