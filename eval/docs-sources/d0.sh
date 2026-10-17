#!/bin/sh
# D0 (vault: "Docs Sources - Eval"): Prisma docs before 7.0.0 vs before the February 2026 restructure,
# searched for the two misses docs could carry (eval/gate/MISSES.md bucket 1). Read-only; writes under $1.
set -eu
W=${1:?work dir}; mkdir -p "$W/snap"; cd "$W"
[ -d prisma-web ] || git clone -q --filter=blob:none --no-checkout --shallow-since=2025-09-01 https://github.com/prisma/web.git prisma-web
cd prisma-web
A=$(git rev-list -1 --before=2025-11-19T00:00 HEAD)   # 7.0.0 published 2025-11-19T14:04Z
B=$(git rev-list -1 --before=2026-02-11 HEAD)         # last commit before content/ moved to apps/docs/content
for c in "$A" "$B"; do mkdir -p "../snap/$c"; git archive "$c" content | tar -x -C "../snap/$c"; done
git archive HEAD apps/docs/content | tar -x -C ../snap
cd ..; diff -ruN "snap/$A/content" "snap/$B/content" > prisma-docs-7.diff || true
echo "commits touching docs in the window, by subject:"
git -C prisma-web log --format='%h %ad %s' --date=short --since=2025-11-19 --until=2026-02-11 | grep -iE 'upgrade|v7|prisma 7' || true
echo "SQLite relative URL resolution (cedar K12), added lines:"
grep -nE '^\+' prisma-docs-7.diff | grep -iE 'sqlite|file:\./' | grep -iE 'relative|cwd|working directory|config file' || echo "  none"
echo "qualified generated type names (jsontypes K8-K13), added lines and current docs:"
grep -nE '^\+' prisma-docs-7.diff | grep -E 'Prisma\.[A-Za-z]+(FieldUpdateOperationsInput|NullableListFilter|NullValueInput)|runtime\.[A-Z]' || echo "  none in diff"
grep -rnE 'Prisma\.[A-Za-z]+(FieldUpdateOperationsInput|NullableListFilter|NullValueInput)|runtime\.[A-Z][a-zA-Z]+Input' snap/apps/docs/content || echo "  none in current docs"
