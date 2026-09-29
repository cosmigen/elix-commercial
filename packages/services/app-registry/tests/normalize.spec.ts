import { describe, expect, it } from 'vitest'
import {
  areIconsEqual,
  areLaunchSpecsEqual,
  generateAliases,
  hasAppRecordChanged,
  isValidAumid,
  isValidFilePath,
  normalizeDiscoveredApp,
  resolveDisplayName,
  resolveIconReference,
  resolveLaunchSpec,
  sanitizeString,
} from '../src/normalize.ts'
import type { DiscoveredApplication } from '../src/types.ts'

describe('Application Normalization & Security', () => {
  it('sanitizes untrusted OS strings, removing null bytes and control codes', () => {
    const raw = '  App\u0000Title\u001F  With  Extra \t Spaces  '
    expect(sanitizeString(raw)).toBe('AppTitle With Extra Spaces')
    expect(sanitizeString(undefined)).toBe('')
  })

  it('validates file paths and rejects dangerous script formats', () => {
    expect(isValidFilePath('C:\\Program Files\\App\\app.exe')).toBe(true)
    expect(isValidFilePath('"C:\\Program Files\\App\\app.exe"')).toBe(true)
    expect(isValidFilePath('C:\\Windows\\System32\\cmd.exe')).toBe(true)
    expect(isValidFilePath('"C:\\Windows\\System32\\cmd.exe"')).toBe(true)
    expect(isValidFilePath('C:\\Scripts\\evil.vbs')).toBe(false)
    expect(isValidFilePath('"C:\\Scripts\\evil.vbs"')).toBe(false)
    expect(isValidFilePath('C:\\Scripts\\evil.ps1')).toBe(false)
    expect(isValidFilePath('C:\\Scripts\\evil.reg')).toBe(false)
    expect(isValidFilePath('C:\\Path\\With<Bad>Chars.exe')).toBe(false)
    expect(isValidFilePath('')).toBe(false)
    expect(isValidFilePath(undefined)).toBe(false)
  })

  it('validates AUMID structure according to Windows package rules', () => {
    expect(isValidAumid('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')).toBe(true)
    expect(isValidAumid('electron.app.Antigravity')).toBe(true)
    expect(isValidAumid('Invalid AUMID with spaces')).toBe(false)
    expect(isValidAumid('')).toBe(false)
    expect(isValidAumid(undefined)).toBe(false)
  })

  it('resolves clean display names stripping file extensions', () => {
    expect(resolveDisplayName({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Calculator.exe',
    })).toBe('Calculator')

    expect(resolveDisplayName({
      source: 'start-menu-user',
      kind: 'shortcut',
      displayName: 'Command Prompt.lnk',
    })).toBe('Command Prompt')

    expect(resolveDisplayName({
      source: 'start-menu-user',
      kind: 'win32',
      displayName: '',
      executablePath: 'C:\\Tools\\mytool.exe',
    })).toBe('mytool')
  })

  it('generates deduplicated search aliases from executable name, shortcut base, and custom aliases', () => {
    const app: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Google Chrome',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      aliases: ['browser', 'google chrome', 'internet'],
    }

    const aliases = generateAliases(app, 'Google Chrome')
    expect(aliases).toContain('chrome')
    expect(aliases).toContain('chrome.exe')
    expect(aliases).toContain('browser')
    expect(aliases).toContain('internet')
    expect(aliases).not.toContain('google chrome') // matches displayName
  })

  it('normalizes icon references for file, resource index, and packaged kinds', () => {
    const fileIcon = resolveIconReference({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'App',
      iconPath: 'C:\\Icons\\app.ico',
    })
    expect(fileIcon.kind).toBe('file')

    const resIcon = resolveIconReference({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Shell App',
      iconPath: 'C:\\Windows\\System32\\shell32.dll,21',
    })
    expect(resIcon.kind).toBe('resource')
    if (resIcon.kind === 'resource') {
      expect(resIcon.sourcePath).toBe('C:\\Windows\\System32\\shell32.dll')
      expect(resIcon.resourceIndex).toBe(21)
    }

    const pkgIcon = resolveIconReference({
      source: 'packaged-apps',
      kind: 'packaged',
      displayName: 'Store App',
      packageFamilyName: 'Microsoft.Store_8wekyb3d8bbwe',
    })
    expect(pkgIcon.kind).toBe('packaged')

    const fallbackIcon = resolveIconReference({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'No Icon App',
    })
    expect(fallbackIcon.kind).toBe('fallback')
  })

  it('normalizes typed launch specifications and rejects invalid paths', () => {
    const win32Spec = resolveLaunchSpec({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Editor',
      executablePath: 'C:\\Program Files\\Editor\\editor.exe',
      arguments: ['--open', 'file.txt'],
      workingDirectory: 'C:\\Workspace',
    })
    expect(win32Spec.kind).toBe('win32')
    if (win32Spec.kind === 'win32') {
      expect(win32Spec.executablePath).toBe('C:\\Program Files\\Editor\\editor.exe')
      expect(win32Spec.arguments).toEqual(['--open', 'file.txt'])
    }

    const pkgSpec = resolveLaunchSpec({
      source: 'packaged-apps',
      kind: 'packaged',
      displayName: 'Calc',
      aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
    })
    expect(pkgSpec.kind).toBe('packaged')
    if (pkgSpec.kind === 'packaged') {
      expect(pkgSpec.aumid).toBe('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')
    }
  })

  it('builds a complete immutable AppRecord maintaining timestamp continuity', () => {
    const raw: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Notepad',
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
      publisher: 'Microsoft Corporation',
    }

    const firstSeen = 10000
    const existing = normalizeDiscoveredApp(raw, undefined, firstSeen)
    expect(existing.firstSeenAt).toBe(firstSeen)
    expect(existing.lastSeenAt).toBe(firstSeen)

    const now = 20000
    const updated = normalizeDiscoveredApp(raw, existing, now)
    expect(updated.firstSeenAt).toBe(firstSeen)
    expect(updated.lastSeenAt).toBe(now)
    expect(updated.displayName).toBe('Notepad')
    expect(updated.publisher).toBe('Microsoft Corporation')
    // Since metadata is unchanged, updatedAt is preserved
    expect(updated.updatedAt).toBe(firstSeen)
  })

  it('accurately evaluates value equality for icons and launch specs', () => {
    expect(areIconsEqual(
      { kind: 'file', filePath: 'C:\\app.ico' },
      { kind: 'file', filePath: 'C:\\app.ico' },
    )).toBe(true)

    expect(areIconsEqual(
      { kind: 'file', filePath: 'C:\\app.ico' },
      { kind: 'file', filePath: 'C:\\other.ico' },
    )).toBe(false)

    expect(areLaunchSpecsEqual(
      { kind: 'win32', executablePath: 'C:\\app.exe', arguments: ['-a'] },
      { kind: 'win32', executablePath: 'C:\\app.exe', arguments: ['-a'] },
    )).toBe(true)

    expect(areLaunchSpecsEqual(
      { kind: 'win32', executablePath: 'C:\\app.exe', arguments: ['-a'] },
      { kind: 'win32', executablePath: 'C:\\app.exe', arguments: ['-b'] },
    )).toBe(false)
  })

  it('detects functional metadata changes between app records', () => {
    const base = normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Calculator',
      executablePath: 'C:\\calc.exe',
      publisher: 'Vendor A',
    })

    const unchanged = normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Calculator',
      executablePath: 'C:\\calc.exe',
      publisher: 'Vendor A',
    }, base)

    expect(hasAppRecordChanged(base, unchanged)).toBe(false)

    const changed = normalizeDiscoveredApp({
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Calculator',
      executablePath: 'C:\\calc.exe',
      publisher: 'Vendor B (Updated)',
    }, base)

    expect(hasAppRecordChanged(base, changed)).toBe(true)
  })
})
