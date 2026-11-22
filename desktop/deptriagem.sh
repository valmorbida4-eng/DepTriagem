#!/bin/sh
set -eu
resources=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$(uname -s)" in
  Darwin) executable="$resources/../MacOS/DepTriagem" ;;
  Linux) executable="$resources/../deptriagem" ;;
  *) echo "Use deptriagem.cmd no Windows." >&2; exit 2 ;;
esac
export ELECTRON_RUN_AS_NODE=1
exec "$executable" "$resources/app.asar/build/electron/cli.js" "$@"
