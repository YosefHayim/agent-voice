# LANGUAGE.md — agent-voice

Names only: use these words in code, comments, commits, and docs, and avoid the listed aliases. One word per idea.

**dictation**
Hold Shift, speak, release: the words are typed at the caret.
_Avoid_: "stt", "speech-to-text" in identifiers, "voice input".

**speech**
Reading an agent reply aloud.
_Avoid_: "tts", "narration", "voice output".

**voice**
One Supertonic speaker (F1–F5, M1–M5), as in `speechVoice`.
_Avoid_: "voice" for the whole product or feature.

**refine**
Rewriting a dictated or copied draft into a clean prompt with an agent CLI.
_Avoid_: "rewrite", "polish", "route".

**agent reply**
The complete text an agent finished a turn with.
_Avoid_: "response", "message", "output".

**hold**
Shift pressed alone past 300 ms: a dictation.
_Avoid_: "press", "hotkey event".

**tap**
A Shift press shorter than a hold; a **double tap** is two within 400 ms.

**clip**
The audio of one hold, from Shift down to the end of the release tail.
_Avoid_: "recording", "buffer" (the buffer is the mechanism that holds a clip).

**transcript**
Whisper's text for a clip.
_Avoid_: "result", "raw text".

**live caption**
The Whisper pass over the last 8 s while a hold is still recording, shown in the pill only.
_Avoid_: "preview" in prose (the environment variable keeps the word).

**caret**
The focused text field where dictation is typed.

**pill**
The small status panel at the bottom of the screen.
_Avoid_: "HUD", "overlay".

**worker**
A background agent-voice process: the dictation worker or the speech worker.
_Avoid_: "daemon", "service".

**inbox**
The folder of queued agent replies waiting for the speech worker.
_Avoid_: "queue" (the dictation queue is a different thing).

**provider**
An agent CLI that can refine (codex, claude, gemini, grok, ollama, opencode, pi).
_Avoid_: "backend".

**Stop hook**
The agent's end-of-turn hook; agent-voice's entry runs `agent-voice reply --agent <id>`.

**setting**
One key in `~/.agent-voice/config.json`; the CLI name is its kebab-case form.
_Avoid_: "option", "flag" (those are CLI arguments).

**fail-open**
Exit 0 and print nothing on any error, so an agent is never blocked.
