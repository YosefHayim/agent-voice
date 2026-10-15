# CONTEXT.md

How voxkey runs on a Mac. Words are defined in `LANGUAGE.md`.

## Processes

| Process | Started by | Lives | Does |
| --- | --- | --- | --- |
| `voxkey <command>` | the user | one command | everything in `src/cli/` |
| dictation worker (`voxkey worker dictation`) | `voxkey on`, or `voxkey reply` after a reboot | until `voxkey off` / `reset` | loads Whisper, opens the mic, polls Shift every 8 ms, runs the queue, starts the pill and the speech worker |
| speech worker (`voxkey worker speech`) | the dictation worker, `voxkey reply`, or `config set speech-mode` | until speech is off or `voxkey off` | inbox → Supertonic → `afplay` |
| pill (`osascript -l JavaScript`) | the dictation worker | until that worker exits | shows `status.json` at the bottom of the screen |
| `voxkey reply` | an agent's Stop hook | one turn | queues the reply, wakes the workers, prints nothing, exits 0 |

Workers are spawned detached in their own process groups and log to `~/.voxkey/*-worker.log`. A worker holds its kind's lock (`*.lock`, an exclusive lock the kernel takes in `open` and drops when the worker exits, even by SIGKILL, so exactly one starter wins and no stale lock is ever taken over; plus `*.pid`); a pid file counts, and its pid is signalled, only while `ps` shows that pid running the worker's (or the pill's) command line. `voxkey off` removes the agent hooks first, then writes `stop`, sends SIGTERM to each worker group a pid file names, and SIGKILLs any of them still alive after 4 s and the pill. Then, with no SIGTERM first, it SIGKILLs every other voxkey worker or pill that `ps` shows by command line (a stray no pid file names). A tap or a new hold sends SIGUSR2 to the speech worker to stop speech at once.

## Files

All state is in `~/.voxkey` (`VOXKEY_HOME`). Writes go through a temporary sibling and a rename. Files that hold dictated, refined, or reply text (`dictation.log`, the worker logs, `status.json`, the inbox, `failed/`, `prompts/`, `audio/`) are 0600 in 0700 folders, and voxkey tightens looser ones when it writes them. The only files voxkey edits outside it are the agents' hook settings (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.grok/hooks/voxkey.json`), always backed up to `~/.voxkey/backups/` first.

## Permissions

macOS grants these to the app that runs voxkey (usually the terminal):

- **Microphone**: the dictation worker's PvRecorder.
- **Accessibility**: posting key events at the caret and `System Events` ⌘V.
- **Input Monitoring**: reading key state; voxkey reads HID state, which usually works without it, so it is a warning in `voxkey doctor`.

## Network

Only model downloads (Hugging Face) and whatever the chosen refine CLI does. Dictation and speech never leave the Mac.
