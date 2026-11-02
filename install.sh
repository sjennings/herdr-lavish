#!/bin/sh
# Links this checkout into herdr-app, PATH and Claude Code. Rerun after moving it.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
herdr_home=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
link() { mkdir -p "$(dirname "$2")"; ln -sfn "$1" "$2"; echo "linked $2 -> $1"; }
link "$here/mods/lavish" "$herdr_home/mods/lavish"
link "$here/bin/lavish-herdr" "$HOME/.local/bin/lavish-herdr"
link "$here/skill/lavish-herdr" "$HOME/.claude/skills/lavish-herdr"
herdr-app check "$herdr_home/mods/lavish"
