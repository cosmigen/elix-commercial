import { describe, expect, it } from 'vitest'
import { deduplicateAndReconcile, reconcileApplicationGroup } from '../src/reconcile.ts'
import type { DiscoveredApplication } from '../src/types.ts'

describe('Cross-Provider Deduplication & Reconciliation', () => {
  it('merges Start Menu shortcut and Registry metadata for the same application', () => {
    const shortcutDiscovery: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: '7-Zip File Manager',
      description: 'Archiving utility',
      executablePath: 'C:\\Program Files\\7-Zip\\7zFM.exe',
      shortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\7-Zip\\7-Zip File Manager.lnk',
      iconPath: 'C:\\Program Files\\7-Zip\\7zFM.exe,0',
    }

    const registryDiscovery: DiscoveredApplication = {
      source: 'registry',
      kind: 'win32',
      displayName: '7-Zip 23.01 (x64)',
      publisher: 'Igor Pavlov',
      installLocation: 'C:\\Program Files\\7-Zip',
      executablePath: 'C:\\Program Files\\7-Zip\\7zFM.exe',
      aliases: ['7-Zip'],
    }

    const group = [shortcutDiscovery, registryDiscovery]
    const reconciled = reconcileApplicationGroup(group)

    // Primary display title from shortcut
    expect(reconciled.displayName).toBe('7-Zip File Manager')
    // Merged publisher from registry
    expect(reconciled.publisher).toBe('Igor Pavlov')
    // Merged description from shortcut
    expect(reconciled.description).toBe('Archiving utility')
    // Merged installLocation from registry
    expect(reconciled.installLocation).toBe('C:\\Program Files\\7-Zip')
    // Merged aliases
    expect(reconciled.aliases).toContain('7-zip')
  })

  it('deduplicates multiple discoveries into a unified map of AppRecords', () => {
    const discoveries: DiscoveredApplication[] = [
      {
        source: 'start-menu-user',
        kind: 'win32',
        displayName: 'Visual Studio Code',
        executablePath: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
        shortcutPath: 'C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Visual Studio Code.lnk',
      },
      {
        source: 'registry',
        kind: 'win32',
        displayName: 'Microsoft Visual Studio Code',
        publisher: 'Microsoft Corporation',
        installLocation: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code',
        executablePath: 'C:\\Users\\User\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe',
      },
      {
        source: 'packaged-apps',
        kind: 'packaged',
        displayName: 'Calculator',
        aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
        publisher: 'Microsoft Corporation',
      },
    ]

    const catalog = deduplicateAndReconcile(discoveries)

    // VS Code (reconciled shortcut + registry) and Calculator = exactly 2 apps
    expect(catalog.size).toBe(2)
  })

  it('NEVER merges two distinct applications merely because their display titles match', () => {
    const app1: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Setup',
      executablePath: 'C:\\Program Files\\App1\\setup.exe',
    }
    const app2: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Setup',
      executablePath: 'C:\\Program Files\\App2\\setup.exe',
    }

    const catalog = deduplicateAndReconcile([app1, app2])
    expect(catalog.size).toBe(2)
  })

  it('filters out unlaunchable registry uninstall entries (drivers, runtimes) from standalone app creation', () => {
    const validShortcut: DiscoveredApplication = {
      source: 'start-menu-system',
      kind: 'win32',
      displayName: 'Notepad',
      executablePath: 'C:\\Windows\\System32\\notepad.exe',
    }

    const driverRegistryEntry: DiscoveredApplication = {
      source: 'registry',
      kind: 'win32',
      displayName: 'Realtek High Definition Audio Driver',
      publisher: 'Realtek',
      // No executablePath, no shortcutPath, no aumid, and does not correlate with Notepad
    }

    const catalog = deduplicateAndReconcile([validShortcut, driverRegistryEntry])
    expect(catalog.size).toBe(1)
    expect(Array.from(catalog.values())[0]?.displayName).toBe('Notepad')
  })
})
