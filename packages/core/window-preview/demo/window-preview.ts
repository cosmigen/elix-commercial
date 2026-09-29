/** Real Windows acceptance for ELIX Phase 17A Window Preview + Visual Composition. */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createNativeBridge, type NativeBridgeClient } from '@deepseek-ai/dsh-native-core'
import SurfaceService from '@deepseek-ai/dsh-surface'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowRegistryService, { type WindowSnapshot } from '@deepseek-ai/dsh-window-registry'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import WindowPreviewService, { type PreviewLeaseSnapshot } from '../src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const WAIT_MS = 12_000
const VISUAL_HOLD_MS = 3_000
const SOURCE_CLASS = 'ElixPhase17APreviewSource'

const RUST_PREVIEW_SOURCE = String.raw`
#![windows_subsystem = "windows"]
#![allow(non_snake_case)]

use std::env;
use std::path::Path;
use std::thread;
use std::time::{Duration, Instant};

#[repr(C)]
struct WNDCLASSW {
    style: u32,
    lpfnWndProc: unsafe extern "system" fn(isize, u32, usize, isize) -> isize,
    cbClsExtra: i32,
    cbWndExtra: i32,
    hInstance: isize,
    hIcon: isize,
    hCursor: isize,
    hbrBackground: isize,
    lpszMenuName: *const u16,
    lpszClassName: *const u16,
}

#[repr(C)]
struct MSG {
    hwnd: isize,
    message: u32,
    wParam: usize,
    lParam: isize,
    time: u32,
    pt: [i32; 2],
}

#[link(name = "user32")]
extern "system" {
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn RegisterClassW(lpWndClass: *const WNDCLASSW) -> u16;
    fn CreateWindowExW(
        dwExStyle: u32,
        lpClassName: *const u16,
        lpWindowName: *const u16,
        dwStyle: u32,
        X: i32,
        Y: i32,
        nWidth: i32,
        nHeight: i32,
        hWndParent: isize,
        hMenu: isize,
        hInstance: isize,
        lpParam: isize,
    ) -> isize;
    fn ShowWindow(hWnd: isize, nCmdShow: i32) -> i32;
    fn DestroyWindow(hWnd: isize) -> i32;
    fn SetWindowTextW(hWnd: isize, lpString: *const u16) -> i32;
    fn PeekMessageW(lpMsg: *mut MSG, hWnd: isize, wMsgFilterMin: u32, wMsgFilterMax: u32, wRemoveMsg: u32) -> i32;
    fn TranslateMessage(lpMsg: *const MSG) -> i32;
    fn DispatchMessageW(lpMsg: *const MSG) -> isize;
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == 0x0010 {
        DestroyWindow(hwnd);
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    let stop_file = env::args().nth(1).unwrap_or_default();
    unsafe {
        let class_name = wide("ElixPhase17APreviewSource");
        let initial_title = wide("ELIX Phase 17A Live Source — frame 0");
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: wnd_proc,
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: 0,
            hIcon: 0,
            hCursor: 0,
            hbrBackground: 6,
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
        };
        RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            initial_title.as_ptr(),
            0x00CF0000,
            100, 100, 700, 430,
            0, 0, 0, 0,
        );
        if hwnd == 0 { return; }
        ShowWindow(hwnd, 5);

        let mut frame = 0u64;
        let mut last_title = Instant::now();
        loop {
            if !stop_file.is_empty() && Path::new(&stop_file).exists() { break; }
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, 0, 0, 0, 1) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if last_title.elapsed() >= Duration::from_millis(350) {
                frame += 1;
                let title = wide(&format!("ELIX Phase 17A Live Source — frame {}", frame));
                SetWindowTextW(hwnd, title.as_ptr());
                last_title = Instant::now();
            }
            thread::sleep(Duration::from_millis(16));
        }
        DestroyWindow(hwnd);
    }
}
`

function destinationHtml(label: string): string {
  return `<!doctype html><html><head><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;color:#f6f7fb;font-family:Segoe UI,sans-serif;overflow:hidden}
    .label{height:48px;padding:13px 18px;box-sizing:border-box;font-weight:700;background:rgba(15,17,22,.82)}
    .frame{position:absolute;left:20px;right:20px;top:58px;height:244px;border:1px solid rgba(190,200,220,.55);border-radius:12px;pointer-events:none}
    .note{position:absolute;left:20px;right:20px;top:310px;font-size:12px;color:#d3d9e4;background:rgba(15,17,22,.72);padding:6px 8px;border-radius:6px}
  </style></head><body><div class="label">${label}</div><div class="frame"></div><div class="note">Transparent WebView2 overlay; live pixels below are composed by DWM. No frame bytes cross JSON IPC.</div></body></html>`
}

async function waitFor(label: string, predicate: () => boolean, refresh: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (Date.now() < deadline) {
    await refresh()
    if (predicate()) return
    await sleep(75)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function activeNativePreviews(bridge: NativeBridgeClient): Promise<number> {
  const result = await bridge.sendRequest<{ readonly previews: readonly unknown[] }>('preview/getActive', {})
  return result.previews.length
}

function printLease(label: string, lease: PreviewLeaseSnapshot | undefined): void {
  console.log(`[${label}] state=${lease?.state ?? 'missing'} backend=${lease?.backend ?? '-'} reason=${lease?.reason ?? '-'} source=${lease?.contentWidth ?? '-'}x${lease?.contentHeight ?? '-'}`)
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Phase 17A live acceptance requires Windows')

  const tempDir = await mkdtemp(join(tmpdir(), 'elix-phase17a-'))
  const sourcePath = join(tempDir, 'preview_source.rs')
  const executablePath = join(tempDir, 'elix-phase17a-preview-source.exe')
  const stopFile = join(tempDir, 'stop.signal')
  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  let sourceProcess: ChildProcess | undefined

  await writeFile(sourcePath, RUST_PREVIEW_SOURCE, 'utf8')
  execFileSync('rustc', ['-O', sourcePath, '-o', executablePath], { stdio: 'inherit' })

  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()
  let firstLeaseId: string | undefined
  let secondLeaseId: string | undefined

  try {
    console.log('='.repeat(76))
    console.log(' ELIX Phase 17A — REAL DWM WINDOW PREVIEW / VISUAL COMPOSITION ACCEPTANCE')
    console.log('='.repeat(76))
    console.log('[INFO] Two transparent ELIX surfaces and one animated Win32 source will appear.')
    console.log('[INFO] The changing source caption must be visible live inside both framed regions.')

    await bridge.connect()
    if (bridge.getCapabilities()?.windowPreview !== true) {
      throw new Error('Native host does not advertise windowPreview; rebuild the current Phase 17A native host.')
    }

    await ctx.plugin(WindowsContextService, { enabled: true, bridge })
    await ctx.plugin(SurfaceService, { enabled: true, bridge })
    await ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    await ctx.plugin(WindowControlService, { enabled: true, bridge })
    await ctx.plugin(WindowPreviewService, { enabled: true, maxLivePreviews: 8, bridge })
    await sleep(250)

    sourceProcess = spawn(executablePath, [stopFile], { stdio: 'ignore', windowsHide: false })
    const refresh = async () => {
      await ctx.windowRegistry.refresh()
      await ctx.windowPreview.refresh()
    }

    let source: WindowSnapshot | undefined
    await waitFor('real Phase 17A source window', () => {
      source = ctx.windowRegistry.getWindows().find(window => window.className === SOURCE_CLASS)
      return Boolean(source)
    }, refresh)
    if (!source) throw new Error('Window Registry did not expose the real source WindowId')
    console.log(`[PASS 1/7] source resolved as stable WindowId ${source.id}`)

    const primary = ctx.windowsContext.getPrimaryMonitor()
    const baseX = primary.workArea.x
    const baseY = primary.workArea.y
    const availableWidth = primary.workArea.width
    const surfaceWidth = Math.min(480, Math.max(360, Math.floor((availableWidth - 60) / 2)))
    const surfaceHeight = 350

    const dockSurface = await ctx.surface.create({
      id: 'phase17a:dock-consumer',
      bounds: { x: baseX + 20, y: baseY + 30, width: surfaceWidth, height: surfaceHeight },
      renderer: { type: 'html', target: destinationHtml('Dock preview consumer') },
      focusPolicy: 'noActivate',
      zOrderPolicy: 'topmost',
      skipTaskbar: true,
      transparent: true,
      visible: false,
    })
    const overviewSurface = await ctx.surface.create({
      id: 'phase17a:overview-consumer',
      bounds: { x: baseX + 40 + surfaceWidth, y: baseY + 30, width: surfaceWidth, height: surfaceHeight },
      renderer: { type: 'html', target: destinationHtml('Overview preview consumer') },
      focusPolicy: 'noActivate',
      zOrderPolicy: 'topmost',
      skipTaskbar: true,
      transparent: true,
      visible: false,
    })

    await Promise.all([dockSurface.whenReady(), overviewSurface.whenReady()])
    await Promise.all([dockSurface.show(), overviewSurface.show()])
    await sleep(250)

    const previewRect = { x: 20, y: 58, width: surfaceWidth - 40, height: 244 }
    const first = await ctx.windowPreview.acquirePreview({
      sourceWindowId: source.id,
      destinationSurfaceId: dockSurface.id,
      destinationRect: previewRect,
      consumerId: 'phase17a-dock',
      importance: 'high',
    })
    const second = await ctx.windowPreview.acquirePreview({
      sourceWindowId: source.id,
      destinationSurfaceId: overviewSurface.id,
      destinationRect: previewRect,
      consumerId: 'phase17a-overview',
      importance: 'normal',
    })
    firstLeaseId = first.id
    secondLeaseId = second.id

    await waitFor('two live preview relationships', () => {
      const stats = ctx.windowPreview.getStats()
      return stats.live === 2 && stats.nativeBindings === 2
    }, refresh)
    printLease('DOCK', ctx.windowPreview.getLease(first.id))
    printLease('OVERVIEW', ctx.windowPreview.getLease(second.id))
    if (await activeNativePreviews(bridge) !== 2) throw new Error('Expected two native DWM relationships')
    console.log('[PASS 2/7] simultaneous Dock + Overview consumers are LIVE (native bindings=2)')
    console.log(`[VISUAL] Verify the source frame number changes in both previews for ${VISUAL_HOLD_MS / 1000} seconds.`)
    try {
      execFileSync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'artifacts/phase17a-verification/capture.ps1',
        'artifacts/phase17a-verification/PASS_17A_DWM_composition.png',
      ], { stdio: 'ignore' })
    } catch {
      // Best-effort visual evidence capture
    }
    await sleep(VISUAL_HOLD_MS)

    await dockSurface.hide()
    await waitFor('hidden consumer pause', () => (
      ctx.windowPreview.getLease(first.id)?.state === 'paused'
      && ctx.windowPreview.getLease(second.id)?.state === 'live'
    ), refresh)
    if (await activeNativePreviews(bridge) !== 1) throw new Error('Hidden destination did not release its DWM relationship')
    console.log('[PASS 3/7] hiding one consumer releases only its native relationship')

    await dockSurface.show()
    await waitFor('hidden consumer resume', () => ctx.windowPreview.getStats().live === 2, refresh)
    if (await activeNativePreviews(bridge) !== 2) throw new Error('Shown destination did not reclaim its DWM relationship')
    console.log('[PASS 4/7] showing the consumer reclaims its live preview')

    const minimized = await ctx.windowControl.minimize(source.id)
    if (!minimized.accepted) throw new Error('Window Control rejected source minimize')
    await waitFor('source minimized fallback', () => (
      ctx.windowPreview.getLease(first.id)?.state === 'unavailable'
      && ctx.windowPreview.getLease(second.id)?.state === 'unavailable'
    ), refresh)
    if (await activeNativePreviews(bridge) !== 0) throw new Error('Minimized source retained active DWM previews')
    console.log('[PASS 5/7] minimized source uses fallback; Preview never restores it just to capture')

    const restored = await ctx.windowControl.restore(source.id)
    if (!restored.accepted) throw new Error('Window Control rejected explicit source restore')
    await waitFor('source restore preview recovery', () => ctx.windowPreview.getStats().live === 2, refresh)
    if (await activeNativePreviews(bridge) !== 2) throw new Error('Explicit restore did not recover DWM previews')
    console.log('[PASS 6/7] explicit external restore returns both leases to LIVE')

    await writeFile(stopFile, 'exit', 'utf8')
    await waitFor('source destruction cleanup', () => (
      ctx.windowPreview.getLease(first.id)?.state === 'destroyed'
      && ctx.windowPreview.getLease(second.id)?.state === 'destroyed'
    ), refresh)
    if (await activeNativePreviews(bridge) !== 0) throw new Error('Destroyed source leaked native DWM relationships')
    console.log('[PASS 7/7] source destruction releases all native preview relationships')

    await ctx.windowPreview.releasePreview(first.id)
    await ctx.windowPreview.releasePreview(second.id)
    firstLeaseId = undefined
    secondLeaseId = undefined
    await Promise.all([ctx.surface.destroy(dockSurface.id), ctx.surface.destroy(overviewSurface.id)])
    await sleep(200)

    const finalActive = await activeNativePreviews(bridge)
    if (finalActive !== 0 || ctx.windowPreview.getStats().nativeBindings !== 0) {
      throw new Error(`Final preview cleanup failed: native=${finalActive}, service=${ctx.windowPreview.getStats().nativeBindings}`)
    }

    console.log('')
    console.log('='.repeat(76))
    console.log(' PHASE 17A LIVE ACCEPTANCE PASSED')
    console.log(' DWM COMPOSITION + TWO CONSUMERS + PAUSE/RESUME + FALLBACK + ZERO LEAKS')
    console.log('='.repeat(76))
  } finally {
    await writeFile(stopFile, 'exit', 'utf8').catch(() => undefined)
    if (firstLeaseId && ctx.windowPreview) await ctx.windowPreview.releasePreview(firstLeaseId).catch(() => undefined)
    if (secondLeaseId && ctx.windowPreview) await ctx.windowPreview.releasePreview(secondLeaseId).catch(() => undefined)
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    if (sourceProcess && sourceProcess.exitCode === null) sourceProcess.kill()
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error('')
  console.error('PHASE 17A LIVE ACCEPTANCE FAILED')
  console.error(error)
  process.exitCode = 1
})
