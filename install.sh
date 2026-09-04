#!/usr/bin/env sh
set -eu
if [ "$#" -lt 1 ]; then
  echo "Usage: ./install.sh /path/to/repo [extra install.py options]"
  exit 1
fi
python3 "$(dirname "$0")/install.py" "$@"
