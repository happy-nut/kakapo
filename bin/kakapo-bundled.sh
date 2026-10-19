#!/bin/sh
# The `kakapo` command for a .dmg / Homebrew install.
#
# The npm package installs bin/kakapo.js and relies on a `node` on PATH. A packaged bundle has no node and no
# node_modules/electron — it IS Electron — so this runs the same CLI with the bundle's own binary hosted as
# node, which is the one runtime the install is guaranteed to have. resolveElectronBinary (commands.ts) then
# spawns that same executable as the app.
#
# Lives at Contents/Resources/app/bin/ inside the bundle; the app binary is three levels up in MacOS/.
set -eu

# Follow $0 through symlinks before measuring anything from it. Homebrew installs this command as a link
# in its own bin directory, so `dirname "$0"` is /opt/homebrew/bin and every path derived from it lands
# outside the bundle — the install produced `cd: /opt/../MacOS: No such file or directory` and nothing
# else. A chain is followed, and a relative link is resolved against the directory it was found in.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
here=$(cd "$(dirname "$self")" && pwd)
resources=$(cd "$here/../.." && pwd)
macos=$(cd "$resources/../MacOS" && pwd)

# The bundle is named after the app, and that name is the only thing here that is not fixed: patch-electron-name
# renames the executable at install time. There is exactly one file in MacOS/, so ask rather than hardcode.
app=$(ls "$macos" | head -1)

exec env ELECTRON_RUN_AS_NODE=1 "$macos/$app" "$here/kakapo.js" "$@"
