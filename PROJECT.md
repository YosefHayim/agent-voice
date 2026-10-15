# PROJECT.md

## Purpose

Talk to coding agents and listen to them, on a Mac, without sending audio anywhere:

1. **Dictation**: hold Shift, speak, release; the words land at the caret.
2. **Speech**: an agent's finished reply is read aloud, in a natural voice, without reading Markdown punctuation.
3. **Refine** (optional): turn a rambling dictated or copied draft into a clean prompt with an agent CLI the user already has.

## In scope

- macOS (Apple Silicon first), Node 22+, one `voxkey` command.
- Agents with a Stop hook voxkey can register: Claude Code, Codex, Grok. Devin through its ATIF export.
- Local models: Whisper (whisper.cpp) for dictation, Supertonic 3 for speech.
- Refine through agent CLIs: codex, claude, gemini, grok, ollama, opencode, pi.

## Out of scope

- Windows and Linux (every mechanism is a macOS API).
- Cloud speech services.
- Installing anything into agents other than one Stop hook entry.
- A GUI app; the pill is a status display, not a window to interact with.

## Direction

- Keep the dictation path fast: model loaded once, mic always open, serial queue.
- Prefer maintained npm packages with prebuilt macOS binaries over system tools, and system tools over Homebrew tools.
- Decisions go in the PR description.
