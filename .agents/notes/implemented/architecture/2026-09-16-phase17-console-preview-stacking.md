# Phase 17 acceptance console preview stacking

The combined Phase 17 acceptance console overlaps one interactive dashboard Surface with two transparent DWM preview destination Surfaces. A live DWM thumbnail can remain visually hidden when the dashboard and destination HWNDs all use independent topmost z-order because Windows does not give the tool a stable sibling ordering guarantee among those separate windows.

The developer launcher now applies acceptance-console-only presentation policy at launch: the dashboard uses normal z-order, both preview destinations are re-raised as topmost after they are shown and again before a preview lease is acquired, and the dashboard uses a smaller rectangle centered inside the primary work area. Production Surface Core and Window Preview semantics are unchanged.

The launcher also augments preview acquisition diagnostics with the lease `reason` field so real application incompatibilities can be distinguished from visual stacking defects. The transformation is guarded by exact single-match assertions and executes from a temporary same-directory TypeScript module that is removed immediately after loading.
