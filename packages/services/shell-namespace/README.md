# @deepseek-ai/dsh-shell-namespace

ELIX OS Shell Namespace / File Provider plugin.
Authoritative provider for Windows files, folders, shortcuts (`.lnk`), known folders, Desktop contents, stable file identity, and filesystem change observation.

Native change notifications are reconciliation hints, not authoritative item mutations. On overflow, watcher failure, or native-host downtime, the service re-enumerates the affected container and applies its catalog diff before native fine-grained delivery is rearmed. Reconciliation failure emits `provider-fault` and leaves the watcher degraded.
