#!/bin/bash
# Watches the Mac clipboard; whenever it changes AND Terminal.app is the
# frontmost app, simulates Cmd+V so text copied on the phone (which syncs to
# the Mac clipboard via Simulator pasteboard sync / Universal Clipboard)
# lands directly in whatever you're typing in Terminal.
#
# Start:  ./scripts/auto-paste-watcher.sh &
# Stop:   pkill -f auto-paste-watcher.sh

last="$(pbpaste 2>/dev/null)"
pending=""

while true; do
  current="$(pbpaste 2>/dev/null)"
  if [ "$current" != "$last" ] && [ -n "$current" ]; then
    last="$current"
    pending="$current"
  fi

  if [ -n "$pending" ]; then
    frontmost=$(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>/dev/null)
    if [ "$frontmost" = "Terminal" ]; then
      osascript -e 'tell application "System Events" to keystroke "v" using command down' 2>/dev/null
      pending=""
    fi
  fi

  sleep 0.4
done
