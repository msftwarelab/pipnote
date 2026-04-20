#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FULL_MODE=0

if [[ "${1:-}" == "--full" ]]; then
  FULL_MODE=1
fi

run_step() {
  local label="$1"
  shift
  printf '\n==> %s\n' "$label"
  "$@"
}

cd "$ROOT_DIR"

run_step "Editor + logic tests" pnpm -s test:editor
run_step "Web build" pnpm -s build
run_step "Native Rust check" cargo check --manifest-path src-tauri/Cargo.toml

if [[ "$FULL_MODE" -eq 1 ]]; then
  run_step "End-to-end smoke tests" pnpm -s test:e2e
fi

printf '\nRelease check complete%s.\n' "$( [[ "$FULL_MODE" -eq 1 ]] && printf ' (full mode)' )"
