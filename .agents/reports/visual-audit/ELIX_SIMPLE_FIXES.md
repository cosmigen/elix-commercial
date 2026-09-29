# ELIX OS — Visual Audit Simple and Mechanical Fixes

Audit date: 2026-09-16. This list separates low-risk cleanup or build-hygiene work from behavioral defects. No production implementation fix was applied during the audit.

## VIS-SIMPLE-001 — retain the Phase 17B workspace-link lockfile refresh

'pnpm install --lockfile-only --ignore-scripts' refreshed the expected workspace links for the Phase 17B packages, and 'pnpm install --frozen-lockfile --ignore-scripts' then passed. The tracked change is limited to 28 lockfile lines in pnpm-lock.yaml; it is not a runtime behavior change.

Recommended action: keep the lockfile refresh with the Phase 17B branch, or regenerate it using the repository's normal dependency workflow before merging.

## VIS-SIMPLE-002 — align the default native-host artifact with current source

The default native bridge selected native/target/release/elix-native-host.exe, whose request enum predates queryPlacementConstraints. The current source and freshly built debug host support the variant. The audit runner was pointed explicitly at native/target/debug/elix-native-host.exe so the Phase 17B authority path could be exercised.

Recommended action: rebuild the release native host from the checked-out source, or make the audit/build launcher select an artifact whose protocol matches the current source. This is an artifact-plane mismatch; it does not explain the separate restore rejection reproduced with the debug host.

Evidence: [stale release-host failure](evidence/P17B_placement_failure_constraints.png), [debug-host left placement](evidence/P17B_placement_left_half.png).

## VIS-SIMPLE-003 — keep audit runners and evidence index together

The repeatable visual wrappers and the screenshot index are under .agents/reports/visual-audit. They cover the states that are difficult to retain from a transient PTY session, including the real native windows for Phases 15, 16D, and 17B.

Recommended action: keep these audit-only files out of product packages and use them as the starting point for a follow-up regression run after fixes.

## Scope note

The remaining findings are behavioral or lifecycle defects and are listed in [ELIX_COMPLEX_BUGS.md](ELIX_COMPLEX_BUGS.md). Environment and acceptance-surface limitations are listed in [ELIX_BLOCKED_TESTS.md](ELIX_BLOCKED_TESTS.md).
