# ELIX OS — Visual Audit Complex Bugs

Audit date: 2026-09-16. Findings below are based on the Phase 1–17B visual run, focused tests, live demos, native tests, and the screenshot evidence index. No production implementation logic was changed.

## VIS-001 — Shell Layout in-flight registration disposal hangs

Severity: high. Phase: 16A.

Expected: a registration that is disposed while native registration is still in flight should settle and leave no owned reservation or pending teardown.

Observed: packages/shell/layout/tests/lifecycle.spec.ts timed out in the test at line 291, and its afterEach teardown also timed out. The TypeScript build additionally reports a state comparison diagnostic at packages/shell/layout/src/service.ts:228.

Reproduction: run the focused layout/window-placement preflight or the full shell layout test package. The focused run completed 3 files/25 tests before the lifecycle timeout; the shell package sweep reported the same lifecycle failure.

Evidence: [guided Phase 16A pass](evidence/P16A_shell_layout_guided_pass.png) shows the successful steady-state path; the command output in the main audit report records the failing in-flight path.

## VIS-002 — Shell Layout work-area and Home exclusion publication is inconsistent

Severity: high. Phases: 6, 10, and 16A.

Expected: the native work area and Home exclusion zones should be available, updated exactly once for each reservation, and restored after removal/fullscreen transitions.

Observed: the shell layout package sweep failed native-authority, multi-monitor, Home-integration, and work-area assertions. Failures included an undefined work area, empty Home zones, and fullscreen expectations that did not match the observed state.

Likely ownership: the interaction between packages/shell/layout/src/service.ts and packages/shell/layout/src/home-publisher.ts; confirm the event/revision ordering before changing the publisher.

Reproduction: pnpm exec vitest run packages/shell/layout/tests/... as listed in the main report.

Evidence: [guided reservation PASS](evidence/P16A_shell_layout_guided_pass.png). The screenshot proves the guided native reservation path, while the package failures identify unhandled lifecycle/topology paths.

## VIS-003 — Live Overlay foreground identity and cleanup assertions fail

Severity: high. Phase: 9.

Expected: the foreground snapshot should identify the active overlay's native window, and closing an overlay should remove it from the active set.

Observed: packages/shell/overlay/tests/windows-live.spec.ts failed foreground native-id assertions at lines 140 and 294 and failed the active-overlay-zero assertion at line 244. The non-live overlay suite passed 8 files/87 tests, so the defect is specific to live/native coordination.

Evidence: [centered overlay](evidence/P09_overlay_centered.png), [close-all visual state](evidence/P09_overlay_close_all.png), and [Home folder close with stale overlay](evidence/P10_home_overlay_close.png).

## VIS-004 — Overlay demo has an asynchronous close/reposition race

Severity: high. Phase: 9.

Expected: rapid close, reposition, and close-all input should be serialized safely and should not dereference an already-closed overlay.

Observed: rapid input reproduced 'Cannot reposition overlay ... instance not in OPEN state' at packages/shell/overlay/src/service.ts:714. A rapid close-all/quit sequence separately reproduced 'TypeError: Cannot read properties of undefined (reading getActive)' at packages/shell/overlay/demo/visual-test.ts:686.

Reproduction: the audit used the documented PTY commands 5, 10, 11, 14, 15 in quick succession for the first failure and 15, q for the second. A paced close-all scenario passed, so timing is material.

Evidence: [overlay failure capture](evidence/P09_overlay_failure_crash.png), [shutdown-race capture](evidence/P09_overlay_shutdown_race.png), and [edge placement](evidence/P11_overlay_bottom_flip_fresh.png).

## VIS-005 — Home context menu survives folder close and restart

Severity: high. Phases: 2, 10, and 12.

Expected: opening an app folder should replace or deliberately compose with the context menu, and closing the folder or restarting Home should leave no stale context-menu surface.

Observed: the Utilities folder visually opened while the context menu remained over it; closing the folder left the context menu visible; the restart/persistence state also retained the menu. This was reproduced in the Home demo while folder, wallpaper, widget, persistence, and reorder actions were otherwise functional.

Evidence: [context menu](evidence/P10_home_context_menu.png), [folder with stale menu](evidence/P10_home_app_folder.png), [folder closed](evidence/P10_home_overlay_close.png), and [restart state](evidence/P02_home_restart_persisted.png).

## VIS-006 — Native AppBar POSCHANGED callback test fails

Severity: medium/high. Phase: 5.

Expected: the native AppBar callback path should accept the registered rectangle and preserve a valid non-negative height.

Observed: cargo test --manifest-path native/Cargo.toml failed elix-native-core test app_bar::tests::test_app_bar_poschanged_callback_handling at native/crates/elix-native-core/src/app_bar.rs:1030, on registered_after[0].rect.height >= 0. The native suites otherwise passed with 70 passed, 1 failed, and 1 ignored in that crate.

Evidence: [native-backed shell-layout reservation](evidence/P16A_shell_layout_guided_pass.png) is a separate successful path; the native test failure remains a release blocker for the full native suite.

## VIS-007 — Phase 17B restore rejects after repeated placement

Severity: high. Phase: 17B.

Expected: after applying valid placements, restoring the original geometry should succeed when the display topology and Shell Layout basis are unchanged.

Observed: with the freshly built debug native host, left-half and right-half placement both returned status=applied with 960×1140 rectangles. The subsequent restore returned status=rejected, reason display-topology-unstable, detail 'Display topology or Shell Layout work area changed while restore geometry was being applied.' The runner exited with PHASE 17B VISUAL RUNNER FAILED.

Relevant code: packages/shell/window-placement/src/service.ts checks shellLayoutRevision through isRestoreBasisCurrent; Shell Layout revisions may be changing during the repeated live placement sequence.

Evidence: [original baseline](evidence/P17B_placement_original.png), [left half](evidence/P17B_placement_left_half.png), [right half](evidence/P17B_placement_right_half.png), and [restore rejection](evidence/P17B_placement_restore_failure.png).

## VIS-008 — Release native artifact is older than the checked-out protocol

Severity: medium, artifact-plane. Phase: 17B.

Expected: the native executable selected by the default bridge should understand the current request variants.

Observed: the release executable rejected queryPlacementConstraints as an unknown variant and reported that only activate, minimize, maximize, restore, close, and setBounds were valid. The debug executable built from the current source accepted placement-constraint negotiation.

Relevant code: packages/native/core/src/client.ts:143-155 searches for the native host, while native/crates/elix-native-core/src/window_control.rs contains the current query variant.

This finding is distinct from VIS-007: after switching to the current debug host, placement applied but restore still failed.

## VIS-009 — WebView2 temporary-directory teardown returns EPERM

Severity: medium. Phases: 7, 16B, and 16C.

Expected: demos and audit runners should finish with clean temporary-profile teardown after the visual state has been captured.

Observed: the functional UI Foundation and personalization scenarios rendered and their assertions passed, but the shipped demos and audit wrappers returned EPERM while removing WebView2 temporary directories. The Home demo's clean shutdown reported zero orphan windows, but the process exit still left temporary directories that could not be removed immediately.

Relevant locations include packages/shell/ui-foundation/demo/visual-test.ts:203 and packages/shell/home/demo/personalization-test.ts:487.

Evidence: [high-contrast UI](evidence/P16B_ui_runner_high_contrast.png), [personalization effects](evidence/P16C_personalization_runner_effects.png), and [final clean desktop](evidence/P17B_final_clean_desktop.png). The visual states are valid; teardown is not clean.

## VIS-010 — TypeScript host build is not clean on the checked-out branch

Severity: high. Cross-cutting phases 6, 15, and 17B.

Expected: tsc -b tsconfig.host.json --pretty false should complete with no diagnostics.

Observed: the build reported the Shell Layout state comparison at packages/shell/layout/src/service.ts:228, an Application Runtime mock missing getPlacementConstraints at packages/services/application-runtime/tests/service.spec.ts:199, and unsafe casts in packages/shell/window-placement/tests/service.spec.ts:305 and :309.

This is a compile gate finding, not a claim that every affected runtime path is visually broken; it is recorded because it prevents a clean release validation.
