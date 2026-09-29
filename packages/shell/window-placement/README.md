# ELIX Window Placement — Phase 17B

`@deepseek-ai/dsh-window-placement` is the manual placement policy authority introduced by Phase 17B.
It consumes stable `WindowId` identity from Window Registry, negotiated work areas from Shell Layout,
monitor topology/DPI generation from Windows Context, and delegates every actual window mutation to
Window Control.

## Core policy

Supported manual targets are left/right/top/bottom halves, four quarters, center, fill usable work
area, move-to-monitor, and explicit restore of the pre-placement geometry. This is not an automatic
tiler and does not replace Windows Snap Assist or enroll windows into Windows Snap groups.

Geometry is expressed only in virtual-screen physical pixels. The target rectangle is calculated from
Shell Layout's negotiated work area for the selected monitor. The service records the Windows Context
revision used to negotiate the move and replans a bounded number of times if display topology changes
mid-operation.

## Reversible placement

The first successful ELIX placement for a current `WindowId` captures its original normal/restored
geometry and prior normal/maximized state. Repeated ELIX placements preserve that original restore
target. The record is memory-only and never stores a raw HWND.

A user/app-originated bounds, state, or monitor change invalidates the record rather than ELIX fighting
the application. Call `establishFreePlacement(windowId)` when a UI explicitly accepts the current
free-floating geometry as the new baseline.

If the original monitor disappears, restore selects a connected monitor and clamps the window into the
current Shell Layout work area while keeping an accessible title-bar/grab region. ELIX never blindly
restores an off-screen rectangle.

## Sizing constraints

Window Control exposes a guarded non-mutating placement-constraint query. It currently proves native
structural resizability (`WS_THICKFRAME`) and DWM extended-frame geometry without synchronously sending
messages into another application's UI thread. Application-specific min/max information is capability-
honest: absent values are not invented. If an application adjusts or refuses `SetWindowPos`, Phase 17B
observes the real post-command geometry and returns `adjusted` or `rejected`.

## Named layouts

`applyNamedLayout()` is explicit and per-window. Every target is resolved independently and each result
is returned independently; one stale/refusing window does not hide the outcome of other entries.
Duplicate `WindowId` entries are rejected deterministically.

## Out of scope

- automatic tiling / retile-on-window-event
- drag-edge overlays and Snap replacement
- Windows Snap groups / Snap Assist reproduction
- UI chooser or keyboard/menu commands (Phase 23G consumes this authority)
- persistence of HWND or placement records across application lifetimes

## Required integration acceptance

The Phase 17 integration pass must cover 100/125/150/200% DPI, negative virtual coordinates, portrait
monitors, constrained/minimum-size and nonresizable applications, maximized starting state, monitor
unplug/topology revision during placement, stale `WindowId`, cancellation/rollback, applications that
refuse/adjust geometry, named-layout partial failure, and repeated place/restore cycles.
