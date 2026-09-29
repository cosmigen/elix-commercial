/** Real Windows acceptance for ELIX Phase 16D Process + Application Lifecycle. */

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
import ProcessObservationService from '@deepseek-ai/dsh-process-observation'
import { createNativeBridge } from '@deepseek-ai/dsh-native-core'
import WindowControlService from '@deepseek-ai/dsh-window-control'
import WindowRegistryService from '@deepseek-ai/dsh-window-registry'
import WindowsContextService from '@deepseek-ai/dsh-windows-context'
import ApplicationRuntimeService from '../src/index.ts'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const STATE_WAIT_MS = 12_000
const SERVICE_BOOT_WAIT_MS = 6_000
const VISIBLE_HOLD_MS = 3_000

const RUST_LIFECYCLE_SOURCE = String.raw`
#![windows_subsystem = "windows"]
#![allow(non_snake_case)]

use std::env;
use std::path::Path;
use std::thread;
use std::time::Duration;

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
    fn PeekMessageW(lpMsg: *mut MSG, hWnd: isize, wMsgFilterMin: u32, wMsgFilterMax: u32, wRemoveMsg: u32) -> i32;
    fn TranslateMessage(lpMsg: *const MSG) -> i32;
    fn DispatchMessageW(lpMsg: *const MSG) -> isize;
}

unsafe extern "system" fn wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == 0x0002 /* WM_DESTROY */ {
        // Intentionally keep the process alive after its last window disappears.
        return 0;
    }
    // DefWindowProcW owns the standard WM_CLOSE -> DestroyWindow transition.
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    let stop_file = env::args().nth(1).unwrap_or_default();

    // Phase 16D acceptance needs a real background-only interval before a window exists.
    thread::sleep(Duration::from_millis(3000));
    if !stop_file.is_empty() && Path::new(&stop_file).exists() {
        return;
    }

    unsafe {
        let class_name = to_wide("ElixPhase16DLifecycleClass");
        let title = to_wide("ELIX Phase 16D — Real Lifecycle Window");
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
            160, 140, 620, 420,
            0, 0, 0, 0,
        );
        if hwnd == 0 {
            return;
        }
        ShowWindow(hwnd, 5 /* SW_SHOW */);

        loop {
            if !stop_file.is_empty() && Path::new(&stop_file).exists() {
                break;
            }

            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, 0, 0, 0, 1 /* PM_REMOVE */) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}
`

async function waitForBootServices(ctx: Context): Promise<void> {
  const deadline = Date.now() + SERVICE_BOOT_WAIT_MS
  while (Date.now() < deadline) {
    if (
      ctx.processObservation
      && ctx.windowRegistry
      && ctx.windowControl
      && ctx.appRegistry
      && ctx.applicationRuntime
    ) {
      return
    }
    await sleep(50)
  }

  const missing = [
    ['processObservation', ctx.processObservation],
    ['windowRegistry', ctx.windowRegistry],
    ['windowControl', ctx.windowControl],
    ['appRegistry', ctx.appRegistry],
    ['applicationRuntime', ctx.applicationRuntime],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(', ')

  throw new Error(`Timed out waiting for Cordis services to initialize. Missing: ${missing || 'unknown'}`)
}

async function refreshAuthorities(ctx: Context): Promise<void> {
  if (!ctx.processObservation || !ctx.windowRegistry) {
    throw new Error('Process Observation or Window Registry is unavailable during live acceptance')
  }
  await Promise.all([
    ctx.processObservation.refresh(),
    ctx.windowRegistry.refresh(),
  ])
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  refresh: () => Promise<void>,
): Promise<void> {
  const deadline = Date.now() + STATE_WAIT_MS
  while (Date.now() < deadline) {
    await refresh()
    if (predicate()) return
    await sleep(75)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function printRuntimeState(ctx: Context, appId: AppId, expected: string): void {
  const entry = ctx.applicationRuntime.getApplication(appId)
  const state = ctx.applicationRuntime.getApplicationState(appId)
  const processEntry = entry?.processes[0]

  console.log('')
  console.log('-'.repeat(72))
  console.log(`[EXPECTED] ${expected}`)
  console.log(`[STATE]    ${state.toUpperCase()}`)
  console.log(`[AppId]    ${appId}`)
  console.log(`[PID]      ${processEntry?.identity.pid ?? '-'}`)
  console.log(`[Created]  ${processEntry?.identity.creationTime ?? '-'}`)
  console.log(`[Exe]      ${processEntry?.executablePath ?? '-'}`)
  console.log(`[Processes] ${entry?.processes.length ?? 0}`)
  console.log(`[Windows]   ${entry?.windows.length ?? 0}`)
  console.log('-'.repeat(72))

  if (state !== expected) {
    throw new Error(`Expected lifecycle state '${expected}', observed '${state}'`)
  }
}

async function main(): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('Phase 16D live acceptance requires Windows')
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'elix-phase16d-'))
  const rustSource = join(tempDir, 'lifecycle_app.rs')
  const executablePath = join(tempDir, 'elix-phase16d-lifecycle.exe')
  const stopFile = join(tempDir, 'stop.signal')
  const cachePath = join(tempDir, 'app-registry-cache.json')

  await writeFile(rustSource, RUST_LIFECYCLE_SOURCE, 'utf8')
  execFileSync('rustc', ['-O', rustSource, '-o', executablePath], { stdio: 'inherit' })

  const provider: AppDiscoveryProvider = {
    id: 'phase16d-live-acceptance',
    discover: async () => [{
      source: 'manual',
      kind: 'win32',
      displayName: 'ELIX Phase 16D Lifecycle App',
      executablePath,
      aliases: ['phase16d-lifecycle'],
    }],
  }

  const nativeHostPath = join(process.cwd(), 'native', 'target', 'debug', 'elix-native-host.exe')
  const bridge = createNativeBridge({ binaryPath: nativeHostPath, debug: false })
  const ctx = new Context()
  let appId: AppId | undefined

  try {
    console.log('='.repeat(72))
    console.log('   ELIX Phase 16D — REAL WINDOWS PROCESS LIFECYCLE ACCEPTANCE')
    console.log('='.repeat(72))
    console.log('[INFO] This test uses a real Windows process and a real Win32 window.')
    console.log('[INFO] A visible test window will appear after the background-only stage.')
    console.log(`[INFO] Native host: ${nativeHostPath}`)

    await bridge.connect()
    const capabilities = bridge.getCapabilities() as { processObservation?: boolean } | undefined
    if (capabilities?.processObservation !== true) {
      throw new Error(
        'Connected native host does not advertise processObservation. '
        + 'The host binary is stale or from an older ELIX phase; rebuild the current native host.',
      )
    }

    ctx.plugin(WindowsContextService, { enabled: true, bridge })
    ctx.plugin(WindowRegistryService, { enabled: true, pollIntervalMs: 250, bridge })
    ctx.plugin(WindowControlService, { enabled: true, bridge })
    ctx.plugin(ProcessObservationService, { enabled: true, pollIntervalMs: 250, bridge })
    ctx.plugin(AppRegistryService, {
      cachePath,
      autoRefreshOnStartup: false,
      customProviders: [provider],
      launchAdapter: new DefaultAppLaunchAdapter(),
      preferNative: false,
    })
    ctx.plugin(ApplicationRuntimeService, { enabled: true })

    await waitForBootServices(ctx)
    await ctx.appRegistry.refresh()
    await refreshAuthorities(ctx)

    const app = ctx.appRegistry.search('ELIX Phase 16D Lifecycle App')[0]
    if (!app) throw new Error('Acceptance AppId was not created by App Registry')
    appId = app.id as AppId

    await waitFor(
      'Application Runtime readiness',
      () => ctx.applicationRuntime.ready,
      () => refreshAuthorities(ctx),
    )

    printRuntimeState(ctx, appId, 'stopped')
    console.log('[PASS 1/4] no process and no window = STOPPED')

    const launch = await ctx.applicationRuntime.launchOrActivate(appId, {
      additionalArgs: [stopFile],
    })
    if (launch.action !== 'launch-requested' || !launch.completed || !launch.launchResult?.success) {
      throw new Error(`Lifecycle helper did not launch cleanly: ${JSON.stringify(launch)}`)
    }
    const launchedPid = launch.launchResult.pid
    console.log(`[INFO] launched real PID ${launchedPid ?? '(not returned)'}`)

    await waitFor(
      'background-only application state',
      () => ctx.applicationRuntime.getApplicationState(appId!) === 'background'
        && ctx.applicationRuntime.getApplicationProcesses(appId!).length > 0
        && ctx.applicationRuntime.getApplicationWindows(appId!).length === 0,
      () => refreshAuthorities(ctx),
    )
    printRuntimeState(ctx, appId, 'background')
    console.log('[PASS 2/4] real process with zero windows = BACKGROUND')

    await waitFor(
      'visible application window',
      () => ctx.applicationRuntime.getApplicationState(appId!) === 'running'
        && ctx.applicationRuntime.getApplicationWindows(appId!).length > 0,
      () => refreshAuthorities(ctx),
    )
    printRuntimeState(ctx, appId, 'running')
    console.log('[PASS 3/4] window appeared while process stayed alive = RUNNING')
    console.log(`[VISUAL] The real test window will remain visible for ${VISIBLE_HOLD_MS / 1000} seconds.`)
    await sleep(VISIBLE_HOLD_MS)

    const runtimeEntry = ctx.applicationRuntime.getApplication(appId)
    const window = runtimeEntry?.windows[0]
    if (!window) throw new Error('RUNNING state had no real WindowId')

    const closeResult = await ctx.windowControl.close(window.id)
    if (!closeResult.accepted) {
      throw new Error(`Window Control rejected close for real WindowId '${window.id}'`)
    }

    await waitFor(
      'background state after last window closes',
      () => ctx.applicationRuntime.getApplicationState(appId!) === 'background'
        && ctx.applicationRuntime.getApplicationProcesses(appId!).length > 0
        && ctx.applicationRuntime.getApplicationWindows(appId!).length === 0,
      () => refreshAuthorities(ctx),
    )
    printRuntimeState(ctx, appId, 'background')
    console.log('[PASS] last window closed but real process remained = BACKGROUND')

    await writeFile(stopFile, 'exit', 'utf8')
    await waitFor(
      'stopped state after process exit',
      () => ctx.applicationRuntime.getApplicationState(appId!) === 'stopped'
        && ctx.applicationRuntime.getApplicationProcesses(appId!).length === 0
        && ctx.applicationRuntime.getApplicationWindows(appId!).length === 0,
      () => refreshAuthorities(ctx),
    )
    printRuntimeState(ctx, appId, 'stopped')
    console.log('[PASS 4/4] process exited and no windows remain = STOPPED')

    console.log('')
    console.log('='.repeat(72))
    console.log(' PHASE 16D LIVE ACCEPTANCE PASSED')
    console.log(' STOPPED -> BACKGROUND -> RUNNING -> BACKGROUND -> STOPPED')
    console.log('='.repeat(72))
  } finally {
    await writeFile(stopFile, 'exit', 'utf8').catch(() => undefined)
    await sleep(350)
    await ctx.fiber.dispose().catch(() => undefined)
    await bridge.dispose().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined)
  }
}

main().catch((error: unknown) => {
  console.error('')
  console.error('PHASE 16D LIVE ACCEPTANCE FAILED')
  console.error(error)
  process.exitCode = 1
})
