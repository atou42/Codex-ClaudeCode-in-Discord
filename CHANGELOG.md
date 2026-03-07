# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project follows Semantic Versioning.

## [0.3.0] - 2026-03-07

### Added
- Shared and dedicated startup flows for Discord bot instances via `npm run start:shared`, `npm run start:codex`, and `npm run start:claude`.
- Provider-scoped single-file `.env` loading with `CODEX__*` and `CLAUDE__*` sections plus new utility coverage for provider/env resolution.
- Provider-aware state isolation for locked bot instances, including per-provider session/lock files and default slash prefixes.

### Changed
- Expanded the bot bridge from Codex-only wording to first-class Codex + Claude support across docs, config examples, and runtime helpers.
- Progress/event parsing now understands additional assistant and stream event shapes used by Claude-style runtimes.

### Fixed
- Prefer provider-scoped Discord token and runtime overrides without clobbering higher-priority shell environment values.
- Preserve progress milestones from tool-style response items that omit explicit completion status.

## [0.2.3] - 2026-03-04

### Changed
- `splitForDiscord` now performs markdown-aware chunking and keeps fenced code blocks balanced across message parts.
- Extracted Discord output chunking into `src/discord-message-splitter.js` for isolated testing and safer iteration.

### Fixed
- Avoid splitting inside fenced blocks without reopening/closing markers, preventing broken rendering in long final answers.
- Added regression tests for long plain text, fenced code block chunking, and unclosed-fence auto-healing.

## [0.2.2] - 2026-03-04

### Fixed
- Preserve Markdown line breaks, paragraphs, and fenced code blocks when extracting final answer text from Codex events.
- Add regression tests for Markdown structure preservation in `codex-event-utils`.

## [0.2.1] - 2026-03-03

### Added
- Audience-facing progress stream with a fixed process window and commentary capture from Codex events.
- Configurable process window lines command and event dedupe controls.

### Changed
- Progress rendering now uses raw Codex event text and incremental streaming behavior.
- Added semver release automation (`scripts/cut-release.mjs`) and npm release scripts.

### Fixed
- Acknowledge slash interactions earlier to reduce timeout errors.
- Retry transient Discord send/reply failures.
- Fallback to `channel.send` for system messages when direct replies fail.

## [0.2.0] - 2026-03-01

### Added
- Configurable onboarding wizard for language, security profile, and timeout.
- Per-thread slash commands for onboarding and runtime overrides.
- Text commands for onboarding, language, profile, and timeout management.
- Localized onboarding and help output in Chinese and English.

### Changed
- Persist and migrate session-level settings: language, onboarding, security profile, timeout.
- Progress reporting now follows session language for phases, labels, and hints.
- Documentation and `.env.example` updated for new onboarding controls.
