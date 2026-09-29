# Phase 18B — Global Input & Shell Navigation

Date: 2026-09-16
Status: implementation in progress
Base: frozen Phase 18A (`c10735ac55612e76482cff6fd87d7e62826f4c1f`)

## Goal

Provide a UI-independent Windows global-shortcut authority and a UI-independent shell-navigation command layer. Phase 18B must not hardcode Overview, Control Center, Dock, Home, or any other presentation. Those surfaces consume the services defined here.

## Authority boundaries

```text
Windows keyboard input
        |
        v
Win32 RegisterHotKey provider
        |
        v
GlobalInputService
        |
        v
ShellNavigationService
        |
        +--> SpacesService (Phase 18A authority)
        +--> Window Registry (stable task candidates)
        +--> Window Control (commit activation)
        +--> semantic Overview state/events
        +--> future shell UI consumers
```

### Global Input owns

- System-wide explicit chord registration.
- Stable ELIX binding IDs.
- Modifier/key normalization.
- Native registration conflict reporting.
- `MOD_NOREPEAT` by default so one physical press does not create an autorepeat storm.
- Desired-registration restoration after the native host restarts.
- Global hotkey event delivery independent of foreground application.

### Global Input does not own

- Space policy.
- Overview presentation.
- Window selection policy.
- UI rendering.
- Raw keylogging or arbitrary text capture.

Phase 18B intentionally uses Microsoft's documented `RegisterHotKey` / `WM_HOTKEY` mechanism rather than a global `WH_KEYBOARD_LL` hook. ELIX therefore receives only explicitly registered chords and does not observe unrelated user typing.

References:
- https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-registerhotkey
- https://learn.microsoft.com/windows/win32/api/winuser/nf-winuser-unregisterhotkey

### Shell Navigation owns

- Semantic commands:
  - `space.next`
  - `space.previous`
  - `overview.toggle`
  - `task-switcher.next`
  - `task-switcher.previous`
  - `navigation.commit`
  - `navigation.cancel`
- Mapping configured global bindings to semantic commands.
- Space next/previous wrap policy using Phase 18A `SpacesService`.
- Deterministic navigation-session state (`idle`, `overview`, `task-switcher`).
- Current-Space APPLICATION candidate selection using stable Window Registry `WindowId`s.
- Stable task-session candidate lists, selection wraparound, and original foreground identity.
- Commit through `WindowControl.activate(selectedWindowId)`.
- Bounded commit retry while still refusing fake success unless foreground is actually confirmed.
- Cancel semantics that preserve or best-effort restore the original foreground application.
- Event publication for future UI consumers.

### Shell Navigation does not own

- Virtual desktop native calls; it delegates to `SpacesService`.
- Window identity/lifetime; it consumes Window Registry authority.
- Native foreground activation primitives; it delegates to Window Control.
- Overview/task-switcher rendering.
- Hardcoded keyboard handling inside individual product UI components.

## Task-switch session contract

Starting `task-switcher.next` or `task-switcher.previous` captures eligible APPLICATION windows on the current Space. The current foreground application is ordered first and remaining candidates use stable Registry evidence for deterministic navigation.

The service snapshot exposes:

- `taskCandidateIds`
- `selectedWindowId`
- `originalForegroundWindowId`
- `taskSwitchOffset`

Selection alone does **not** mutate Windows foreground focus. This is intentional: a future Alt-Tab/Overview surface can render selection without stealing focus. `navigation.commit` is the mutation boundary and must activate the selected real window through Window Control. `navigation.cancel` ends the session without committing the selected candidate.

## Overview contract

`overview.toggle` changes Shell Navigation between `idle` and `overview`. It does not contain hardcoded Overview presentation. A consumer can render the live `SpacesService` and `WindowRegistry` authorities in any design. The Phase 18B acceptance UI renders all Spaces and their real APPLICATION windows only to make this contract visible during testing.

## Default test bindings

Defaults deliberately avoid `Win` because Windows reserves many Windows-logo shortcuts.

| Command | Default chord |
| --- | --- |
| `space.next` | Ctrl+Alt+Shift+Right |
| `space.previous` | Ctrl+Alt+Shift+Left |
| `overview.toggle` | Ctrl+Alt+Shift+O |
| `task-switcher.next` | Ctrl+Alt+Shift+J |
| `task-switcher.previous` | Ctrl+Alt+Shift+K |
| `navigation.commit` | Ctrl+Alt+Shift+Enter |
| `navigation.cancel` | Ctrl+Alt+Shift+Escape |

The Space bindings originally used PageUp/PageDown. Real Windows acceptance showed the other registered chords firing while the user's compact keyboard did not emit the PageUp/PageDown bindings. ArrowLeft/ArrowRight are therefore the default acceptance bindings; they remain configurable and are not product-UI hardcoding.

Bare Enter and Escape remain local UI keys only. The global commit/cancel bindings require Ctrl+Alt+Shift and therefore do not steal ordinary Enter/Escape from applications.

## Visual acceptance harness

`pnpm demo:phase18b:ui` starts a local-only test UI on `127.0.0.1`. It is not product UI and is not part of ShellNavigation authority. The harness exposes:

- exact three-second next/previous Space previews that capture and return to the exact origin `SpaceId`;
- permanent next/previous Space commands;
- a visible live Overview of all enumerated Spaces and their APPLICATION windows;
- real task candidate names/WindowIds and selected-candidate state;
- Commit activation and Cancel testing;
- one-click quick task switching for visual acceptance;
- current foreground application evidence;
- the live registered binding list;
- the live GlobalInput and ShellNavigation event stream.

The strongest task-switch acceptance path is entirely global: J/K selects and Ctrl+Alt+Shift+Enter commits while another application owns foreground. The browser buttons remain useful visual controls but are not the only activation path.

## Failure policy

- A rejected native hotkey registration is explicit; no fake success.
- One binding conflict must not disable unrelated bindings.
- If the native host restarts, desired bindings are reconciled into the new host generation.
- Shell navigation remains callable through `execute()` even if global shortcuts are unavailable.
- Space commands require a runtime-qualified Phase 18A `switchSpace` capability.
- Task switching requires Window Registry and Window Control authorities; it must not duplicate raw HWND mutation logic.
- A stale selected `WindowId` fails explicitly rather than activating a recycled HWND.
- A foreground activation that Windows does not confirm fails explicitly after the bounded retry.
- No direct raw HWND or virtual-desktop COM logic is duplicated in Phase 18B.

## Acceptance contract

Phase 18B is not complete until a real Windows run proves:

1. Registered chords fire while ELIX is not foreground.
2. Next/previous Space changes the actual Windows desktop through Phase 18A.
3. Forward and reverse Space navigation wrap deterministically.
4. The three-second visual preview leaves the origin Space and returns to that exact origin.
5. Task next/previous selects different real current-Space APPLICATION WindowIds and wraps deterministically.
6. Global Commit foregrounds the selected real application window; Cancel does not commit the selected candidate.
7. Overview toggle visibly opens/closes the acceptance Overview while the core remains presentation-independent.
8. A deliberately conflicting/reserved chord reports rejection without corrupting other bindings.
9. Native-host restart restores desired bindings.
10. Unit tests, TypeScript build, Rust tests/build/format, Windows runtime composition regression, and lockfile/diff hygiene all pass.

Only then may Phase 18B be frozen and Phase 18 declared complete.
