param(
  [switch]$RepairLockfile
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Command
  )

  Write-Host "`n=== $Name ===" -ForegroundColor Cyan
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Push-Location $repoRoot

try {
  if ($RepairLockfile) {
    Invoke-Step 'Synchronize pnpm lockfile' {
      pnpm install --lockfile-only
    }
  }

  Invoke-Step 'Frozen lockfile install' {
    pnpm install --frozen-lockfile
  }

  Invoke-Step 'TypeScript typecheck' {
    pnpm run typecheck
  }

  Invoke-Step 'Lint' {
    pnpm run lint
  }

  Invoke-Step 'Application Runtime unit tests' {
    pnpm exec vitest run packages/services/application-runtime
  }

  Invoke-Step 'Full JavaScript test suite' {
    pnpm run test
  }

  Invoke-Step 'JavaScript build' {
    pnpm run build
  }

  Invoke-Step 'Rust workspace tests' {
    cargo test --manifest-path native\Cargo.toml --workspace
  }

  Invoke-Step 'Rust release build' {
    cargo build --manifest-path native\Cargo.toml --workspace --release
  }

  Invoke-Step 'Application Runtime live Windows acceptance' {
    pnpm run demo:application-runtime
  }

  Invoke-Step 'Git whitespace validation' {
    git diff --check
  }

  Write-Host "`n=== Working tree ===" -ForegroundColor Cyan
  git status --short
  if ($LASTEXITCODE -ne 0) {
    throw "git status failed with exit code $LASTEXITCODE"
  }

  Write-Host "`nPhase 15 closeout commands completed successfully." -ForegroundColor Green
  Write-Host "Review any working-tree changes above before declaring Phase 15 complete."
}
finally {
  Pop-Location
}

