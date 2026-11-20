#!/usr/bin/env bash
# The public repo installs js/ with npm ci, but here js/ is a yarn workspace,
# so the npm lockfile is made in a copy outside the monorepo.
set -euo pipefail

js_dir="$(cd "$(dirname "$0")/../js" && pwd)"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

cp "$js_dir/package.json" "$work_dir/"
(cd "$work_dir" && npm install --package-lock-only --no-audit --no-fund --ignore-scripts)
cp "$work_dir/package-lock.json" "$js_dir/package-lock.json"
echo "Updated js/package-lock.json"
