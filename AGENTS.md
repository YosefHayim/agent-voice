# AGENTS.md

Entrypoint for coding agents and maintainers (Claude Code, Codex, Cursor, and other AGENTS-aware tools).

## What this is

**voxkey** is a macOS TypeScript CLI for local voice around coding agents: hold Shift to dictate at the caret (Whisper), hear an agent's finished reply read aloud (Supertonic), and optionally refine a dictated or copied prompt with an agent CLI.

## Source-of-truth map

| Doc | Role |
| --- | --- |
| [`PROJECT.md`](PROJECT.md) | Scope and direction |
| [`CONTEXT.md`](CONTEXT.md) | Runtime model: processes, files, permissions |
| [`LANGUAGE.md`](LANGUAGE.md) | The words used in code and docs |
| [`CODE-STYLE.md`](CODE-STYLE.md) | Rule cards; `pnpm style` and `pnpm style:guide .` enforce them |
| [`TESTING.md`](TESTING.md) | Hand checks that need a mic, a keyboard, and macOS permissions |
| `src/config/configSchema.ts` | Every setting (README table is checked against it) |
| `src/config/environmentVariables.ts` | Every `VOXKEY_*` variable |

## Layout

| Path | Owns |
| --- | --- |
| `src/cli/` | One file per command (`<name>Command.ts`), `main.ts` (the only Effect runtime edge), `TerminalUI.ts` (all terminal output) |
| `src/config/` | Settings Schema, config file, environment variables |
| `src/state/` | `~/.voxkey` paths and atomic state files |
| `src/dictation/` | Hold-Shift decisions, keyboard (koffi), caret typing, microphone, Whisper, live caption, queue, dictation worker |
| `src/speech/` | Markdown to speech, Supertonic, playback, inbox, Cmux focus, speech worker |
| `src/refine/` | Agent CLI discovery and calls, reply checks, rotation, picker, cmux delivery |
| `src/agentHooks/` | Agent catalog, byte-preserving Stop-hook edits, `voxkey reply` |
| `src/models/` | Whisper and Supertonic model files and downloads |
| `src/worker/` | Worker processes, `status.json`, logs, the pill (JXA) |
| `src/devin/` | Devin ATIF export watcher |
| `src/doctor/` | `voxkey doctor` checks |
| `src/scripts/` | Tooling only: code-style and rule-card checkers, `pnpm bench` |

## Working contract

- **Verify gate**: `pnpm verify` = `biome ci .` + `tsc --noEmit` + `pnpm style` + `pnpm style:guide .` + `vitest run` + `pnpm build`. The husky pre-commit runs it; never bypass it.
- **Effect / Schema**: outside data (files, hook input, CLI output, environment) is decoded by an Effect Schema; no `typeof` readers. Only `src/cli/main.ts` (and tests) run Effects.
- **Native modules load lazily** (`koffi`, PvRecorder, whisper.node, onnxruntime-node): `voxkey reply` must stay fast and must never fail.
- **Agent settings** are edited only through `src/agentHooks/hookSettings.ts`: one owned Stop entry, found by its command, backed up first, every other byte kept.
- **Never touch a running voxkey or another voice tool on the developer's Mac from tests**: tests use `VOXKEY_HOME` and `HOME` under `.scratch/` (gitignored) and fake CLIs on `PATH`; smoke tests only read models.
- **Names**: plain English, one word per idea, from `LANGUAGE.md`. No `??`, at most two positional parameters, no classes except tagged errors.
- **Branches**: product work lands from a topic branch; never commit to `main` directly.

## Validate changes

```bash
pnpm exec vitest run src/<capability>
pnpm typecheck
pnpm verify
```
