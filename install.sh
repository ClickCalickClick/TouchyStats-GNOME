#!/bin/bash
# Install TouchyStats for the current user.
#   ./install.sh        pack and install a copy (the normal way)
#   ./install.sh --dev  symlink this checkout instead, so edits apply on next login
set -euo pipefail
cd "$(dirname "$0")"
UUID=touchystats@clickcalickclick.github.io
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

glib-compile-schemas schemas

if [ "${1:-}" = "--dev" ]; then
    rm -rf "$DEST"
    ln -sfn "$PWD" "$DEST"
    echo "Linked $DEST -> $PWD"
else
    gnome-extensions pack --force \
        --extra-source=lib --extra-source=ui --extra-source=icons \
        --schema=schemas/org.gnome.shell.extensions.touchystats.gschema.xml .
    gnome-extensions install --force "$UUID.shell-extension.zip"
    rm -f "$UUID.shell-extension.zip"
    echo "Installed to $DEST"
fi

# A brand-new extension isn't known to the running Shell until the next login,
# so this may fail the first time; enable it from the Extensions app afterwards.
gnome-extensions enable "$UUID" 2>/dev/null || true
echo "Log out and back in to load it, then enable TouchyStats in the Extensions app if it isn't already on."
