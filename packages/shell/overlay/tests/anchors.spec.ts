import type { MonitorId, WindowsMonitor } from '@deepseek-ai/dsh-windows-context'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNTHETIC_MONITOR,
  resolveAnchorRect,
  selectMonitor,
} from '../src/anchor-resolver.ts'

describe('Overlay Anchor Resolver & Monitor Selector', () => {
  const primaryMonitor: WindowsMonitor = {
    id: 'mon-primary' as unknown as MonitorId,
    deviceName: 'DISPLAY1',
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1.0,
    isPrimary: true,
  }

  const secondaryLeftMonitor: WindowsMonitor = {
    id: 'mon-left' as unknown as MonitorId,
    deviceName: 'DISPLAY2',
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
    dpiX: 144,
    dpiY: 144,
    scaleFactor: 1.5,
    isPrimary: false,
  }

  const secondaryRightMonitor: WindowsMonitor = {
    id: 'mon-right' as unknown as MonitorId,
    deviceName: 'DISPLAY3',
    bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
    workArea: { x: 1920, y: 0, width: 1920, height: 1080 },
    dpiX: 96,
    dpiY: 96,
    scaleFactor: 1.0,
    isPrimary: false,
  }

  const allMonitors = [primaryMonitor, secondaryLeftMonitor, secondaryRightMonitor]

  describe('resolveAnchorRect', () => {
    it('resolves point anchor to zero-size rectangle', () => {
      const rect = resolveAnchorRect({ type: 'point', x: 250, y: 350 })
      expect(rect).toEqual({ x: 250, y: 350, width: 0, height: 0 })
    })

    it('resolves physical rectangle anchor directly', () => {
      const rect = resolveAnchorRect({ type: 'rect', x: 100, y: 200, width: 300, height: 400 })
      expect(rect).toEqual({ x: 100, y: 200, width: 300, height: 400 })
    })

    it('resolves surface-relative anchor using parent surface physical bounds', () => {
      const getSurfaceBounds = (id: string) => {
        if (id === 'parent-dock') {
          return { x: 400, y: 1000, width: 1120, height: 60 }
        }
        return undefined
      }

      const rect = resolveAnchorRect(
        {
          type: 'surface-relative',
          surfaceId: 'parent-dock',
          rect: { x: 50, y: 10, width: 44, height: 40 },
        },
        getSurfaceBounds,
      )

      expect(rect).toEqual({
        x: 450,
        y: 1010,
        width: 44,
        height: 40,
      })
    })

    it('throws error when surface-relative parent surface is not found', () => {
      expect(() => {
        resolveAnchorRect(
          {
            type: 'surface-relative',
            surfaceId: 'nonexistent-surf',
            rect: { x: 0, y: 0, width: 10, height: 10 },
          },
          () => undefined,
        )
      }).toThrow(/Surface 'nonexistent-surf' not found/)
    })
  })

  describe('selectMonitor', () => {
    it('falls back to default synthetic monitor when monitors list is empty', () => {
      const monitor = selectMonitor({ x: 100, y: 100, width: 0, height: 0 }, [])
      expect(monitor).toEqual(DEFAULT_SYNTHETIC_MONITOR)
    })

    it('selects monitor containing point anchor', () => {
      const monPrimary = selectMonitor({ x: 500, y: 500, width: 0, height: 0 }, allMonitors)
      expect(monPrimary.id).toBe('mon-primary')

      const monLeft = selectMonitor({ x: -500, y: 500, width: 0, height: 0 }, allMonitors)
      expect(monLeft.id).toBe('mon-left')

      const monRight = selectMonitor({ x: 2500, y: 500, width: 0, height: 0 }, allMonitors)
      expect(monRight.id).toBe('mon-right')
    })

    it('selects closest monitor when point falls outside all displays', () => {
      // Coordinate far below primary display
      const mon = selectMonitor({ x: 500, y: 3000, width: 0, height: 0 }, allMonitors)
      expect(mon.id).toBe('mon-primary')
    })

    it('selects monitor completely containing a rectangle anchor', () => {
      const mon = selectMonitor({ x: 100, y: 100, width: 200, height: 100 }, allMonitors)
      expect(mon.id).toBe('mon-primary')
    })

    it('selects monitor with largest intersection area when rectangle crosses displays', () => {
      // Rectangle crossing from left monitor into primary:
      // In Left: x = -100 to 0 (width 100)
      // In Primary: x = 0 to 400 (width 400) -> Primary has 80% of the area
      const rectCrossing = { x: -100, y: 200, width: 500, height: 100 }
      const mon = selectMonitor(rectCrossing, allMonitors)
      expect(mon.id).toBe('mon-primary')

      // Invert: 400px in left, 100px in primary
      const rectCrossingLeft = { x: -400, y: 200, width: 500, height: 100 }
      const monLeft = selectMonitor(rectCrossingLeft, allMonitors)
      expect(monLeft.id).toBe('mon-left')
    })

    it('selects closest monitor when rectangle is entirely off-screen', () => {
      const offscreenRect = { x: 5000, y: 500, width: 100, height: 100 }
      const mon = selectMonitor(offscreenRect, allMonitors)
      expect(mon.id).toBe('mon-right')
    })
  })

  describe('Screen Coordinate and Centered Bounds Helpers', () => {
    it('converts clientRect with scale factor to physical screen coordinates', () => {
      const hostBounds = { x: 100, y: 150, width: 800, height: 600 }
      const scaleFactor = 1.5
      const clientRect = { x: 20, y: 30, width: 200, height: 40 }

      const physicalRect = {
        x: hostBounds.x + Math.round(clientRect.x * scaleFactor),
        y: hostBounds.y + Math.round(clientRect.y * scaleFactor),
        width: Math.round(clientRect.width * scaleFactor),
        height: Math.round(clientRect.height * scaleFactor),
      }

      expect(physicalRect).toEqual({
        x: 130, // 100 + 30
        y: 195, // 150 + 45
        width: 300,
        height: 60,
      })
    })

    it('computes true centered popup bounds within monitor workArea', () => {
      const workArea = primaryMonitor.workArea // 0, 0, 1920, 1040
      const popupSize = { width: 300, height: 200 }

      const targetX = workArea.x + Math.round((workArea.width - popupSize.width) / 2)
      const targetY = workArea.y + Math.round((workArea.height - popupSize.height) / 2)

      expect(targetX).toBe(810) // (1920 - 300) / 2 = 810
      expect(targetY).toBe(420) // (1040 - 200) / 2 = 420

      const anchor = resolveAnchorRect({ type: 'point', x: targetX, y: targetY })
      expect(anchor).toEqual({ x: 810, y: 420, width: 0, height: 0 })
    })
  })
})
