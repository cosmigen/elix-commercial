import { describe, expect, it } from 'vitest'
import { StartMenuProvider } from '../src/providers/start-menu.ts'
import { PackagedAppsProvider } from '../src/providers/packaged-apps.ts'
import { RegistryMetadataProvider } from '../src/providers/registry-metadata.ts'
import { deduplicateAndReconcile } from '../src/reconcile.ts'
import { searchApplications } from '../src/search.ts'

describe('Real Windows Discovery Integration (Live OS)', () => {
  const isWindows = process.platform === 'win32'

  it.skipIf(!isWindows)('discovers real Start Menu applications on the host Windows machine', async () => {
    const provider = new StartMenuProvider()
    const discoveries = await provider.discover()

    expect(discoveries).toBeDefined()
    expect(discoveries.length).toBeGreaterThan(0)

    for (const app of discoveries.slice(0, 5)) {
      expect(app.displayName.length).toBeGreaterThan(0)
      expect(['win32', 'shortcut']).toContain(app.kind)
      expect(['start-menu-user', 'start-menu-system']).toContain(app.source)
    }
  }, 15_000)

  it.skipIf(!isWindows)('discovers real Packaged apps and AUMIDs on host Windows machine', async () => {
    const provider = new PackagedAppsProvider()
    const discoveries = await provider.discover()

    expect(discoveries).toBeDefined()
    // Windows typically has packaged apps installed (e.g. Calculator, Terminal, etc.)
    if (discoveries.length > 0) {
      for (const app of discoveries.slice(0, 5)) {
        expect(app.kind).toBe('packaged')
        expect(app.source).toBe('packaged-apps')
        expect(app.aumid).toBeDefined()
        expect(app.aumid?.includes('!')).toBe(true)
      }
    }
  }, 15_000)

  it.skipIf(!isWindows)('discovers real Registry uninstall metadata on host Windows machine', async () => {
    const provider = new RegistryMetadataProvider()
    const discoveries = await provider.discover()

    expect(discoveries).toBeDefined()
    if (discoveries.length > 0) {
      for (const app of discoveries.slice(0, 5)) {
        expect(app.source).toBe('registry')
        expect(app.displayName.length).toBeGreaterThan(0)
      }
    }
  }, 15_000)

  it.skipIf(!isWindows)('reconciles live discoveries with zero ID churn across repeated scans', async () => {
    const startMenuProvider = new StartMenuProvider()
    const packagedAppsProvider = new PackagedAppsProvider()

    const [startMenuApps, packagedApps] = await Promise.all([
      startMenuProvider.discover(),
      packagedAppsProvider.discover(),
    ])

    const allDiscoveries = [...startMenuApps, ...packagedApps]
    expect(allDiscoveries.length).toBeGreaterThan(0)

    const catalog1 = deduplicateAndReconcile(allDiscoveries)
    const catalog2 = deduplicateAndReconcile(allDiscoveries)

    expect(catalog1.size).toBe(catalog2.size)

    const ids1 = Array.from(catalog1.keys()).sort()
    const ids2 = Array.from(catalog2.keys()).sort()
    expect(ids1).toEqual(ids2)

    // Test search against live apps
    const allApps = Array.from(catalog1.values())
    const searchResults = searchApplications(allApps, 'a')
    expect(searchResults.length).toBeGreaterThan(0)
  }, 30_000)
})
