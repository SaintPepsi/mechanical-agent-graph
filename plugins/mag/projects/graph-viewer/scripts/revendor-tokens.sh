#!/bin/sh
# Copies the Arcade Terminal tokens file from a local checkout of its source into this
# project. Usage: bun run revendor-tokens <source-tokens-file-path>
set -eu

source="${1:-}"
if [ -z "$source" ]; then
	echo "usage: revendor-tokens <source-tokens-file-path>" >&2
	exit 2
fi

if [ ! -f "$source" ]; then
	echo "revendor-tokens: no tokens file at $source" >&2
	exit 1
fi

here="$(cd "$(dirname "$0")/.." && pwd)"
target="$here/src/lib/styles/tokens.css"
cp "$source" "$target"
echo "vendored $source -> $target"
