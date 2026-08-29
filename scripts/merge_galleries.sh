#!/usr/bin/env bash
# One-off merge: copy new files from galleries_import/<character> into
# galleries/<character> for every character folder that exists in both.
# Run from the data/ folder so galleries_import/ and galleries/ resolve locally.
#
# Usage: ./merge_galleries.sh

set -euo pipefail

SRC="galleries_import"
DST="galleries"

if [[ ! -d "$SRC" ]]; then
  echo "Error: '$SRC' not found in $(pwd)" >&2
  exit 1
fi
if [[ ! -d "$DST" ]]; then
  echo "Error: '$DST' not found in $(pwd)" >&2
  exit 1
fi

shopt -s nullglob

for src_dir in "$SRC"/*/; do
  name="$(basename "$src_dir")"
  dst_dir="$DST/$name"

  if [[ ! -d "$dst_dir" ]]; then
    echo "WARNING: no counterpart folder for '$name' in $DST/ - skipping" >&2
    continue
  fi

  # Copy only files that don't already exist at the destination.
  # --out-format='%n' prints each transferred path; directory entries end in '/'.
  copied=()
  while IFS= read -r line; do
    [[ -n "$line" && "$line" != */ ]] && copied+=("$line")
  done < <(rsync -a --ignore-existing --out-format='%n' "$src_dir" "$dst_dir")

  if (( ${#copied[@]} > 0 )); then
    echo "Migrated ${#copied[@]} file(s) into '$name':"
    printf '  %s\n' "${copied[@]}"
  fi
done
