# Spike: agent sessions in the browser

Throwaway spike for the ATF web UI (see `docs/webui-brief.md`). It checks that agents
can run in our own sessions, without tmux, herdr or native Node modules, and be used
from a browser that reaches the machine only through SSH.

- `sessiond.mjs`: session daemon. Holds the agents' terminals (Linux: util-linux
  `script`; macOS, for development: python3 `pty`), keeps each session's recent output
  for reattaching, resizes through `stty -F`. Unix socket, owner-only. Survives the web
  server and the browser.
- `web.mjs`: web server on `127.0.0.1` only, token check, a minimal WebSocket, relays to
  the daemon (starts it when needed).
- `public/`: the page: sessions in a sidebar, tabs, xterm.js terminals. The theme is
  `theme-macchiato.css` (Catppuccin Macchiato).
- `public/vendor/`: third-party files with their licences: xterm.js 6.0.0, addon-fit
  0.11.0 and addon-webgl 0.19.0 (MIT); JetBrains Mono 2.304, regular/bold/italic, full
  character set (SIL Open Font License 1.1, from JetBrains' release).

## Run

```sh
node spike/webterm/web.mjs            # port 7420 (or: node web.mjs 8000)
```

It prints `http://localhost:7420/?token=…` (the token is kept in
`~/.config/atf/web-token`). On a remote machine, from your own:

```sh
ssh -L 7420:localhost:7420 <devpod>
```

and open the printed URL locally. Start a session in the sidebar (`copilot`, `pi`,
`opencode`, `shell`); closing a tab or the browser leaves it running; right-click a
session to stop or remove it. Stopping the daemon (`pkill -f sessiond.mjs`) ends all
sessions.

Debugging: `ATF_SESSIOND_LOG=/tmp/sessiond.log node spike/webterm/web.mjs` (the daemon
inherits it when the server starts it).

## What to check on a devpod

1. Copilot through the tunnel: colours, keys (arrows, Ctrl-C, Esc), paste, resizing
   the browser window, its trust and approval prompts.
2. Close the browser tab while Copilot works, reopen: the screen comes back.
3. Restart `web.mjs` while Copilot runs: it keeps running, the page reconnects.
4. Typing latency over the tunnel.
