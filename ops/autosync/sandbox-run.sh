#!/bin/bash
# Run an explicit maintenance operation with the installed service restrictions.
set -euo pipefail
UNIT=/etc/systemd/system/synapse-autosync.service
props=()
while IFS= read -r property; do props+=(-p "$property"); done < <(
  sed -n '/^\[Service\]/,/^\[/p' "$UNIT" | grep -E '^[A-Za-z]+=' | grep -vE '^(Type|ExecStart)=')
systemd-run --quiet --wait --pipe --collect "${props[@]}" /usr/bin/python3 /usr/local/lib/synapse-autosync/synapse-autosync.py "$@"
