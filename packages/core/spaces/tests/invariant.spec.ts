import { describe, expect, it } from 'vitest'
import {
  NULL_NATIVE_DESKTOP_ID,
  isNullNativeDesktopId,
  nativeDesktopIdFromSpaceId,
  spaceIdFromNativeDesktopId,
} from '../src/invariant.ts'
import type { SpaceId } from '../src/types.ts'

const VALID_DESKTOP_ID = '11111111-1111-1111-1111-111111111111'

describe('Spaces identity invariants', () => {
  it('round-trips a real Windows virtual desktop GUID', () => {
    const spaceId = spaceIdFromNativeDesktopId(VALID_DESKTOP_ID)
    expect(spaceId).toBe(`space:${VALID_DESKTOP_ID}`)
    expect(nativeDesktopIdFromSpaceId(spaceId)).toBe(VALID_DESKTOP_ID)
  })

  it('never mints a SpaceId from Windows GUID_NULL', () => {
    expect(isNullNativeDesktopId(NULL_NATIVE_DESKTOP_ID)).toBe(true)
    expect(() => spaceIdFromNativeDesktopId(NULL_NATIVE_DESKTOP_ID)).toThrow(TypeError)
    expect(
      nativeDesktopIdFromSpaceId(`space:${NULL_NATIVE_DESKTOP_ID}` as SpaceId),
    ).toBeUndefined()
  })
})
