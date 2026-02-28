# Contributing Guide

## Atomic change policy

We keep every PR and commit small, single-purpose, and easy to roll back.

- One PR = one objective.
- One commit should be independently understandable and reversible.
- Avoid mixing feature work with refactors/docs/chore changes.
- If a change grows, split it into multiple commits or multiple PRs.

## Commit checklist

Before committing:

- Scope is a single, clear objective.
- Staged files are minimal and relevant.
- Basic verification for touched code has been run.
- Commit message explains exactly what changed.
- Run `npm run check:atomic` (cross-platform; same logic used by pre-commit).
- Ensure hooks are enabled in your clone: `npm run setup-hooks`.

## Windows notes

- Use `npm run setup-hooks` after clone so Git uses `.githooks` on Windows too.
- If bot runtime cannot find codex, set absolute `CODEX_BIN` in `.env` (for example `C:\\Users\\<you>\\AppData\\Local\\Programs\\Codex\\codex.exe`).

## Pull request checklist

Before opening a PR:

- PR title describes one objective.
- PR description includes rollback plan.
- Unrelated files are excluded.
- Validation steps and result are included.

## Recommended workflow

1. Create a short-lived branch for one task.
2. Implement only that task.
3. Commit in small logical units.
4. Open a focused PR.
