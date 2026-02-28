#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper for environments still calling the shell entrypoint.
exec node scripts/check-atomic-commit.mjs "$@"
