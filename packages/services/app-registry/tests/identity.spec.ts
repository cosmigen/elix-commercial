import { describe, expect, it } from 'vitest'
import {
  buildCanonicalDescriptor,
  deriveAppId,
  normalizePathForIdentity,
} from '../src/identity.ts'
import type { DiscoveredApplication } from '../src/types.ts'

describe('Application Identity Engine', () => {
  it('normalizes file system paths across slashes, casing, and known folder roots', () => {
    const p1 = 'C:\\Program Files\\7-Zip\\7zFM.exe'
    const p2 = 'c:/program files/7-zip/7zfm.exe'
    expect(normalizePathForIdentity(p1)).toBe(normalizePathForIdentity(p2))

    const p3 = 'C:\\Users\\JohnDoe\\AppData\\Local\\Programs\\MyApp\\app.exe'
    const norm3 = normalizePathForIdentity(p3)
    expect(norm3.startsWith('%localappdata%')).toBe(true)
  })

  it('generates the identical AppId across repeated rescans of the same application', () => {
    const app: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: '7-Zip File Manager',
      executablePath: 'C:\\Program Files\\7-Zip\\7zFM.exe',
      shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\7-Zip\\7-Zip File Manager.lnk',
    }

    const desc1 = buildCanonicalDescriptor(app)
    const id1 = deriveAppId(desc1)

    const desc2 = buildCanonicalDescriptor(app)
    const id2 = deriveAppId(desc2)

    expect(id1).toBe(id2)
    expect(id1.startsWith('app:win32:')).toBe(true)
  })

  it('normalizes path variations so equivalent paths produce the exact same AppId', () => {
    const appA: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Calculator',
      executablePath: 'C:\\Windows\\System32\\calc.exe',
    }
    const appB: DiscoveredApplication = {
      source: 'start-menu-user',
      kind: 'win32',
      displayName: 'Calculator Tool',
      executablePath: 'c:/windows/system32/calc.exe',
    }

    const idA = deriveAppId(buildCanonicalDescriptor(appA))
    const idB = deriveAppId(buildCanonicalDescriptor(appB))

    expect(idA).toBe(idB)
  })

  it('derives stable identity for packaged applications from canonical AUMID', () => {
    const pkgA: DiscoveredApplication = {
      source: 'packaged-apps',
      kind: 'packaged',
      displayName: 'Calculator',
      aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
      packageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe',
    }
    const pkgB: DiscoveredApplication = {
      source: 'packaged-apps',
      kind: 'packaged',
      displayName: 'Calculator',
      aumid: 'microsoft.windowscalculator_8wekyb3d8bbwe!app ',
    }

    const idA = deriveAppId(buildCanonicalDescriptor(pkgA))
    const idB = deriveAppId(buildCanonicalDescriptor(pkgB))

    expect(idA).toBe(idB)
    expect(idA.startsWith('app:packaged:')).toBe(true)
  })

  it('assigns DIFFERENT AppIds to distinct applications with the same display title', () => {
    const app1: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Setup',
      executablePath: 'C:\\Program Files\\VendorA\\ProductA\\setup.exe',
    }
    const app2: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Setup',
      executablePath: 'C:\\Program Files\\VendorB\\ProductB\\setup.exe',
    }

    const id1 = deriveAppId(buildCanonicalDescriptor(app1))
    const id2 = deriveAppId(buildCanonicalDescriptor(app2))

    expect(id1).not.toBe(id2)
  })

  it('handles shortcut-backed fallback identity when target executable is absent', () => {
    const shortcutApp: DiscoveredApplication = {
      source: 'start-menu-user',
      kind: 'shortcut',
      displayName: 'Custom Tool',
      shortcutPath: 'C:\\Users\\Test\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Custom.lnk',
    }

    const desc = buildCanonicalDescriptor(shortcutApp)
    const id = deriveAppId(desc)
    expect(id.startsWith('app:shortcut:')).toBe(true)
  })

  it('normalizes quoted Windows executable paths identically to unquoted paths', () => {
    const appUnquoted: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Git',
      executablePath: 'C:\\Program Files\\Git\\bin\\git.exe',
    }
    const appQuoted: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Git',
      executablePath: '"C:\\Program Files\\Git\\bin\\git.exe"',
    }

    const idUnquoted = deriveAppId(buildCanonicalDescriptor(appUnquoted))
    const idQuoted = deriveAppId(buildCanonicalDescriptor(appQuoted))

    expect(idQuoted).toBe(idUnquoted)
  })
})
