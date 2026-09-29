# ELIX OS — Full Visual Phase Audit 1–17B

Audit date: 2026-09-16. Repository: `C:/elix-commercial`. Branch: `phase-17b-placement-policy` tracking `origin/phase-17b-placement-policy`. Audited commit: `fac3d2af1bef47a691b1c5f8714bf12dbc34b525` (`chore: remove temporary Phase 17B verification workflow`).

## Scope and authority

The user request was to visually test every phase from Phase 1 through Phase 17B and retain screenshot evidence for successes and failures; the requested Phase 17B cloud branch was fetched and checked out before testing. The attached roadmap, audit report, and pasted protocol were used as the acceptance reference, not as additional authorization to change product behavior, commit, push, or silently repair failures.

No production implementation logic was changed. This run added audit-only runners, reports, and captures under `.agents/reports/visual-audit`; it also retained the 28-line `pnpm-lock.yaml` workspace-link refresh required by the supplied preflight. Existing untracked `.audit`, `artifacts`, the independent audit archive, and `packages/core/window-preview/demo/real-apps.ts` were preserved.

## Final verdict

The audit is not release-clear: the live visual surfaces work in several areas, but the failures listed below are reproducible. PASS means the executed scenario and its available visual/technical evidence passed. FAIL means at least one required scenario or teardown failed. BLOCKED means the environment prevented the check. NOT_IMPLEMENTED means the checked-out product does not expose the requested acceptance surface.

| Phase | Area | Result | What was observed | Evidence |
|---|---|---|---|---|
| 1 | Host foundation | PASS | Native bridge, WebView2 surfaces, and clean demo startup/shutdown worked on the available desktop. | [P02 Home](evidence/P02_home_live.png), [final clean desktop](evidence/P17B_final_clean_desktop.png) |
| 2 | Home engine | FAIL | Desktop items, widgets, wallpaper, folder creation, reorder, and persistence rendered; the active context-menu surface remained after restart. | [baseline](evidence/P02_home_live.png), [restart with stale overlay](evidence/P02_home_restart_persisted.png), [widget update](evidence/P02_home_widget_edit.png) |
| 3 | App Registry | PASS | Live discovery/launch integration passed; the Application Runtime resolved a real AppId and real WindowId. | [Phase 15 app window](evidence/P15_application_runtime_visible_window.png) |
| 4 | Desktop/File Provider foundation | PASS | Windows shell-namespace live/native integration passed; Home exposed a real Utilities folder surface. | [Utilities folder](evidence/P10_home_app_folder.png) |
| 5 | Rust Native Core | FAIL | Native live RPC coverage passed, but `cargo test --manifest-path native/Cargo.toml` had 70 passed, 1 failed, and 1 ignored. | [native-backed shell layout PASS](evidence/P16A_shell_layout_guided_pass.png) |
| 6 | Windows Context Core | PASS on available topology | The real monitor/DPI/foreground snapshot path passed for one monitor; secondary-monitor, negative-coordinate, portrait, and mixed-DPI checks were blocked. | [live geometry](evidence/P16A_shell_layout_guided_pass.png) |
| 7 | Surface Core | PASS | Real WebView2/native surface lifecycle tests passed and the UI Foundation surface rendered all captured states. | [dark UI gallery](evidence/P16B_ui_runner_dark.png) |
| 8 | Home Renderer | PASS | Home wallpaper, desktop shortcuts, Clock, Calendar, and Notes widgets rendered; interaction state was visibly reflected. | [Home baseline](evidence/P02_home_live.png), [folder/reorder](evidence/P02_home_folder_reorder.png) |
| 9 | Overlay/Dialog Runtime | FAIL | Centered and edge placement visuals worked and close-all returned zero active overlays, but live foreground/teardown assertions failed and rapid console input reproduced an async overlay crash. | [centered menu](evidence/P09_overlay_centered.png), [edge harness](evidence/P11_overlay_bottom_flip_fresh.png), [Home stale overlay](evidence/P10_home_overlay_close.png) |
| 10 | Home completion | FAIL | Context menu, app folder, wallpaper, widget edit, and persistence flows were exercised; overlay ownership was not cleared after folder close/restart. | [context menu](evidence/P10_home_context_menu.png), [folder close failure](evidence/P10_home_overlay_close.png) |
| 11 | Intent Router | PASS | Windows live intent-router, Home integration, and recovery tests passed; Home context actions reached the visible overlay path. | [context-menu visual](evidence/P10_home_context_menu.png) |
| 12 | Home/Desktop Integration | FAIL | Home and Overlay surfaces composed, but the context-menu surface remained active while another Home overlay and after restart. | [multiple overlays](evidence/P10_home_app_folder.png), [restart](evidence/P02_home_restart_persisted.png) |
| 13 | Window Registry | PASS | Live registry enumerated 389 windows, classified them, tracked foreground state, and recovered after an intentional native-host crash. | [supporting live window](evidence/P14_window_control_notepad_baseline.png) |
| 14 | Window Control | PASS | Real Notepad minimize/restore/maximize/move/resize, host recovery, close, and stale-ID rejection all passed. | [baseline](evidence/P14_window_control_notepad_baseline.png), [moved/resized](evidence/P14_window_control_moved_resized.png), [recovery](evidence/P14_window_control_recovered.png), [stale-ID](evidence/P14_window_control_closed_stale_rejected.png) |
| 15 | Application Runtime | PASS | Real App Registry launch, MRU restore/activation, multi-window mapping, and no-double-ownership acceptance passed. | [real runtime window](evidence/P15_application_runtime_visible_window.png) |
| 16A | Shell boundary ownership/recovery | FAIL | The guided live visual harness passed 40 px/52 px reservation, hide/show, and removal; package sweep still failed lifecycle, work-area, Home-publisher, multi-monitor, and native-authority assertions. | [guided PASS](evidence/P16A_shell_layout_guided_pass.png) |
| 16B | Preferences/design system/interaction | PASS with teardown warning | Dark/light/high-contrast/200% text/reduced-motion/opaque fallback/themed overlay captures passed; temporary WebView2 cleanup returned `EPERM`. | [high contrast](evidence/P16B_ui_runner_high_contrast.png), [200% text](evidence/P16B_ui_runner_200pct_text.png), [reduced motion](evidence/P16B_ui_runner_reduced_motion.png), [themed overlay](evidence/P16B_ui_runner_themed_overlay.png) |
| 16C | Theme assets/wallpaper/personalization | FAIL | Preset, wallpaper-effect, persistence, and revert assertions passed in the audit runner; both the shipped harness and runner hit temporary WebView2-directory `EPERM` during teardown. | [Ember](evidence/P16C_personalization_runner_ember.png), [effects](evidence/P16C_personalization_runner_effects.png), [persisted](evidence/P16C_personalization_runner_persisted.png), [reverted](evidence/P16C_personalization_runner_reverted.png) |
| 16D | Process/application lifecycle | PASS | Real process state transitioned `STOPPED → BACKGROUND → RUNNING → BACKGROUND → STOPPED`; all four acceptance checks passed. | [real lifecycle window](evidence/P16D_lifecycle_visible_window.png) |
| 17A | Window Preview/DWM composition | PASS | Built-in and real-app acceptance passed for Notepad, File Explorer, and Chromium/Edge with dual consumers, content updates, resize, minimize fallback, restore, and zero native leaks. | [Notepad live content](evidence/P17A_notepad_content_after.png), [Explorer live content](evidence/P17A_explorer_content_after.png), [Chromium live content](evidence/P17A_chromium_content_after.png) |
| 17B | Manual Window Placement Policy | FAIL | Against the freshly built debug native host, left-half and right-half placement applied; repeated placement restore rejected as `display-topology-unstable`. Against the stale release host, constraint negotiation rejected the unknown `queryPlacementConstraints` variant. | [left half](evidence/P17B_placement_left_half.png), [right half](evidence/P17B_placement_right_half.png), [restore failure](evidence/P17B_placement_restore_failure.png), [stale release-host failure](evidence/P17B_placement_failure_constraints.png) |

## Environment

Machine: Windows 11 Home Single Language `10.0.26200`, build `26200`, x64; CPU `Intel(R) Core(TM) 5 210H`; Node `v26.4.0`; pnpm `9.15.9`. The active display was `B160UAN08.1`, 1920×1200 at 144 Hz, 125% scale, with a 1920×1140 work area. Only one monitor was present to the native observer.

The native CUA/Sky RPC was unavailable (`Trusted RPC service is not configured: sky`), and no native app surface was exposed through the browser-only CUA inventory. Where a demo exposed only documented console commands, the commands were sent through its PTY; visual proof was captured from the real native windows/surfaces with the repository capture utility. No simulated click was counted as a visual pass.

## Commands and results

- `pnpm install --lockfile-only --ignore-scripts` — PASS; refreshed only the expected Phase 17B workspace links, followed by `pnpm install --frozen-lockfile --ignore-scripts` — PASS.
- `pnpm exec vitest run packages/shell/layout/tests/topology-serialization.spec.ts packages/shell/layout/tests/lifecycle.spec.ts packages/shell/window-placement/tests/service.spec.ts packages/bundle/windows-runtime/tests/composition.spec.ts` — FAIL: 3 files/25 tests passed; the in-flight Shell Layout disposal test timed out and its teardown hook also timed out.
- `pnpm exec tsc -b tsconfig.host.json --pretty false` — FAIL: `packages/shell/layout/src/service.ts:228` state comparison diagnostic; Application Runtime mock missing `getPlacementConstraints`; Window Placement test casts rejected by TypeScript.
- `pnpm exec vitest run packages/shell/home/tests packages/shell/overlay/tests packages/shell/ui-foundation/tests packages/shell/layout/tests` — FAIL: 45 files/375 tests passed; 6 files reported 14 failed tests/assertions/hooks, covering Shell Layout and live Overlay Windows checks.
- `pnpm exec vitest run packages/core/windows-context/tests/service.spec.ts packages/core/windows-context/tests/state.spec.ts packages/core/surface/tests/live.spec.ts` — PASS: 3 files/17 tests.
- `pnpm exec vitest run packages/services/shell-namespace/tests/windows-live.spec.ts packages/services/shell-namespace/tests/native-integration.spec.ts packages/services/shell-namespace/tests/desktop.spec.ts` — PASS: 3 files/11 tests.
- `pnpm exec vitest run packages/services/intent-router/tests/windows-live.spec.ts packages/services/intent-router/tests/home-integration.spec.ts packages/services/intent-router/tests/recovery.spec.ts` — PASS: 3 files/16 tests.
- `pnpm exec vitest run packages/services/app-registry/tests/windows-live.spec.ts packages/services/app-registry/tests/native-launch-integration.spec.ts` — PASS: 2 files/7 tests.
- `pnpm exec vitest run packages/native/core/tests/windows-live.spec.ts packages/native/core/tests/window-registry-live.spec.ts packages/native/core/tests/window-control-live.spec.ts` — PASS: 3 files/14 tests.
- `pnpm exec vitest run packages/core/window-control/tests/windows-live.spec.ts packages/core/window-registry/tests/live.spec.ts packages/core/surface/tests/live.spec.ts` — PASS: 3 files/6 tests.
- `pnpm exec vitest run packages/shell/overlay/tests/anchors.spec.ts packages/shell/overlay/tests/dismissal.spec.ts packages/shell/overlay/tests/dpi.spec.ts packages/shell/overlay/tests/lifecycle.spec.ts packages/shell/overlay/tests/nesting.spec.ts packages/shell/overlay/tests/placement.spec.ts packages/shell/overlay/tests/races.spec.ts packages/shell/overlay/tests/registration.spec.ts` — PASS: 8 files/87 tests.
- `pnpm exec vitest run packages/shell/layout/tests/windows-live.spec.ts` — PASS: 1 test.
- `pnpm exec vitest run packages/shell/home/tests/windows-live.spec.ts packages/shell/home/tests/surface-lifecycle.spec.ts packages/shell/home/tests/persistence.spec.ts packages/shell/home/tests/personalization.spec.ts` — PASS: 4 files/16 tests.
- `pnpm exec vitest run packages/services/application-runtime/tests/service.spec.ts packages/services/application-runtime/tests/process-lifecycle.spec.ts` — PASS: 2 files/26 tests.
- `pnpm exec vitest run packages/shell/window-placement/tests/geometry.spec.ts packages/shell/window-placement/tests/service.spec.ts` — PASS: 2 files/22 tests.
- `pnpm exec vitest run packages/core/window-control/tests/placement-constraints.spec.ts packages/core/window-preview/tests/service.spec.ts packages/bundle/windows-runtime/tests/composition.spec.ts` — PASS: 3 files/20 tests.
- `cargo test --manifest-path native/Cargo.toml` — FAIL: native suites passed except `app_bar::tests::test_app_bar_poschanged_callback_handling` (70 passed, 1 failed, 1 ignored in `elix-native-core`).
- `pnpm run shell:recovery:check` — PASS: `taskbars=1 visible=1`.

## Visual capture index

The complete screenshot index, including successful and failed visual states, is [evidence/README.md](evidence/README.md). Detailed complex findings are in [ELIX_COMPLEX_BUGS.md](ELIX_COMPLEX_BUGS.md), environment/hardware limitations are in [ELIX_BLOCKED_TESTS.md](ELIX_BLOCKED_TESTS.md), and the mechanical/simple-fix list is in [ELIX_SIMPLE_FIXES.md](ELIX_SIMPLE_FIXES.md).
