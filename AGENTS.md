# AGENTS.md

Entrypoint for coding agents and maintainers (Claude Code, Codex, Cursor, and other AGENTS-aware tools).

## What this is

**agent-voice** is a macOS TypeScript CLI for local voice around coding agents: hold Shift to dictate at the caret (Whisper), hear an agent's finished reply read aloud (Supertonic), and optionally refine a dictated or copied prompt with an agent CLI.

## Source-of-truth map

| Doc | Role |
| --- | --- |
| [`PROJECT.md`](PROJECT.md) | Scope and direction |
| [`CONTEXT.md`](CONTEXT.md) | Runtime model: processes, files, permissions |
| [`LANGUAGE.md`](LANGUAGE.md) | The words used in code and docs |
| [`CODE-STYLE.md`](CODE-STYLE.md) | Rule cards; `pnpm style` and `pnpm style:guide .` enforce them |
| [`README.md`](README.md) | Commands, settings, files, project structure, and the hand checks that need a mic, a keyboard, and macOS permissions |
| `src/settings/configSchema.ts` | Every setting (the README table is checked against it) |
| `src/settings/environmentVariables.ts` | Every `AGENT_VOICE_*` variable (README and `.env.example` are checked against it) |

## Layout

The folder table is in [README → Project structure](README.md#project-structure). Each folder owns one capability; a file does one job and is named for it.

## Working contract

- **Verify gate**: `pnpm verify` = `biome ci .` + `tsc --noEmit` + `pnpm style` + `pnpm style:guide .` + `vitest run` + `pnpm build`. The husky pre-commit runs it; never bypass it.
- **Effect / Schema**: outside data (files, hook input, CLI output, environment) is decoded by an Effect Schema; no `typeof` readers. Only `src/cli/main.ts` (and tests) run Effects.
- **Native modules load lazily** (`koffi`, PvRecorder, whisper.node, onnxruntime-node): `agent-voice reply` must stay fast and must never fail.
- **Agent settings** are edited only through `src/agents/hookSettings.ts`: one owned Stop entry, found by its command, backed up first, every other byte kept.
- **Never touch a running agent-voice or another voice tool on the developer's Mac from tests**: tests set `AGENT_VOICE_HOME` and `HOME` to a folder from `makeTestFolder` (`src/scripts/testFolder.ts`, under the gitignored `.test-home/`) and put fake CLIs on `PATH`; smoke tests only read models from `~/.agent-voice/models`.
- **Names**: plain English, one word per idea, from `LANGUAGE.md`. No `??`, no ternaries, no nested calls, at most two positional parameters, no classes except tagged errors.
- **Branches**: product work lands from a topic branch; never commit to `main` directly.

## Validate changes

```bash
pnpm exec vitest run src/<capability>
pnpm typecheck
pnpm verify
```

## Local CI

Run `act workflow_dispatch -W .github/workflows/ci.yml` before opening a PR.
The root `.actrc` selects the local Docker runner and keeps the pnpm store outside the workspace.
This package requires macOS. Run `pnpm verify` on macOS; Linux Docker cannot validate its native behavior. Use `act workflow_dispatch -W .github/workflows/ci.yml -P macos-latest=-self-hosted` for the native workflow.
