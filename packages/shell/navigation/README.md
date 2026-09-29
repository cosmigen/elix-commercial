# @deepseek-ai/dsh-shell-navigation

Phase 18B semantic shell-navigation authority for ELIX.

This package contains navigation policy and state, not presentation. Overview, Control Center, Dock, Home, or any future shell surface may call the same service without duplicating shortcut, Space, or task-switch logic.

## Commands

- `space.next`
- `space.previous`
- `overview.toggle`
- `task-switcher.next`
- `task-switcher.previous`
- `navigation.commit`
- `navigation.cancel`

Space commands delegate exclusively to Phase 18A `SpacesService`.

Task-switch commands operate on real `WindowRegistry` `WindowId`s from the current Space. The foreground application is the session origin; next/previous advances a stable candidate selection, `navigation.commit` activates the selected application through `WindowControl`, and `navigation.cancel` abandons the selection and preserves/restores the original foreground application when possible. The shell UI only renders this state; it does not own task-switch policy.

`overview.toggle` is intentionally presentation-independent. It changes Shell Navigation into/out of `overview` mode. A shell surface can then render live `SpacesService` and `WindowRegistry` state however it wants. The Phase 18B acceptance UI includes a live Overview renderer only to prove that contract visually; it is not product UI.

## Default global bindings

- Ctrl+Alt+Shift+Right — next Space
- Ctrl+Alt+Shift+Left — previous Space
- Ctrl+Alt+Shift+O — Overview toggle
- Ctrl+Alt+Shift+J — task-switcher next selection
- Ctrl+Alt+Shift+K — task-switcher previous selection
- Ctrl+Alt+Shift+Enter — commit selected task/navigation
- Ctrl+Alt+Shift+Escape — cancel navigation

The Space defaults use arrow keys rather than PageUp/PageDown because compact laptop keyboards may expose PageUp/PageDown only through firmware/Fn layers and not emit the expected virtual keys consistently. Bindings remain configuration, not product-UI hardcoding.

Bare Enter and Escape are still **not** system-wide bindings. A focused shell surface may map local Enter/Escape through `executeLocalKey()`. The global commit/cancel variants require the full Ctrl+Alt+Shift modifier chord, so ordinary typing is unaffected.

## Task-switch state

During a task-switch session `getSnapshot()` exposes:

- `taskCandidateIds` — stable eligible application `WindowId`s on the current Space.
- `selectedWindowId` — candidate currently selected by next/previous.
- `originalForegroundWindowId` — application that owned foreground when the session started.
- `taskSwitchOffset` — deterministic navigation offset used for wraparound.

No foreground window is changed merely by selecting a candidate. Commit is the mutation boundary. Commit performs a bounded activation retry and still refuses to report success until Windows/native observation or Window Registry confirms that the selected `WindowId` became foreground.

## API example

```ts
const selection = await ctx.shellNavigation.execute('task-switcher.next')
console.log(selection.selectedWindowId)

await ctx.shellNavigation.execute('navigation.commit')
```

## Windows visual acceptance

Run:

```powershell
pnpm demo:phase18b:ui
```

The local-only UI exposes exact three-second Space previews, a live Overview of real Spaces/application windows, real task candidate selection, Commit activation, one-click quick task switching, registered global bindings, current foreground state, and live input/navigation logs. It is a disposable acceptance harness; Phase 18B itself remains UI-independent.

For the strongest task-switch foreground acceptance, select with Ctrl+Alt+Shift+J/K and commit with Ctrl+Alt+Shift+Enter while another application owns foreground. This exercises the system-wide input path rather than relying only on a click from the external browser-based test harness.
