import type { MonitorId, PhysicalPixelRect, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it } from 'vitest'
import { computePlacement } from '../src/placement-engine.ts'

describe('Overlay Placement Engine', () => {
  const primaryMonitor: WindowsMonitor = {
    id: 'mon-1' as unknown as MonitorId,
    deviceName: 'DISPLAY1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1.0,
    isPrimary: true,
  }

  const secondaryLeftMonitor: WindowsMonitor = {
    id: 'mon-2' as unknown as MonitorId,
    deviceName: 'DISPLAY2',
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
    isPrimary: false,
  }

  describe('Standard directional placements', () => {
    const anchor: PhysicalPixelRect = { x: 500, y: 400, width: 100, height: 50 }
    const size = { width: 200, height: 150 }
    const offset = 4

    it('positions bottom-start directly below the anchor aligned to left edge', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 500,
        y: 454, // 400 + 50 + 4
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('bottom-start')
      expect(res.flipped).toBe(false)
      expect(res.shifted).toBe(false)
      expect(res.clamped).toBe(false)
    })

    it('positions bottom-end directly below the anchor aligned to right edge', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-end',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 400, // 500 + 100 - 200
        y: 454,
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('bottom-end')
    })

    it('positions bottom centered horizontally under the anchor', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 450, // 500 + (100 - 200) / 2
        y: 454,
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('bottom')
    })

    it('positions top-start above the anchor aligned to left edge', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'top-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 500,
        y: 246, // 400 - 4 - 150
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('top-start')
    })

    it('positions right-start to the right of anchor aligned to top edge', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'right-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 604, // 500 + 100 + 4
        y: 400,
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('right-start')
    })

    it('positions left-start to the left of anchor aligned to top edge', () => {
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'left-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.bounds).toEqual({
        x: 296, // 500 - 4 - 200
        y: 400,
        width: 200,
        height: 150,
      })
      expect(res.effectivePlacement).toBe('left-start')
    })
  })

  describe('Auto placement behavior', () => {
    const size = { width: 200, height: 150 }

    it('chooses bottom-start when plenty of space below', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 100, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'auto',
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.effectivePlacement).toBe('bottom-start')
      expect(res.bounds.y).toBe(134)
    })

    it('chooses top-start when near bottom edge and ample room above', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 950, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'auto',
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.effectivePlacement).toBe('top-start')
      expect(res.bounds.y).toBe(796) // 950 - 4 - 150
    })
  })

  describe('Flip behavior', () => {
    const size = { width: 200, height: 150 }
    const offset = 4

    it('flips from bottom-start to top-start when bottom edge overflows', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 950, width: 50, height: 50 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-start',
        offset,
        availableBounds: primaryMonitor.workArea, // height: 1040
        monitor: primaryMonitor,
      })

      expect(res.flipped).toBe(true)
      expect(res.effectivePlacement).toBe('top-start')
      expect(res.bounds.y).toBe(796) // 950 - 4 - 150
    })

    it('flips from top-start to bottom-start when top edge underflows', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 50, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'top-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.flipped).toBe(true)
      expect(res.effectivePlacement).toBe('bottom-start')
      expect(res.bounds.y).toBe(84) // 50 + 30 + 4
    })

    it('flips from right-start to left-start when right edge overflows', () => {
      const anchor: PhysicalPixelRect = { x: 1850, y: 200, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'right-start',
        offset,
        availableBounds: primaryMonitor.workArea, // width: 1920
        monitor: primaryMonitor,
      })

      expect(res.flipped).toBe(true)
      expect(res.effectivePlacement).toBe('left-start')
      expect(res.bounds.x).toBe(1646) // 1850 - 4 - 200
    })

    it('flips from left-start to right-start when left edge underflows', () => {
      const anchor: PhysicalPixelRect = { x: 50, y: 200, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'left-start',
        offset,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.flipped).toBe(true)
      expect(res.effectivePlacement).toBe('right-start')
      expect(res.bounds.x).toBe(104) // 50 + 50 + 4
    })
  })

  describe('Shift behavior', () => {
    const size = { width: 250, height: 100 }

    it('shifts horizontally left when popup extends past the right edge', () => {
      const anchor: PhysicalPixelRect = { x: 1800, y: 200, width: 50, height: 40 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-start',
        availableBounds: primaryMonitor.workArea, // max X = 1920
        monitor: primaryMonitor,
      })

      expect(res.shifted).toBe(true)
      expect(res.bounds.x).toBe(1670) // 1920 - 250
      expect(res.bounds.x + res.bounds.width).toBe(1920)
    })

    it('shifts horizontally right when popup extends before the left edge', () => {
      const anchor: PhysicalPixelRect = { x: 20, y: 200, width: 50, height: 40 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-end', // x would be 20 + 50 - 250 = -180
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.shifted).toBe(true)
      expect(res.bounds.x).toBe(0)
    })

    it('shifts vertically up when horizontal popup extends past bottom edge', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 1000, width: 50, height: 30 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'right-start', // y = 1000, h = 100, overflows 1040
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.shifted).toBe(true)
      expect(res.bounds.y).toBe(940) // 1040 - 100
      expect(res.bounds.y + res.bounds.height).toBe(1040)
    })
  })

  describe('Clamp and size constraints', () => {
    it('clamps coordinates to stay completely within availableBounds', () => {
      const hugeSize = { width: 2500, height: 1500 }
      const anchor: PhysicalPixelRect = { x: 100, y: 100, width: 50, height: 50 }
      const res = computePlacement({
        anchorRect: anchor,
        size: hugeSize,
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })

      expect(res.clamped).toBe(true)
      expect(res.bounds.width).toBe(1920)
      expect(res.bounds.height).toBe(1040)
      expect(res.bounds.x).toBe(0)
      expect(res.bounds.y).toBe(0)
    })

    it('respects minWidth and maxWidth constraints', () => {
      const anchor: PhysicalPixelRect = { x: 500, y: 400, width: 50, height: 50 }
      const resMin = computePlacement({
        anchorRect: anchor,
        size: { width: 50, height: 50, minWidth: 120 },
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })
      expect(resMin.bounds.width).toBe(120)

      const resMax = computePlacement({
        anchorRect: anchor,
        size: { width: 500, height: 50, maxWidth: 300 },
        availableBounds: primaryMonitor.workArea,
        monitor: primaryMonitor,
      })
      expect(resMax.bounds.width).toBe(300)
    })
  })

  describe('Negative monitor coordinates and mixed DPI', () => {
    it('places correctly on secondary monitor with negative virtual coordinates', () => {
      const anchor: PhysicalPixelRect = { x: -1000, y: 300, width: 100, height: 40 }
      const size = { width: 300, height: 200 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-start',
        availableBounds: secondaryLeftMonitor.workArea, // x: -1920 to 0
        monitor: secondaryLeftMonitor,
      })

      expect(res.bounds.x).toBe(-1000)
      expect(res.bounds.y).toBe(344)
      expect(res.bounds.width).toBe(300)
      expect(res.bounds.height).toBe(200)
      expect(res.flipped).toBe(false)
      expect(res.shifted).toBe(false)
    })

    it('shifts properly against negative left edge on secondary monitor', () => {
      const anchor: PhysicalPixelRect = { x: -1900, y: 300, width: 100, height: 40 }
      const size = { width: 300, height: 200 }
      const res = computePlacement({
        anchorRect: anchor,
        size,
        requestedPlacement: 'bottom-end', // x would be -1900 + 100 - 300 = -2100 < -1920
        availableBounds: secondaryLeftMonitor.workArea,
        monitor: secondaryLeftMonitor,
      })

      expect(res.shifted).toBe(true)
      expect(res.bounds.x).toBe(-1920) // Shifted to monitor left edge
    })
  })
})
