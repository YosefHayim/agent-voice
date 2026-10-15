# voxkey

Hold Shift to dictate into any text field, and hear your coding agent's replies read aloud — all on your Mac, in TypeScript.

- **Dictation.** Hold Shift on its own for 300 ms, speak, release. Whisper (whisper.cpp large-v3-turbo with Metal) transcribes on your Mac and voxkey types the text at the caret. Any other key pressed while Shift is down cancels, so capital letters and Shift shortcuts never start dictation. A small pill at the bottom of the screen shows "Recording", a live caption, then "Working".
- **Speech.** When Claude Code, Codex, or Grok finishes a turn, its Stop hook (`voxkey reply`) queues the reply and voxkey reads it aloud with a Supertonic voice. Markdown becomes speech: headings and lists as sentences, tables row by row with their column names, code blocks announced and read symbol by symbol.
- **Refine.** Optionally rewrite what you dictated (or what you copied) into a clean prompt with an agent CLI you already have — codex, claude, gemini, grok, ollama, opencode, or pi — before it is typed.

Everything except refine runs locally. voxkey is macOS only.

## Install

voxkey is not published to npm. Build it from this repository:

```bash
git clone https://github.com/YosefHayim/voxkey.git
cd voxkey
pnpm install
pnpm build
pnpm link --global      # puts `voxkey` on your PATH (or: alias voxkey="node $PWD/dist/src/cli/main.js")
voxkey on
```

`voxkey on` registers the Stop hook for each installed agent, downloads the models it is missing (Whisper turbo q5, about 574 MB; the Supertonic voices, about 400 MB), and starts the workers. macOS asks for **Microphone** access the first time; also allow your terminal in **Accessibility** (to type) and, if Shift is not detected, **Input Monitoring**. `voxkey doctor` checks all of it.

### What voxkey needs

| Need | Comes from | Install | Checked by `voxkey doctor` |
| --- | --- | --- | --- |
| macOS on Apple Silicon (tested on an M5 Max; Intel Macs untested) | — | — | yes |
| Node.js 22+ | Homebrew | `brew install node` | yes |
| pnpm 11 | Corepack | `corepack enable` | — |
| `osascript`, `afplay`, `pbcopy`, `pbpaste` | macOS | built in | yes |
| An agent CLI for refine (optional) | its vendor | e.g. `npm i -g @openai/codex`, `brew install ollama` | yes, when refine is on |
| `cmux` (optional, for `refine-send-to cmux-*`) | cmux.app | from cmux | yes, when used |
| `devin` (optional, for `voxkey devin`) | Devin CLI | from Devin | — |

No Homebrew audio tools are needed: the microphone, Whisper, the voices, and the keyboard all run through npm packages that ship prebuilt macOS arm64 binaries.

| npm package | Used for | Why this one |
| --- | --- | --- |
| [`koffi`](https://koffi.dev/) 3.3.2 | Read Shift and other keys from HID state (`CGEventSourceKeyState`) and post key events (`CGEventKeyboardSetUnicodeString`) | A maintained FFI with prebuilt binaries: calls the same CoreGraphics functions the old worker called, with no Input Monitoring event tap and no compiler. |
| [`@picovoice/pvrecorder-node`](https://github.com/Picovoice/pvrecorder) 1.2.9 | Microphone, 16 kHz mono frames | Apache-2.0, maintained, prebuilt for macOS arm64, and already in Whisper's format. |
| [`@fugood/whisper.node`](https://github.com/whisper-node/whisper.node) 1.1.3 | whisper.cpp with Metal, in process | Prebuilt darwin-arm64 binary with Metal; the model loads once (turbo q5: ~230 ms load, ~220 ms warm decode on an M5 Max). |
| [`onnxruntime-node`](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) 1.30.0 | Supertonic 3 text-to-speech | Supertonic ships ONNX models; they run unchanged in ONNX Runtime's Node binding (3.3 s of speech in ~0.6 s on CPU). |
| [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) 3.3.1 | Editing agent settings files | Node offsets let voxkey insert and remove exactly its own bytes. |
| [`effect`](https://effect.website/) 3.22.0, `@effect/cli`, `@effect/platform(-node)` | CLI, Schemas, workers | Schemas decode every file, hook input, and setting. |

## Commands

| Command | What it does |
| --- | --- |
| `voxkey on [--hooks-only]` | Register `voxkey reply` as the Stop hook of each installed agent, download missing models, and (re)start the workers. |
| `voxkey off` | Stop every voxkey process and remove only voxkey's hook entries. Config and models stay. |
| `voxkey status [--json]` | Workers, dictation stage, model, speech, refine, and hooks. |
| `voxkey doctor [--json]` | Check macOS, Node, native modules, system tools, models, permissions, hooks, and refine CLIs. |
| `voxkey config list \| get \| set \| unset` | Show or change a setting; `set` applies at once (a new dictation language restarts dictation, speech starts or stops). |
| `voxkey config pick-refine [--gui]` | Pick the refine provider, model, and effort from the agent CLIs on this Mac. |
| `voxkey speak <markdown> [--output file.wav]` | Read one reply aloud, or write it to a WAV file. |
| `voxkey render <markdown>` | Print the sentences voxkey would read. |
| `voxkey refine <prompt> [--speak --provider --model --effort --send-to --cmux-command --press-enter]` | Refine one prompt and print it; `--list-providers` prints the CLIs found as JSON. |
| `voxkey devin -- <devin arguments>` | Run Devin with its ATIF export and read each finished turn aloud. |
| `voxkey hotkey-check [--seconds 8]` | Print Shift presses, to check that voxkey can see the keyboard. |
| `voxkey reset` | Kill every voxkey worker and pill and clear the locks. |
| `voxkey reply --agent <id>` | The agent Stop hook (registered by `voxkey on`). Prints nothing, always exits 0. |
| `voxkey worker dictation \| speech` | Internal: the background workers. |

## Dictation

Hold Shift alone for 300 ms, speak, release. The mic stays open for `dictation-keep-listening-seconds` after release so the last word is not clipped. Clips are decoded one after another, so you can start the next hold while the previous one is still decoding. Say punctuation and structure:

```text
hello comma my name is Joseph period
bullet fix authentication next bullet add tests
numbered list fix login next item deploy
use literal comma as the field name period
```

Fix words Whisper keeps getting wrong (the terms also steer Whisper's spelling):

```bash
voxkey config set dictation-replacements "Joseph=Yosef;type script=TypeScript"
```

Hebrew uses the [ivrit.ai](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml) turbo model: `voxkey config set dictation-language he`.

## Speech

Speech starts muted: replies are dropped, not read, until you unmute. Double-tap Shift to unmute or mute again (or, in clipboard refine mode, where double-tap refines the copied prompt, run `voxkey config set speech-muted false`). Tap Shift to stop the current reply. Starting a hold also stops speech.

Inside Cmux each reply is bound to its workspace and surface. In `auto` mode a reply waits until that surface is focused and Cmux is in front; newer replies from the same surface replace older ones; if Cmux does not answer, the reply is spoken at once. `immediate` speaks every reply at once; `off` reads nothing.

```bash
voxkey config set speech-muted false
voxkey config set speech-mode off
voxkey config set speech-voice M2
voxkey speak "Release status: **ready**."
```

## Refine

| `refine-mode` | Behavior |
| --- | --- |
| `off` | Type what you said (default). |
| `dictation` | Refine the final dictation (5 words or more) before it is typed; after 20 s the dictated text is typed instead. |
| `clipboard` | Double-tap Shift refines the copied prompt and copies the result back; press ⌘V. |
| `both` | Both of the above. |

voxkey tries the configured provider and model, rotates through that provider's models, then the other providers installed (codex, opencode, gemini, grok, pi, ollama, claude). A reply is rejected when it is empty, a CLI help dump, an auth or quota error, an error envelope, or when it drops any code, path, URL, or quoted text from your draft. When every attempt fails, a macOS dialog lets you pick a model or skip refine (`VOXKEY_REFINE_PICKER=off` disables it). `refine-send-to cmux-new` or `cmux-resume` sends the refined prompt into cmux instead of the caret.

## Settings

Every setting lives in one file, `~/.voxkey/config.json`. You do not need to open it: `voxkey config` shows, checks, and changes each value, and a change applies at once. On the command line a name is the kebab-case form of its JSON key (`speech-mode` is `speechMode`).

```bash
voxkey config list                  # every setting and its current value
voxkey config set speech-voice M2
voxkey config unset speech-voice    # back to the default
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `speech-mode` | `"auto"` | When agent replies are read aloud: auto holds a Cmux reply until its surface is focused and Cmux is in front, and speaks other replies at once; immediate speaks every reply at once; off reads nothing. |
| `speech-muted` | `true` | Read nothing while true; replies that arrive meanwhile are dropped, not saved for later. Double-tap Shift flips it (outside clipboard refine mode). |
| `speech-voice` | `"F4"` | Supertonic voice: F1-F5 or M1-M5. |
| `speech-words-per-minute` | `230` | Speed of read-aloud replies, in words per minute (the voice speed is clamped to 0.7-2.0x). |
| `dictation-language` | `"en"` | Dictation language: en (whisper.cpp large-v3-turbo) or he (ivrit.ai Hebrew large-v3-turbo). Accepts english, hebrew, ivrit, iw. |
| `dictation-keep-listening-seconds` | `0.2` | Seconds the microphone stays open after Shift is released, so trailing words are not cut off. |
| `dictation-replacements` | `""` | Semicolon-separated heard=written pairs applied to dictation, e.g. Joseph=Yosef;type script=TypeScript. |
| `refine-mode` | `"off"` | Prompt refine: off; clipboard = double-tap Shift refines the copied prompt; dictation = refine the dictation before it is typed; both. |
| `refine-provider` | `"codex"` | Agent CLI that refines: codex \| auto \| grok \| ollama \| opencode \| claude \| gemini \| pi. `voxkey config pick-refine` lists only the CLIs found on this Mac. |
| `refine-model` | unset | Model ID for the refine provider (e.g. gpt-5.3-codex-spark, grok-4.5, llama3.2). Unset: gpt-5.3-codex-spark for codex, the provider's own models otherwise. |
| `refine-effort` | unset | Reasoning effort for providers that support it. Unset: low, so dictation refine stays fast. |
| `refine-press-enter` | `false` | Press Enter after dictated text (refined or not) is typed at the caret. |
| `refine-send-to` | `"caret"` | Where refined dictation goes: caret (the focused input), cmux-new (a new focused cmux workspace), or cmux-resume (the focused cmux surface). |
| `refine-cmux-command` | `""` | Shell command run in the new cmux workspace for cmux-new. Placeholders, each replaced by one shell-quoted word: {{prompt_file}}, {{prompt}}, {{cwd}}. Empty pastes the text only. |
| `refine-cmux-press-enter` | `false` | Press Enter after sending refined text into cmux (cmux-resume, or cmux-new without a command). |

## Environment variables

These change where voxkey keeps its files and switch a few features off. For the installed `voxkey`, export them in your shell profile. When you run from source, copy [`.env.example`](.env.example) to `.env` and fill in a value: `pnpm cli` loads `.env`, and an empty value keeps the default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VOXKEY_HOME` | `~/.voxkey` | Folder for config, state, models, and logs. |
| `VOXKEY_CONFIG_FILE` | `$VOXKEY_HOME/config.json` | The only config file read when set. |
| `VOXKEY_DICTATION_MODEL` | unset | Force the Whisper model: `turbo-q5`, `turbo-q8`, `turbo`, `small`, `base`, `tiny`, or `ivrit`. |
| `VOXKEY_DICTATION_LIVE_PREVIEW` | on | `off` (or `0`, `false`, `no`) stops the live caption while Shift is held. |
| `VOXKEY_REFINE_PICKER` | on | `off` (or `0`, `false`, `no`) never opens the macOS model picker; it is also off when `CI` is set. |

## Files

Everything voxkey writes lives in `~/.voxkey` (or `$VOXKEY_HOME`):

| Path | Holds |
| --- | --- |
| `config.json` | Settings. |
| `models/` | Whisper `ggml-*.bin` files and `supertonic-3/`. |
| `inbox/`, `failed/`, `seen.json` | Queued replies, replies that failed to play, and the replies already spoken (24 h). |
| `status.json` | The dictation stage the pill shows. |
| `dictation.log`, `dictation-worker.log`, `speech-worker.log` | Timings and worker output. |
| `backups/` | A copy of each agent settings file before voxkey edited it. |
| `refine-choice.json`, `refine-codex-*.txt` | The last refine pick and Codex's working and failing models. |
| `prompts/`, `audio/`, `devin/` | Refined prompts handed to cmux, speech audio being played, and Devin session exports. |
| `*.pid`, `*.lock`, `stop` | Worker bookkeeping. |

What you dictate and what agents reply stays yours: every file voxkey keeps in `~/.voxkey` that holds it, and every settings backup, is created readable by you alone (mode 0600), in folders only you can open (0700, `~/.voxkey` included). voxkey tightens such a file or folder whenever it finds one looser. A file you ask for elsewhere, like `voxkey speak --output <file>`, keeps your usual permissions, and so does the folder of a `VOXKEY_CONFIG_FILE` you point outside `~/.voxkey`.

Agent hooks: `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.grok/hooks/voxkey.json` each get one Stop entry whose command ends in `reply --agent <id>`; `voxkey off` removes exactly that entry.

## Project structure

| Folder | Holds |
| --- | --- |
| `src/cli/` | One file per command (`<name>Command.ts`), `main.ts` (the only place an Effect runs), and `TerminalUI.ts` (all terminal output) |
| `src/settings/` | The settings Schema, the config file, the `VOXKEY_*` variables, and the `~/.voxkey` paths |
| `src/files/` | Atomic state files, file locks, and model downloads |
| `src/dictation/` | Hold Shift: keyboard, microphone, clip audio, Whisper, transcript text, live caption, typing at the caret, and the dictation worker |
| `src/speech/` | Replies read aloud: inbox, Markdown to speech, Supertonic, playback, Cmux focus, and the speech worker |
| `src/refine/` | Agent CLI discovery and calls, reply checks, model rotation, the picker, and cmux delivery |
| `src/agents/` | The agent catalog, Stop hook edits, `voxkey reply`, and the Devin watcher |
| `src/workers/` | Worker processes, `status.json`, worker logs, and the pill |
| `src/scripts/` | Tooling only: the code-style and rule-card checkers, `pnpm bench`, `pnpm cli` (the CLI from source), and the test folder helper |

## Development

```bash
pnpm install
pnpm verify          # Biome, typecheck, code-style rules, rule cards, tests, build
pnpm cli status      # run the CLI from source; loads .env when it exists
pnpm bench --models base,turbo-q5 --seconds 1,2,4 --runs 3
```

Tests never touch your real `~/.voxkey` or agent settings. Each test makes its own home folder under `.test-home/` (gitignored, safe to delete) with `makeTestFolder` from `src/scripts/testFolder.ts`. The Whisper and Supertonic smoke tests read the models already in `~/.voxkey/models` and skip when they are missing.

Hand checks need a mic, a keyboard, and macOS permissions. After `voxkey on`:

1. `voxkey doctor` passes Microphone and Accessibility.
2. `voxkey hotkey-check --seconds 8` prints each Shift press.
3. In a text field, hold Shift and say "hello comma world period": `Hello, world.` is typed.
4. Shift+A types `A`, and Shift held with another key types nothing.
5. `voxkey speak "Release status: **ready**."` reads one sentence, and a tap on Shift stops it.
6. `voxkey off` leaves each agent settings file as its copy in `~/.voxkey/backups/`, minus the voxkey Stop entry.

Agents start at [AGENTS.md](AGENTS.md).

## License

MIT
