# agent-voice

Hold Shift to dictate into any text field, and hear your coding agent's replies read aloud — all on your Mac, in TypeScript.

- **Dictation.** Hold Shift on its own for 300 ms, speak, release. Whisper (whisper.cpp large-v3-turbo with Metal) transcribes on your Mac and agent-voice types the text at the caret. Any other key pressed while Shift is down cancels, so capital letters and Shift shortcuts never start dictation. A small pill at the bottom of the screen shows "Recording", a live caption, then "Working".
- **Speech.** When Claude Code, Codex, or Grok finishes a turn, its Stop hook (`agent-voice reply`) queues the reply and agent-voice reads it aloud with a Supertonic voice. Markdown becomes speech: headings and lists as sentences, tables row by row with their column names, code blocks announced and read symbol by symbol.
- **Refine.** Optionally rewrite what you dictated (or what you copied) into a clean prompt with an agent CLI you already have — codex, claude, gemini, grok, ollama, opencode, or pi — before it is typed.

Everything except refine runs locally. agent-voice is macOS only.

## Install

agent-voice is not published to npm. Build it from this repository:

```bash
git clone https://github.com/YosefHayim/agent-voice.git
cd agent-voice
pnpm install
pnpm build
pnpm link --global      # puts `agent-voice` on your PATH (or: alias agent-voice="node $PWD/dist/src/cli/main.js")
agent-voice on
```

`agent-voice on` registers the Stop hook for each installed agent, downloads the models it is missing (Whisper turbo q5, about 574 MB; the Supertonic voices, about 400 MB), and starts the workers. macOS asks for **Microphone** access the first time; also allow your terminal in **Accessibility** (to type) and, if Shift is not detected, **Input Monitoring**. `agent-voice doctor` checks all of it.

### What agent-voice needs

| Need | Comes from | Install | Checked by `agent-voice doctor` |
| --- | --- | --- | --- |
| macOS on Apple Silicon (tested on an M5 Max; Intel Macs untested) | — | — | yes |
| Node.js 22+ | Homebrew | `brew install node` | yes |
| pnpm 11 | Corepack | `corepack enable` | — |
| `osascript`, `afplay`, `pbcopy`, `pbpaste` | macOS | built in | yes |
| An agent CLI for refine (optional) | its vendor | e.g. `npm i -g @openai/codex`, `brew install ollama` | yes, when refine is on |
| `cmux` (optional, for `refine-send-to cmux-*`) | cmux.app | from cmux | yes, when used |
| `devin` (optional, for `agent-voice devin`) | Devin CLI | from Devin | — |

No Homebrew audio tools are needed: the microphone, Whisper, the voices, and the keyboard all run through npm packages that ship prebuilt macOS arm64 binaries.

| npm package | Used for | Why this one |
| --- | --- | --- |
| [`koffi`](https://koffi.dev/) 3.3.2 | Read Shift and other keys from HID state (`CGEventSourceKeyState`) and post key events (`CGEventKeyboardSetUnicodeString`) | A maintained FFI with prebuilt binaries: calls the same CoreGraphics functions the old worker called, with no Input Monitoring event tap and no compiler. |
| [`@picovoice/pvrecorder-node`](https://github.com/Picovoice/pvrecorder) 1.2.9 | Microphone, 16 kHz mono frames | Apache-2.0, maintained, prebuilt for macOS arm64, and already in Whisper's format. |
| [`@fugood/whisper.node`](https://github.com/whisper-node/whisper.node) 1.1.3 | whisper.cpp with Metal, in process | Prebuilt darwin-arm64 binary with Metal; the model loads once (turbo q5: ~230 ms load, ~220 ms warm decode on an M5 Max). |
| [`onnxruntime-node`](https://onnxruntime.ai/docs/get-started/with-javascript/node.html) 1.30.0 | Supertonic 3 text-to-speech | Supertonic ships ONNX models; they run unchanged in ONNX Runtime's Node binding (3.3 s of speech in ~0.6 s on CPU). |
| [`jsonc-parser`](https://github.com/microsoft/node-jsonc-parser) 3.3.1 | Editing agent settings files | Node offsets let agent-voice insert and remove exactly its own bytes. |
| [`effect`](https://effect.website/) 3.22.0, `@effect/cli`, `@effect/platform(-node)` | CLI, Schemas, workers | Schemas decode every file, hook input, and setting. |

## Commands

| Command | What it does |
| --- | --- |
| `agent-voice on [--hooks-only]` | Register `agent-voice reply` as the Stop hook of each installed agent, download missing models, and (re)start the workers. |
| `agent-voice off` | Stop every agent-voice process and remove only agent-voice's hook entries. Config and models stay. |
| `agent-voice status [--json]` | Workers, dictation stage, model, speech, refine, and hooks. |
| `agent-voice doctor [--json]` | Check macOS, Node, native modules, system tools, models, permissions, hooks, and refine CLIs. |
| `agent-voice config list \| get \| set \| unset` | Show or change a setting; `set` applies at once (a new dictation language restarts dictation, speech starts or stops). |
| `agent-voice config pick-refine [--gui]` | Pick the refine provider, model, and effort from the agent CLIs on this Mac. |
| `agent-voice speak <markdown> [--output file.wav]` | Read one reply aloud, or write it to a WAV file. |
| `agent-voice render <markdown>` | Print the sentences agent-voice would read. |
| `agent-voice refine <prompt> [--speak --provider --model --effort --send-to --cmux-command --press-enter]` | Refine one prompt and print it; `--list-providers` prints the CLIs found as JSON. |
| `agent-voice devin -- <devin arguments>` | Run Devin with its ATIF export and read each finished turn aloud. |
| `agent-voice hotkey-check [--seconds 8]` | Print Shift presses, to check that agent-voice can see the keyboard. |
| `agent-voice reset` | Kill every agent-voice worker and pill and clear the locks. |
| `agent-voice reply --agent <id>` | The agent Stop hook (registered by `agent-voice on`). Prints nothing, always exits 0. |
| `agent-voice worker dictation \| speech` | Internal: the background workers. |

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
agent-voice config set dictation-replacements "Joseph=Yosef;type script=TypeScript"
```

Hebrew uses the [ivrit.ai](https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml) turbo model: `agent-voice config set dictation-language he`.

Pick any other model with `agent-voice config set dictation-model small` (it downloads the model if missing and restarts dictation); `agent-voice status --json` lists every model under `dictation.models` (key, label, megabytes, path, present, selected) for a picker, and `dictation.modelKey` is the selected one.

## Speech

Speech starts muted: replies are dropped, not read, until you unmute. Double-tap Shift to unmute or mute again (or, in clipboard refine mode, where double-tap refines the copied prompt, run `agent-voice config set speech-muted false`). Tap Shift to stop the current reply. Starting a hold also stops speech.

Inside Cmux each reply is bound to its workspace and surface. In `auto` mode a reply waits until that surface is focused and Cmux is in front; newer replies from the same surface replace older ones; if Cmux does not answer, the reply is spoken at once. `immediate` speaks every reply at once; `off` reads nothing.

```bash
agent-voice config set speech-muted false
agent-voice config set speech-mode off
agent-voice config set speech-voice M2
agent-voice speak "Release status: **ready**."
```

## Refine

| `refine-mode` | Behavior |
| --- | --- |
| `off` | Type what you said (default). |
| `dictation` | Refine the final dictation (5 words or more) before it is typed; after 20 s the dictated text is typed instead. |
| `clipboard` | Double-tap Shift refines the copied prompt and copies the result back; press ⌘V. |
| `both` | Both of the above. |

agent-voice tries the configured provider and model, rotates through that provider's models, then the other providers installed (codex, opencode, gemini, grok, pi, ollama, claude). A reply is rejected when it is empty, a CLI help dump, an auth or quota error, an error envelope, or when it drops any code, path, URL, or quoted text from your draft. When every attempt fails, a macOS dialog lets you pick a model or skip refine (`AGENT_VOICE_REFINE_PICKER=off` disables it). `refine-send-to cmux-new` or `cmux-resume` sends the refined prompt into cmux instead of the caret.

## Settings

Every setting lives in one file, `~/.agent-voice/config.json`. You do not need to open it: `agent-voice config` shows, checks, and changes each value, and a change applies at once. On the command line a name is the kebab-case form of its JSON key (`speech-mode` is `speechMode`).

```bash
agent-voice config list                  # every setting and its current value
agent-voice config set speech-voice M2
agent-voice config unset speech-voice    # back to the default
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `speech-mode` | `"auto"` | When agent replies are read aloud: auto holds a Cmux reply until its surface is focused and Cmux is in front, and speaks other replies at once; immediate speaks every reply at once; off reads nothing. |
| `speech-muted` | `true` | Read nothing while true; replies that arrive meanwhile are dropped, not saved for later. Double-tap Shift flips it (outside clipboard refine mode). |
| `speech-voice` | `"F4"` | Supertonic voice: F1-F5 or M1-M5. |
| `speech-words-per-minute` | `230` | Speed of read-aloud replies, in words per minute (the voice speed is clamped to 0.7-2.0x). |
| `dictation-language` | `"en"` | Dictation language: en (whisper.cpp large-v3-turbo) or he (ivrit.ai Hebrew large-v3-turbo). Accepts english, hebrew, ivrit, iw. With dictation-model auto it picks the model. |
| `dictation-model` | `"auto"` | Whisper model for dictation: auto (turbo-q5 for en, ivrit for he), tiny, base, small, turbo-q5, turbo-q8, turbo, or ivrit. Changing it downloads the model if missing and restarts dictation. AGENT_VOICE_DICTATION_MODEL overrides it. |
| `dictation-keep-listening-seconds` | `0.2` | Seconds the microphone stays open after Shift is released, so trailing words are not cut off. |
| `dictation-replacements` | `""` | Semicolon-separated heard=written pairs applied to dictation, e.g. Joseph=Yosef;type script=TypeScript. |
| `refine-mode` | `"off"` | Prompt refine: off; clipboard = double-tap Shift refines the copied prompt; dictation = refine the dictation before it is typed; both. |
| `refine-provider` | `"codex"` | Agent CLI that refines: codex \| auto \| grok \| ollama \| opencode \| claude \| gemini \| pi. `agent-voice config pick-refine` lists only the CLIs found on this Mac. |
| `refine-model` | unset | Model ID for the refine provider (e.g. gpt-5.3-codex-spark, grok-4.5, llama3.2). Unset: gpt-5.3-codex-spark for codex, the provider's own models otherwise. |
| `refine-effort` | unset | Reasoning effort for providers that support it. Unset: low, so dictation refine stays fast. |
| `refine-press-enter` | `false` | Press Enter after dictated text (refined or not) is typed at the caret. |
| `refine-send-to` | `"caret"` | Where refined dictation goes: caret (the focused input), cmux-new (a new focused cmux workspace), or cmux-resume (the focused cmux surface). |
| `refine-cmux-command` | `""` | Shell command run in the new cmux workspace for cmux-new. Placeholders, each replaced by one shell-quoted word: {{prompt_file}}, {{prompt}}, {{cwd}}. Empty pastes the text only. |
| `refine-cmux-press-enter` | `false` | Press Enter after sending refined text into cmux (cmux-resume, or cmux-new without a command). |

## Environment variables

These change where agent-voice keeps its files and switch a few features off. For the installed `agent-voice`, export them in your shell profile. When you run from source, copy [`.env.example`](.env.example) to `.env` and fill in a value: `pnpm cli` loads `.env`, and an empty value keeps the default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AGENT_VOICE_HOME` | `~/.agent-voice` | Folder for config, state, models, and logs. |
| `AGENT_VOICE_CONFIG_FILE` | `$AGENT_VOICE_HOME/config.json` | The only config file read when set. |
| `AGENT_VOICE_DICTATION_MODEL` | unset | Force the Whisper model: `turbo-q5`, `turbo-q8`, `turbo`, `small`, `base`, `tiny`, or `ivrit`. Overrides the `dictation-model` setting. |
| `AGENT_VOICE_DICTATION_LIVE_PREVIEW` | on | `off` (or `0`, `false`, `no`) stops the live caption while Shift is held. |
| `AGENT_VOICE_REFINE_PICKER` | on | `off` (or `0`, `false`, `no`) never opens the macOS model picker; it is also off when `CI` is set. |

## Files

Everything agent-voice writes lives in `~/.agent-voice` (or `$AGENT_VOICE_HOME`):

| Path | Holds |
| --- | --- |
| `config.json` | Settings. |
| `models/` | Whisper `ggml-*.bin` files and `supertonic-3/`. |
| `inbox/`, `failed/`, `seen.json` | Queued replies, replies that failed to play, and the replies already spoken (24 h). |
| `status.json` | The dictation stage the pill shows. |
| `dictation.log`, `dictation-worker.log`, `speech-worker.log` | Timings and worker output. |
| `backups/` | A copy of each agent settings file before agent-voice edited it. |
| `created-hook-files.json`, `claude-config-folders.json` | The hook settings files agent-voice created, and the Claude Code folders `CLAUDE_CONFIG_DIR` named when hooks were added, so `off` finds them later. |
| `refine-choice.json`, `refine-codex-*.txt` | The last refine pick and Codex's working and failing models. |
| `prompts/`, `audio/`, `devin/` | Refined prompts handed to cmux, speech audio being played, and Devin session exports. |
| `*.pid`, `*.lock`, `stop` | Worker bookkeeping. |

What you dictate and what agents reply stays yours: every file agent-voice keeps in `~/.agent-voice` that holds it, and every settings backup, is created readable by you alone (mode 0600), in folders only you can open (0700, `~/.agent-voice` included). agent-voice tightens such a file or folder whenever it finds one looser. A file you ask for elsewhere, like `agent-voice speak --output <file>`, keeps your usual permissions, and so does the folder of an `AGENT_VOICE_CONFIG_FILE` you point outside `~/.agent-voice`.

Agent hooks: `~/.claude/settings.json`, `~/.codex/hooks.json`, and `~/.grok/hooks/agent-voice.json` each get one Stop entry whose command ends in `reply --agent <id>`; `agent-voice off` removes exactly that entry. Every other Claude Code config folder gets one too: each `~/.claude-<name>` folder Claude Code has used, and `CLAUDE_CONFIG_DIR` when it is set.

## Project structure

| Folder | Holds |
| --- | --- |
| `src/cli/` | One file per command (`<name>Command.ts`), `main.ts` (the only place an Effect runs), and `TerminalUI.ts` (all terminal output) |
| `src/settings/` | The settings Schema, the config file, the `AGENT_VOICE_*` variables, and the `~/.agent-voice` paths |
| `src/files/` | Atomic state files, file locks, and model downloads |
| `src/dictation/` | Hold Shift: keyboard, microphone, clip audio, Whisper, transcript text, live caption, typing at the caret, and the dictation worker |
| `src/speech/` | Replies read aloud: inbox, Markdown to speech, Supertonic, playback, Cmux focus, and the speech worker |
| `src/refine/` | Agent CLI discovery and calls, reply checks, model rotation, the picker, and cmux delivery |
| `src/agents/` | The agent catalog, Stop hook edits, `agent-voice reply`, and the Devin watcher |
| `src/workers/` | Worker processes, `status.json`, worker logs, and the pill |
| `src/scripts/` | Tooling only: the code-style and rule-card checkers, `pnpm bench`, `pnpm cli` (the CLI from source), and the test helpers `makeTestFolder` and `runAgentVoice` |

## Development

```bash
pnpm install
pnpm verify          # Biome, typecheck, code-style rules, rule cards, tests, build
pnpm cli status      # run the CLI from source; loads .env when it exists
pnpm bench --models base,turbo-q5 --seconds 1,2,4 --runs 3
```

Tests never touch your real `~/.agent-voice` or agent settings. Each test makes its own home folder under `.test-home/` (gitignored, safe to delete) with `makeTestFolder` from `src/scripts/testFolder.ts`. The Whisper and Supertonic smoke tests read the models already in `~/.agent-voice/models` and skip when they are missing.

Hand checks need a mic, a keyboard, and macOS permissions. After `agent-voice on`:

1. `agent-voice doctor` passes Microphone and Accessibility.
2. `agent-voice hotkey-check --seconds 8` prints each Shift press.
3. In a text field, hold Shift and say "hello comma world period": `Hello, world.` is typed.
4. Shift+A types `A`, and Shift held with another key types nothing.
5. `agent-voice speak "Release status: **ready**."` reads one sentence, and a tap on Shift stops it.
6. `agent-voice off` leaves each agent settings file as its copy in `~/.agent-voice/backups/`, minus the agent-voice Stop entry.

Agents start at [AGENTS.md](AGENTS.md).

## License

MIT
