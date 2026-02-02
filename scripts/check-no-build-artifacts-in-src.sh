#!/usr/bin/env bash
set -euo pipefail

# Fail if TS build artifacts are committed/generated under any packages/**/src
# We only allow .ts/.tsx sources in src.

bad=$(find packages -path '*/src/*' \( -name '*.js' -o -name '*.d.ts' -o -name '*.js.map' \) -print || true)

if [[ -n "${bad}" ]]; then
  echo "ERROR: Found build artifacts under packages/**/src (should be in dist/):" >&2
  echo "${bad}" >&2
  exit 1
fi

echo "OK: no build artifacts under packages/**/src"
