# Regenerate with:  vhs demo/demo.tape     (from the repo root)
# Requires: vhs (brew install vhs), a built ./ruddr, and a codex CLI with
# `codex app-server` + `turn/steer` support.
#
# The demo runs a real Codex turn in a scratch workspace under /tmp. It pins
# XDG_STATE_HOME to that scratch dir so the TUI shows only this run, never the
# operator's real session registry.

Output demo/ruddr-demo.gif

Set Shell zsh
Set FontSize 15
Set Width 1180
Set Height 780
Set Padding 20
Set Theme "Catppuccin Mocha"
Set Framerate 20
Set TypingSpeed 40ms

Hide
Type "PS1='%F{green}❯%f ' && clear" Enter
Type "rm -rf /tmp/ruddr-demo && mkdir -p /tmp/ruddr-demo/ws" Enter
Type "export XDG_STATE_HOME=/tmp/ruddr-demo/state && clear" Enter
Show

Sleep 1s

# The whole surface, one screen.
Type "./ruddr --help"
Sleep 500ms
Enter
Sleep 4s

Type "clear" Enter
Sleep 500ms

# Launch a long Codex turn in the background. Ruddr owns the app-server
# connection, so the turn stays reachable after it starts.
Type "./ruddr run --cwd /tmp/ruddr-demo/ws --prompt-file demo/prompt.md --state-dir /tmp/ruddr-demo/run --sandbox workspace-write >/tmp/ruddr-demo/run.log 2>&1 </dev/null & disown"
Sleep 500ms
Enter
Sleep 11s

# Watch it work.
Type "./ruddr peek --state-dir /tmp/ruddr-demo/run -n 6"
Sleep 500ms
Enter
Sleep 4s

Type "clear" Enter
Sleep 500ms

# The point: change the heading of a turn that is already running.
Type "./ruddr steer --state-dir /tmp/ruddr-demo/run 'change of plan: make it Fibonacci instead of primes, tests first'"
Sleep 500ms
Enter
Sleep 10s

# Same turn id, same process - it just went a different way.
Type "./ruddr peek --state-dir /tmp/ruddr-demo/run -n 6"
Sleep 500ms
Enter
Sleep 4s

Type "./ruddr status --state-dir /tmp/ruddr-demo/run"
Sleep 500ms
Enter
Sleep 4s

Type "clear" Enter
Sleep 500ms

# The live session, in the TUI.
Type "./ruddr tui --state-dir /tmp/ruddr-demo/run"
Sleep 500ms
Enter
Sleep 7s
Type "q"
Sleep 1s
