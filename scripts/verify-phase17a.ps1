param(
  [switch]$Live
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
Push-Location $repo
try {
  Write-Host '== Phase 17A: TypeScript typecheck =='
  pnpm run typecheck

  Write-Host '== Phase 17A: lint =='
  pnpm run lint

  Write-Host '== Phase 17A: focused service/composition tests =='
  pnpm exec vitest run `
    packages/core/window-preview/tests/service.spec.ts `
    packages/bundle/windows-runtime/tests/composition.spec.ts `
    --no-file-parallelism

  Write-Host '== Phase 17A: Native Core preview tests =='
  cargo test --manifest-path native/Cargo.toml -p elix-native-core window_preview -- --test-threads=1

  Write-Host '== Phase 17A: Native Bridge preview RPC tests =='
  cargo test --manifest-path native/Cargo.toml -p elix-native-bridge preview -- --test-threads=1

  Write-Host '== Phase 17A: full TypeScript build =='
  pnpm run build

  Write-Host '== Phase 17A: release native workspace build =='
  cargo build --manifest-path native/Cargo.toml --workspace --release

  Write-Host '== Phase 17A: whitespace gate =='
  git diff --check

  if ($Live) {
    Write-Host '== Phase 17A: real Windows DWM visual acceptance =='
    pnpm run demo:window-preview
  }

  Write-Host ''
  Write-Host 'PHASE 17A STATIC/NATIVE VERIFICATION PASSED'
  if (-not $Live) {
    Write-Host 'Run with -Live on an interactive Windows desktop to execute the visual DWM acceptance.'
  }
}
finally {
  Pop-Location
}
