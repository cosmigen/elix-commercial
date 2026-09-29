import type { WindowPlacementConstraints } from '@deepseek-ai/dsh-window-control'
import { describe, expect, it } from 'vitest'
import {
  clampRectFullyOrAccessibly,
  computeZoneRect,
  constrainPlacementRect,
  preserveOffsetRect,
} from '../src/geometry.ts'

const RESIZABLE: WindowPlacementConstraints = {
  resizable: true,
  visibleBounds: { x: 0, y: 0, width: 800, height: 600 },
  appConstraintsObserved: false,
}

describe('Phase 17B placement geometry', () => {
  it('splits odd work areas without losing physical pixels', () => {
    const workArea = { x: -1920, y: 0, width: 1919, height: 1079 }
    const current = { x: -1500, y: 100, width: 800, height: 600 }
    const left = computeZoneRect(workArea, 'left-half', current).rect
    const right = computeZoneRect(workArea, 'right-half', current).rect

    expect(left).toEqual({ x: -1920, y: 0, width: 959, height: 1079 })
    expect(right).toEqual({ x: -961, y: 0, width: 960, height: 1079 })
    expect(left.width + right.width).toBe(workArea.width)
  })

  it('computes quarter placement correctly on a portrait negative-coordinate monitor', () => {
    const workArea = { x: -1200, y: -200, width: 1200, height: 1800 }
    const current = { x: -1000, y: 0, width: 700, height: 900 }

    expect(computeZoneRect(workArea, 'bottom-right-quarter', current).rect).toEqual({
      x: -600,
      y: 700,
      width: 600,
      height: 900,
    })
  })

  it('keeps center as a position-only policy even for an oversized window', () => {
    const workArea = { x: 100, y: 50, width: 1000, height: 700 }
    const current = { x: -400, y: -400, width: 1400, height: 900 }

    expect(computeZoneRect(workArea, 'center', current).rect).toEqual({
      x: -100,
      y: -50,
      width: 1400,
      height: 900,
    })
  })

  it('preserves monitor-relative offset before the single DPI-aware clamp stage', () => {
    const current = { x: 1700, y: 700, width: 700, height: 500 }
    const sourceArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const targetArea = { x: -1280, y: 0, width: 1280, height: 984 }

    expect(preserveOffsetRect(current, sourceArea, targetArea)).toEqual({
      x: 420,
      y: 700,
      width: 700,
      height: 500,
    })
  })

  it('rejects a resize placement for a structurally nonresizable window', () => {
    const result = constrainPlacementRect(
      { x: 0, y: 0, width: 960, height: 1080 },
      { x: 300, y: 200, width: 800, height: 600 },
      { x: 0, y: 0, width: 1920, height: 1080 },
      { ...RESIZABLE, resizable: false },
      { horizontal: 'start', vertical: 'center' },
      true,
      48,
    )

    expect(result.rejectedNonresizable).toBe(true)
    expect(result.rect).toEqual({ x: 300, y: 200, width: 800, height: 600 })
  })

  it('never resizes a nonresizable window during a pure move even if track evidence differs', () => {
    const result = constrainPlacementRect(
      { x: -1200, y: 100, width: 800, height: 600 },
      { x: 200, y: 100, width: 800, height: 600 },
      { x: -1280, y: 0, width: 1280, height: 984 },
      {
        ...RESIZABLE,
        resizable: false,
        minTrackWidth: 1000,
        minTrackHeight: 700,
        maxTrackWidth: 1000,
        maxTrackHeight: 700,
        appConstraintsObserved: true,
      },
      { horizontal: 'start', vertical: 'start' },
      false,
      72,
    )

    expect(result.rejectedNonresizable).toBe(false)
    expect(result.rect.width).toBe(800)
    expect(result.rect.height).toBe(600)
    expect(result.adjustments).not.toContain('minimum-width')
    expect(result.adjustments).not.toContain('minimum-height')
  })

  it('honors available min/max evidence and reports exact adjustments', () => {
    const constraints: WindowPlacementConstraints = {
      ...RESIZABLE,
      minTrackWidth: 700,
      minTrackHeight: 500,
      maxTrackWidth: 1100,
      maxTrackHeight: 900,
      appConstraintsObserved: true,
    }
    const result = constrainPlacementRect(
      { x: 0, y: 0, width: 500, height: 1200 },
      { x: 100, y: 100, width: 800, height: 600 },
      { x: 0, y: 0, width: 1600, height: 1200 },
      constraints,
      { horizontal: 'start', vertical: 'start' },
      true,
      48,
    )

    expect(result.rejectedNonresizable).toBe(false)
    expect(result.rect).toEqual({ x: 0, y: 0, width: 700, height: 900 })
    expect(result.adjustments).toEqual(['minimum-width', 'maximum-height'])
  })

  it.each([
    [1, 48, 96],
    [1.25, 60, 120],
    [1.5, 72, 144],
    [2, 96, 192],
  ])('keeps oversized restore geometry accessible at %sx DPI', (_scale, titleBar, grabWidth) => {
    const workArea = { x: 0, y: 0, width: 800, height: 600 }
    const result = clampRectFullyOrAccessibly(
      { x: -2000, y: -1000, width: 1400, height: 1000 },
      workArea,
      titleBar,
      grabWidth,
    )

    expect(result.x).toBe(-1400 + grabWidth)
    expect(result.y).toBe(0)
    expect(result.width).toBe(1400)
    expect(result.height).toBe(1000)
  })
})
