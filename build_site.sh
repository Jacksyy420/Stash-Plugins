#!/usr/bin/env bash
# Baut aus plugins/<id>/ je ein Zip und erzeugt eine index.yml fuer Stash.
# Aufruf: bash build_site.sh [ausgabeordner]   (Standard: _site)
set -euo pipefail

PLUGIN_DIR="plugins"
OUT="${1:-_site}"

rm -rf "$OUT"
mkdir -p "$OUT"
OUT_ABS="$(cd "$OUT" && pwd)"
INDEX="$OUT_ABS/index.yml"
: > "$INDEX"

# Liest ein Feld der obersten Ebene aus einem Manifest
get_field() {
  grep -m1 -E "^$2:" "$1" \
    | sed -E "s/^$2:[[:space:]]*//; s/^[\"']//; s/[\"']$//" \
    | tr -d '\r' || true
}

# Maskiert Anfuehrungszeichen fuer YAML-Strings in doppelten Anfuehrungszeichen
yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

count=0
for dir in "$PLUGIN_DIR"/*/; do
  [ -d "$dir" ] || continue
  dir="${dir%/}"
  id="$(basename "$dir")"
  manifest="$dir/$id.yml"

  if [ ! -f "$manifest" ]; then
    echo "Ueberspringe $id: Manifest $manifest fehlt" >&2
    continue
  fi

  name="$(get_field "$manifest" name)"
  description="$(get_field "$manifest" description)"
  version="$(get_field "$manifest" version)"

  if [ -z "$name" ] || [ -z "$version" ]; then
    echo "Fehler: $manifest braucht 'name' und 'version'" >&2
    exit 1
  fi

  # Datum des letzten Commits, der dieses Plugin betrifft (UTC)
  date_str="$(TZ=UTC git log -1 --format=%cd --date=format-local:'%Y-%m-%d %H:%M:%S' -- "$dir" 2>/dev/null || true)"
  if [ -z "$date_str" ]; then
    date_str="$(date -u '+%Y-%m-%d %H:%M:%S')"
  fi

  # Zip mit Dateien direkt im Zip-Root
  zip_path="$OUT_ABS/$id.zip"
  (cd "$dir" && zip -r -q -X "$zip_path" . -x '.*' -x '*/.*')
  sha256="$(sha256sum "$zip_path" | cut -d' ' -f1)"

  {
    echo "- id: $id"
    echo "  name: \"$(yaml_escape "$name")\""
    echo "  metadata:"
    echo "    description: \"$(yaml_escape "$description")\""
    echo "  version: \"$(yaml_escape "$version")\""
    echo "  date: \"$date_str\""
    echo "  path: $id.zip"
    echo "  sha256: $sha256"
    echo ""
  } >> "$INDEX"

  echo "OK: $id $version"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "Fehler: Keine Plugins unter $PLUGIN_DIR/ gefunden" >&2
  exit 1
fi

echo "$count Plugin(s) nach $OUT_ABS gebaut."
