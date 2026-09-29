import { describe, expect, it } from 'vitest'
import {
  APP_FOLDER_PRESENTATION_CLIENT_SCRIPT,
  APP_FOLDER_PRESENTATION_CSS,
} from '../src/app-folder-presentation.ts'

describe('Phase 12 App Folder motion edge cases', () => {
  it('animates a removed app before committing the authoritative mutation', () => {
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('elix-folder-remove-app-release')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('type:"removeItemFromFolder"')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('duration:190')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('stopImmediatePropagation')
  })

  it('animates folder dissolve as apps dispersing before the folder mutation commits', () => {
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('elix-folder-dissolve-child')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('elix-folder-dissolve-panel')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('type:"deleteFolder"')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('duration:300')
  })

  it('adds micro-motion without introducing another state owner', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('elix-folder-control-enter')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('elix-folder-remove-control-enter')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('elix-folder-target-breathe')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-app:active')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-resize-grip:hover::after')
  })

  it('disables decorative motion under reduced-motion preference', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('@media (prefers-reduced-motion:reduce)')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('prefers-reduced-motion: reduce')
  })
})
