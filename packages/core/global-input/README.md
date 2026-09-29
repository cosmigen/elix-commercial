# @deepseek-ai/dsh-global-input

Phase 18B UI-independent global input authority for ELIX on Windows.

The production provider uses the documented Win32 `RegisterHotKey` / `WM_HOTKEY` mechanism. It registers only explicit ELIX-owned chords; it does **not** install a general keyboard logger or observe unrelated typing.

## Responsibilities

- Normalize symbolic keys and modifiers into stable bindings.
- Register/unregister explicit system-wide hotkeys.
- Default to no-repeat delivery.
- Surface conflicts as typed errors instead of silently changing the chord.
- Publish only registered hotkey activations.
- Preserve desired bindings across native-host generations and reconcile them after recovery.

## Non-responsibilities

Global Input does not own Spaces, window selection, Overview, task switching, or rendering. Those policies belong to higher-level services such as `@deepseek-ai/dsh-shell-navigation`.

## Example

```ts
await ctx.globalInput.register({
  id: 'example.command',
  key: 'F8',
  modifiers: { control: true, alt: true },
})

const dispose = ctx.globalInput.subscribe(event => {
  console.log(event.bindingId)
})
```

Bare global keys are rejected. Windows-logo combinations are supported by the contract but are not used by ELIX defaults because Windows reserves many of them.
