# @deepseek-ai/dsh-windows-runtime

Production Cordis profile layer for the ELIX Windows application/runtime authority stack.

The bundle mounts authorities in dependency order:

1. Windows Context
2. Surface Core
3. Window Registry
4. Window Preview
5. Window Control
6. App Registry
7. Process Observation
8. Application Runtime

Surface Core owns ELIX destination HWNDs. Window Registry owns stable source `WindowId` identity. Window Preview starts only after both exist and owns backend-neutral preview leases, native DWM composition relationships, resource budgeting, fallback state, and cleanup. Consumers never receive `HWND` or `HTHUMBNAIL` handles.

Process Observation owns raw Windows process facts and lifecycle diffing only. Application Runtime consumes those facts together with Window Registry state and projects AppId-level runtime state. The bundle does not introduce a second process manager, launcher, window registry, surface owner, or recovery supervisor.

The shipped `default` profile includes this bundle after `@deepseek-ai/dsh-base`. The `minimal` profile intentionally remains base-only. Existing installation-owned default profiles containing only the old base tuple are migrated to the new shipped tuple; customized profile bundle lists are left untouched.
