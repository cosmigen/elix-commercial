import { describe, expect, it } from 'vitest'
import { StartMenuProvider } from '../src/providers/start-menu.ts'
import { PackagedAppsProvider } from '../src/providers/packaged-apps.ts'
import { RegistryMetadataProvider } from '../src/providers/registry-metadata.ts'

describe('Windows Discovery Providers (Headless / Mocked)', () => {
  it('StartMenuProvider discovers shortcuts and filters non-application links', async () => {
    const provider = new StartMenuProvider({
      customScanner: async () => [
        {
          ShortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\7-Zip\\7-Zip File Manager.lnk',
          Name: '7-Zip File Manager',
          TargetPath: 'C:\\Program Files\\7-Zip\\7zFM.exe',
          Description: '7-Zip Archiver',
          IconLocation: 'C:\\Program Files\\7-Zip\\7zFM.exe,0',
        },
        {
          ShortcutPath: 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\7-Zip\\Uninstall 7-Zip.lnk',
          Name: 'Uninstall 7-Zip',
          TargetPath: 'C:\\Program Files\\7-Zip\\Uninstall.exe',
        },
        {
          ShortcutPath: 'C:\\Users\\User\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Editor.lnk',
          Name: 'Custom Editor',
          TargetPath: 'C:\\Tools\\editor.exe',
        },
      ],
    })

    const apps = await provider.discover()
    expect(apps.length).toBe(2)

    // Uninstaller filtered out
    expect(apps.some(a => a.displayName === 'Uninstall 7-Zip')).toBe(false)

    // 7-Zip is system
    const sevenZip = apps.find(a => a.displayName === '7-Zip File Manager')
    expect(sevenZip).toBeDefined()
    expect(sevenZip?.source).toBe('start-menu-system')
    expect(sevenZip?.kind).toBe('win32')

    // Custom Editor is user
    const editor = apps.find(a => a.displayName === 'Custom Editor')
    expect(editor).toBeDefined()
    expect(editor?.source).toBe('start-menu-user')
  })

  it('PackagedAppsProvider extracts AUMIDs, package family names, and publishers', async () => {
    const provider = new PackagedAppsProvider({
      customScanner: async () => [
        {
          Name: 'Calculator',
          AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App',
          PackageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe',
          Publisher: 'CN=Microsoft Corporation',
          InstallLocation: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator',
        },
        {
          Name: 'Terminal',
          AppID: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App',
          PackageFamilyName: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
          Publisher: 'CN=Microsoft Corporation',
        },
      ],
    })

    const apps = await provider.discover()
    expect(apps.length).toBe(2)

    const calc = apps.find(a => a.displayName === 'Calculator')
    expect(calc?.kind).toBe('packaged')
    expect(calc?.aumid).toBe('Microsoft.WindowsCalculator_8wekyb3d8bbwe!App')
    expect(calc?.packageFamilyName).toBe('Microsoft.WindowsCalculator_8wekyb3d8bbwe')
  })

  it('RegistryMetadataProvider extracts uninstall metadata', async () => {
    const provider = new RegistryMetadataProvider({
      customScanner: async () => [
        {
          KeyName: 'Git_is1',
          DisplayName: 'Git version 2.45.0',
          Publisher: 'The Git Development Community',
          InstallLocation: 'C:\\Program Files\\Git',
          DisplayIcon: 'C:\\Program Files\\Git\\cmd\\git-gui.exe',
          DisplayVersion: '2.45.0',
        },
      ],
    })

    const apps = await provider.discover()
    expect(apps.length).toBe(1)
    expect(apps[0]?.displayName).toBe('Git version 2.45.0')
    expect(apps[0]?.publisher).toBe('The Git Development Community')
    expect(apps[0]?.source).toBe('registry')
  })
})
