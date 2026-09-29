import { describe, expect, it } from 'vitest'
import {
  APP_FOLDER_PRESENTATION_CLIENT_SCRIPT,
  APP_FOLDER_PRESENTATION_CSS,
  decorateHomeDocument,
} from '../src/app-folder-presentation.ts'

describe('Old ELIX App Folder presentation', () => {
  it('opens App Folders from the first click-sized gesture without stealing drags', () => {
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('data-is-app-folder="true"')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('Math.hypot(event.clientX-gesture.startX,event.clientY-gesture.startY)>=8')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('document.addEventListener("pointerup"')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('setTimeout(function(){openFolder(active.id);},0)')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('type:"openFolder"')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('pointercancel')
  })

  it('ports the Old ELIX close convergence animation', () => {
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('duration:185')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('delay:Math.min(48,index*6)')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('scale(.28)')
    expect(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT).toContain('elix-folder-item-origin-close')
  })

  it('keeps the folder sharp while strongly blurring the surrounding Home layers', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain(':has(>.app-folder-overlay)>.item-layer')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('filter:blur(18px)')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-window{')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('backdrop-filter:blur(52px)')
  })

  it('keeps the rename editor actually hidden until edit is requested', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-name-editor[hidden],.app-folder-title[hidden]{display:none!important}')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-meta{height:0!important')
  })

  it('adapts folder icons, columns, and labels to the available folder width', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('repeat(auto-fit,minmax(min(5.5rem,28cqi),1fr))')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('inline-size:12cqi!important')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('aspect-ratio:1!important')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('white-space:normal!important')
    expect(APP_FOLDER_PRESENTATION_CSS).not.toContain('.app-folder-icon-ring{width:52px')
    expect(APP_FOLDER_PRESENTATION_CSS).not.toContain('.app-folder-app-label{margin-top:7px')
  })

  it('does not add a palette panel and only exposes the existing compact color control', () => {
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-color-cycle{display:none!important}')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('.app-folder-window.is-managing .app-folder-color-cycle{')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('display:grid!important')
    expect(APP_FOLDER_PRESENTATION_CSS).toContain('animation:elix-folder-control-enter')
    expect(APP_FOLDER_PRESENTATION_CSS).not.toContain('palette-panel')
    expect(APP_FOLDER_PRESENTATION_CSS).not.toContain('padlet')
  })

  it('decorates the renderer document under the existing CSP nonce', () => {
    const source = '<html><head><style>base</style></head><body>home</body></html>'
    const output = decorateHomeDocument(source, 'nonce_123')
    expect(output).toContain(APP_FOLDER_PRESENTATION_CSS)
    expect(output).toContain('<script nonce="nonce_123">')
    expect(output).toContain(APP_FOLDER_PRESENTATION_CLIENT_SCRIPT)
  })
})
