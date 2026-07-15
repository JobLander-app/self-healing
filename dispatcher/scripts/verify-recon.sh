#!/usr/bin/env bash
# verify-recon.sh — prove the reconstructed src/ reproduces the recovered dist/.
#
# Builds src/ with the project tsconfig into a TEMP outDir (dist/ — the golden
# reference recovered from the VM — is never overwritten) and diffs every
# generated .js and .d.ts against dist/. Any difference fails the check.
#
# Source maps (.js.map) are compared too, but only as an informational bonus:
# they encode original source-line/column layout, which is not fully
# recoverable (type-only regions leave no trace in the emitted JS). A map
# mismatch does NOT fail the check.
#
# The temp outDir lives INSIDE dispatcher/ so the maps' relative "sources"
# paths ("../src/*.ts") match the golden ones.
#
# Usage: cd dispatcher && bash scripts/verify-recon.sh
set -uo pipefail

cd "$(dirname "$0")/.."

TMP_OUT=".tmp-verify-recon"
rm -rf "$TMP_OUT"
trap 'rm -rf "$TMP_OUT"' EXIT

echo "[verify-recon] Building src/ -> $TMP_OUT"
npx tsc --outDir "$TMP_OUT" || { echo "[verify-recon] FAIL: tsc build errored"; exit 1; }

fail=0
for golden in $(cd dist && find . -name '*.js' -o -name '*.d.ts' | sort); do
  gen="$TMP_OUT/$golden"
  if [ ! -f "$gen" ]; then
    echo "[verify-recon] MISSING: $golden not produced by build"
    fail=1
    continue
  fi
  if diff "dist/$golden" "$gen" > /dev/null; then
    echo "[verify-recon] OK:    $golden"
  else
    echo "[verify-recon] DIFF:  $golden"
    diff "dist/$golden" "$gen" | head -40
    fail=1
  fi
done

# Flag files the build produced that the golden dist lacks.
for gen in $(cd "$TMP_OUT" && find . -name '*.js' -o -name '*.d.ts' | sort); do
  [ -f "dist/$gen" ] || { echo "[verify-recon] EXTRA: $gen not in golden dist"; fail=1; }
done

# Informational: source-map equality (formatting-level reconstruction).
echo "[verify-recon] --- source maps (informational) ---"
for golden in $(cd dist && find . -name '*.js.map' | sort); do
  if diff -q "dist/$golden" "$TMP_OUT/$golden" > /dev/null 2>&1; then
    echo "[verify-recon] MAP OK:    $golden"
  else
    echo "[verify-recon] MAP DIFF:  $golden (formatting-level only; not a failure)"
  fi
done

if [ "$fail" -eq 0 ]; then
  echo "[verify-recon] PASS — reconstructed sources reproduce dist/ .js and .d.ts byte-for-byte"
else
  echo "[verify-recon] FAIL — differences above"
fi
exit "$fail"
