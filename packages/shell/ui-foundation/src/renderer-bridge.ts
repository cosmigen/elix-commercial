/** Renderer message bridge for applying shared UI state without recreating surfaces. */

import type { UiFoundationState } from './types.ts'

/** Host-to-renderer UI foundation message. */
export interface UiFoundationStateMessage {
  readonly type: 'elix/ui-foundation/state'
  readonly revision: number
  readonly resolvedColorScheme: UiFoundationState['resolved']['resolvedColorScheme']
  readonly density: UiFoundationState['resolved']['applied']['appearance']['density']
  readonly reduceMotion: boolean
  readonly tokens: Readonly<Record<string, string>>
}

/** Convert shared state into the stable renderer message format. */
export function createUiFoundationStateMessage(state: UiFoundationState): UiFoundationStateMessage {
  return {
    type: 'elix/ui-foundation/state',
    revision: state.revision,
    resolvedColorScheme: state.resolved.resolvedColorScheme,
    density: state.resolved.applied.appearance.density,
    reduceMotion: state.resolved.applied.accessibility.reduceMotion,
    tokens: state.tokens,
  }
}

/**
 * Script installed by Home, overlays, and future shell renderers.
 * It applies CSS variables in-place and reports system media preferences back to the host.
 */
export function createUiFoundationRendererBridgeScript(): string {
  return `(function(){
    var root=document.documentElement;
    var lastRevision=-1;
    function apply(data){
      if(!data||data.type!=='elix/ui-foundation/state'||typeof data.revision!=='number'||data.revision<lastRevision)return;
      lastRevision=data.revision;
      var tokens=data.tokens||{};
      Object.keys(tokens).forEach(function(key){if(key.indexOf('--elix-')===0)root.style.setProperty(key,String(tokens[key]));});
      root.dataset.elixColorScheme=String(data.resolvedColorScheme||'dark');
      root.dataset.elixDensity=String(data.density||'standard');
      root.dataset.elixReduceMotion=data.reduceMotion?'true':'false';
      root.style.setProperty('--elix-color-scheme',data.resolvedColorScheme==='light'?'light':'dark');
    }
    function report(){
      if(!(window.chrome&&window.chrome.webview))return;
      window.chrome.webview.postMessage({
        type:'elix/ui-foundation/system-appearance',
        colorScheme:window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark',
        highContrast:!!(window.matchMedia&&window.matchMedia('(forced-colors: active)').matches),
        reduceMotion:!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches)
      });
    }
    if(window.chrome&&window.chrome.webview){window.chrome.webview.addEventListener('message',function(event){apply(event.data);});}
    ['(prefers-color-scheme: light)','(forced-colors: active)','(prefers-reduced-motion: reduce)'].forEach(function(query){
      if(!window.matchMedia)return;
      var media=window.matchMedia(query);
      if(media.addEventListener)media.addEventListener('change',report);
    });
    report();
  })();`
}

/** Stable prebuilt bridge script for renderer documents. */
export const UI_FOUNDATION_RENDERER_BRIDGE_SCRIPT = createUiFoundationRendererBridgeScript()
