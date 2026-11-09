#!/bin/sh
# Cloudflare Pages (プロジェクト kalimba-practice) へ、コミット済みの index.html / css / js だけを上げる。
set -eu

PROJECT=kalimba-practice
cd "$(dirname "$0")/.."

if ! command -v wrangler >/dev/null 2>&1; then
  echo "wrangler が見つかりません。Cloudflare の CLI を入れてから実行してください。" >&2
  exit 1
fi
# 上げるのはコミットの中身なので、未コミットの変更があると手元と公開版がずれる。
if [ -n "$(git status --porcelain)" ]; then
  echo "未コミットの変更があります。コミットしてから実行してください。" >&2
  git status --short >&2
  exit 1
fi

out=$(mktemp -d "${TMPDIR:-/tmp}/kalimba-pages.XXXXXX")
git archive HEAD index.html css js | tar -x -C "$out"

wrangler pages deploy "$out" \
  --project-name "$PROJECT" \
  --branch main \
  --commit-hash "$(git rev-parse HEAD)" \
  --commit-message "$(git log -1 --format=%s)" \
  --commit-dirty=false
