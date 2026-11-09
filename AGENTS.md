# AGENTS.md

Steps for coding agents working in this repo. The product and runtime are in [README.md](README.md) and [CONTEXT.md](CONTEXT.md); the words are in [LANGUAGE.md](LANGUAGE.md).

## Commands

```bash
pnpm install
pnpm dev:cli status                # run the CLI from source; loads .env when it exists
pnpm dev                           # the same, rerun on every change
pnpm test:watch                    # Vitest in watch mode
pnpm exec vitest run src/<folder>  # one folder's tests
pnpm typecheck
pnpm check                         # lint, typecheck, test and build through Turborepo
```

The folder map is in [README → Project structure](README.md#project-structure).

## Settings

- Every setting is in `src/settings/config-schema.ts`. The README settings table is checked against it.
- Every `AGENT_VOICE_*` variable is in `src/settings/environment-variables.ts`. README and `.env.example` are checked against it.

## Recipes

- Imports across folders use `#src/...` (package.json `imports`), never `../`. Source runs (`pnpm dev`, `pnpm dev:cli`, `pnpm test:bench`) and Vitest pass the `source` condition, so `#src/*` points at `src/`. The built CLI in `dist/src/` uses the default condition.
- Agent settings change only through `src/agents/hook-settings.ts`: one owned Stop entry, found by its command, backed up first, every other byte kept.
- Native modules load lazily (`koffi`, PvRecorder, whisper.node, onnxruntime-node). `agent-voice reply` must stay fast and never fail, so new imports on that path stay lazy.
- Tests never touch the real `~/.agent-voice` or agent settings. Set `AGENT_VOICE_HOME` and `HOME` to a folder from `makeTestFolder` (`src/scripts/test-folder.ts`, under the gitignored `.test-home/`) and put fake CLIs on `PATH`. Smoke tests only read models from `~/.agent-voice/models`.
- The file lock tests need macOS `O_EXLOCK`. They skip on Linux (`isMacOS` in `src/scripts/test-folder.ts`), so `pnpm check` on the Mac is where they run.

## Version and install

- The version lives only in `package.json`. `src/cli/agent-voice-version.ts` reads it.
- The package is private and not published to npm. Installs and updates follow README → Install and Update.

## CI

- GitHub CI runs on Linux only on pushes to `main` (`.github/workflows/ci.yml`: `pnpm test`, `pnpm build`).
