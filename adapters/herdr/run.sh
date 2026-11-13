#!/usr/bin/env bash
# herdr runs plugin commands with a minimal PATH; make node/herdr resolvable.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:/usr/bin:/bin:${PATH:-}"
ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")" && pwd)}"
exec node "$ROOT/atf-herdr.mjs" "$@"
