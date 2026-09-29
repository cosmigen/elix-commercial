/** Real Windows acceptance for ELIX Phase 15 Application Runtime Core. */

import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AppRegistryService,
  DefaultAppLaunchAdapter,
  type AppDiscoveryProvider,
  type AppId,
} from '@deepseek-ai/dsh-app-registry'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowRegistryService, { type WindowId } from '@deepseek-ai/dsh-window-registry'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ApplicationRuntimeService from '../src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const WINDOW_WAIT_MS = 8_000

const RUST_GUI_SOURCE = `
#![windows_subsystem = "windows"]
#![allow(non_snake_case)]

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
    fn GetMessageW(lpMsg: *mut MSG, hWnd: isize, wMsgFilterMin: u32, wMsgFilterMax: u32) -> i32;
    fn TranslateMessage(lpMsg: *const MSG) -> i32;
    fn DispatchMessageW(lpMsg: *const MSG) -> isize;
    fn PostQuitMessage(nExitCode: i32);
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == 0x0010 /* WM_CLOSE */ || msg == 0x0002 /* WM_DESTROY */ {
        PostQuitMessage(0);
        return 0;
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    unsafe {
        let class_name = to_wide("TestAppClass");
        let title = to_wide("ELIX Phase 15 Acceptance");
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
            title.as_ptr(),
            0x00CF0000 /* WS_OVERLAPPEDWINDOW */,
            100, 100, 500, 400,
            0, 0, 0, 0,
        );
        ShowWindow(hwnd, 5 /* SW_SHOW */);
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, 0, 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
`

async function waitFor(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  refresh: () => Promise<unknown>,
): Promise<void> {
  const deadline = Date.now() + WINDOW_WAIT_MS
  while (Date.now() < deadline) {
    await refresh()
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Phase 15 live acceptance requires Windows')
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'elix-phase15-'))
  const rsSource = join(tempDir, 'acceptance_app.rs')
  const isolatedExe = join(tempDir, 'elix-phase15-app.exe')
  const cachePath = join(tempDir, 'app-registry-cache.json')

  await writeFile(rsSource, RUST_GUI_SOURCE, 'utf8')
  execFileSync('rustc', ['-O', rsSource, '-o', isolatedExe], { stdio: 'pipe' })

  const provider: AppDiscoveryProvider = {
    id: 'phase15-live-acceptance',
    discover: async () => [{
      source: 'manual',
      kind: 'win32',
      displayName: 'ELIX Phase 15 Acceptance App',
      executablePath: isolatedExe,
      aliases: ['phase15-acceptance'],
    }],
  }

  const bridge = createNativeBridge({ debug: false })
  const ctx = new Context()
  const ownedWindows = new Set<WindowId>()

  try {
    await bridge.connect()
    const capabilities = bridge.getCapabilities()
    if (!capabilities?.windowRegistry || !capabilities.windowControl) {
      throw new Error('Native host must advertise windowRegistry and windowControl capabilities')
    }

    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    ctx.plugin(WindowRegistryService, { enabled: true, bridge })
    ctx.plugin(WindowControlService, { enabled: true, bridge })
    ctx.plugin(AppRegistryService, {
      cachePath,
      autoRefreshOnStartup: false,
      customProviders: [provider],
      launchAdapter: new DefaultAppLaunchAdapter(),
      preferNative: false,
    })
    ctx.plugin(ApplicationRuntimeService, { enabled: true })

    await sleep(250)
    await ctx.appRegistry.refresh()
    await ctx.windowRegistry.refresh()

    const app = ctx.appRegistry.search('ELIX Phase 15 Acceptance App')[0]
    if (!app) throw new Error('Acceptance AppId was not created by App Registry')
    const appId = app.id as AppId

    console.log('='.repeat(72))
    console.log('   ELIX Phase 15 — Application Runtime Live Acceptance')
    console.log('='.repeat(72))
    console.log(`[AppId] ${appId}`)
    console.log(`[Executable] ${isolatedExe}`)

    if (ctx.applicationRuntime.hasObservedWindows(appId)) {
      throw new Error('Isolated acceptance app unexpectedly had a pre-existing observed window')
    }

    const launch = await ctx.applicationRuntime.launchOrActivate(appId)
    if (launch.action !== 'launch-requested' || !launch.completed) {
      throw new Error(`launchOrActivate did not launch cleanly: ${JSON.stringify(launch)}`)
    }
    if (launch.windowId !== undefined) {
      throw new Error('Launch result fabricated a WindowId before Window Registry observed one')
    }
    console.log('[PASS] launch request completed without fabricating a WindowId')

    await waitFor(
      'first isolated application window',
      () => ctx.applicationRuntime.hasObservedWindows(appId),
      () => ctx.windowRegistry.refresh(),
    )

    let entry = ctx.applicationRuntime.getApplication(appId)
    if (!entry || entry.windows.length !== 1) {
      throw new Error(`Expected exactly one mapped runtime window, got ${entry?.windows.length ?? 0}`)
    }
    const firstWindowId = entry.windows[0]!.id
    ownedWindows.add(firstWindowId)
    if (ctx.applicationRuntime.getMostRecentWindow(appId)?.id !== firstWindowId) {
      throw new Error('Application Runtime getMostRecentWindow did not expose the real WindowId')
    }
    console.log(`[PASS] mapped AppId -> WindowId ${firstWindowId}`)
    console.log(`[PASS] Application Runtime exposes real WindowId ${firstWindowId}`)

    const minimize = await ctx.windowControl.minimize(firstWindowId)
    if (!minimize.accepted) throw new Error('Window Control rejected minimize during acceptance')
    await waitFor(
      'minimized runtime state',
      () => ctx.applicationRuntime.getApplication(appId)?.windows.some(window =>
        window.id === firstWindowId && window.isMinimized) === true,
      () => ctx.windowRegistry.refresh(),
    )

    const restoreAndActivate = await ctx.applicationRuntime.launchOrActivate(appId)
    if (restoreAndActivate.action === 'restored-and-activated' && restoreAndActivate.completed) {
      console.log('[PASS] minimized MRU window restored and activated instead of duplicate launch')
    } else if (restoreAndActivate.failure?.code === 'FOREGROUND_DENIED' && restoreAndActivate.restoreResult?.completed) {
      console.log('[PASS] minimized MRU window restored; Windows foreground activation denied as expected for background process')
    } else {
      throw new Error(`Expected restore+activate or restore+FOREGROUND_DENIED, got: ${JSON.stringify(restoreAndActivate)}`)
    }

    await waitFor(
      'restored runtime state',
      () => ctx.applicationRuntime.getApplication(appId)?.windows.some(window =>
        window.id === firstWindowId && !window.isMinimized) === true,
      () => ctx.windowRegistry.refresh(),
    )

    const secondLaunch = await ctx.appRegistry.launch(appId)
    if (!secondLaunch.success) {
      throw new Error(`Failed to launch isolated second instance: ${secondLaunch.error ?? 'unknown'}`)
    }
    await waitFor(
      'second isolated application window',
      () => (ctx.applicationRuntime.getApplication(appId)?.windows.length ?? 0) >= 2,
      () => ctx.windowRegistry.refresh(),
    )

    entry = ctx.applicationRuntime.getApplication(appId)
    if (!entry || entry.windows.length < 2) throw new Error('Second mapped window did not appear')
    for (const window of entry.windows) ownedWindows.add(window.id)
    const secondWindow = entry.windows.find(window => window.id !== firstWindowId)
    if (!secondWindow) throw new Error('Could not identify second WindowId')
    console.log('[PASS] both isolated application windows mapped to the same AppId')

    try {
      const activateSecond = await ctx.windowControl.activate(secondWindow.id)
      if (activateSecond.completed) {
        await waitFor(
          'second window to become Application Runtime MRU',
          () => ctx.applicationRuntime.getApplication(appId)?.mruWindowIds[0] === secondWindow.id,
          () => ctx.windowRegistry.refresh(),
        )
        if (ctx.applicationRuntime.getMostRecentWindow(appId)?.id !== secondWindow.id) {
          throw new Error('Application Runtime did not select the newly foreground second window as MRU')
        }
        console.log('[PASS] multi-window MRU follows authoritative foreground observation')
      } else {
        console.log('[PASS] second-window activation attempted; completed false under Windows foreground policy')
      }
    } catch (error: unknown) {
      if (error && typeof error === 'object' && 'code' in error && (error as { code: unknown }).code === 'FOREGROUND_DENIED') {
        console.log('[PASS] second-window activation attempted; Windows denied foreground lock as expected')
      } else {
        throw error
      }
    }

    const snapshot = ctx.applicationRuntime.getSnapshot()
    if (snapshot.unmatchedWindows.some(item => ownedWindows.has(item.windowId))) {
      throw new Error('An owned acceptance WindowId was simultaneously published as unmatched')
    }
    console.log('[PASS] no mapped acceptance window was double-owned or published as unmatched')

    console.log('\nPhase 15 live acceptance PASSED')
  } finally {
    for (const windowId of [...ownedWindows]) {
      await ctx.windowControl?.close(windowId).catch(() => undefined)
    }
    await sleep(250)
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('\nPhase 15 live acceptance FAILED')
  console.error(error)
  process.exitCode = 1
})
