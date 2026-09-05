# Codex model catalog validation

The bridge reads the real `codex debug models` command. A JSON object containing
an array `models` is required. Every entry must have a non-empty string `slug`,
which is the bridge's selectable model identifier. Invalid required structure
returns an explicit catalog error and no partial directory. Optional display,
reasoning and visibility fields retain their existing compatibility behavior.

An empty `models: []` is valid structure, not a parse/command failure. The
0.148.0 upstream `ModelsResponse` contains `Vec<ModelInfo>` and its serializer
maps that vector without a minimum length check. The CLI writes the raw catalog
as JSON. This is a wire-structure conclusion, not evidence that any particular
account is entitled to zero models. Existing bridge behavior also accepted a
well-formed empty list; this fix does not invent a new non-empty constraint.

Version-pinned upstream evidence (tag `rust-v0.148.0`, commit
`3ba0f711642a888aec92a611a3f3b2211157ff89`):
- `codex-rs/cli/src/main.rs`: `DebugSubcommand::Models`, `run_debug_models_command`.
- `codex-rs/protocol/src/openai_models.rs`: `ModelsResponse`,
  `serialize_model_infos_with_legacy_base`, `deserialize_model_infos_with_legacy_base`.
- https://github.com/openai/codex/tree/3ba0f711642a888aec92a611a3f3b2211157ff89

Tests call the exported reader with an injected CLI executor and exercise the
settings panel with its returned result. They do not extract implementation
source or run an authenticated CLI. Cache duration, model defaults, selection
visibility, and CLI launch configuration are unchanged. A malformed response
remains subject to the existing cache expiry and then can recover normally.

The historical single-5.6 symptom is not reproduced or attributed to this fix.
Its native verification still needs the original binary/version, identical
profile/environment, and a sanitized raw command response. No native-provider
compatibility claim follows from these module regressions.
