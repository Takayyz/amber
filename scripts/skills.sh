#!/usr/bin/env bash
# Installs the agent skills declared in .agents/skills.json via `gh skill`.
#
# Usage: pnpm skills:install
#
# Why a script: `gh skill install` takes one skill per invocation and has no
# manifest support, so the repo's skill set has to live somewhere declarative.
# There is no standard for this yet -- the Agent Skills spec only covers
# SKILL.md itself, and the manifest RFC (agentskills/agentskills#210) is still
# open with several competing proposals. So this stays deliberately thin:
# read the manifest, loop, and let `gh skill` own version resolution via its
# native `skill@version` syntax. Drop this the day a standard lands.
#
# .agents/skills/ is generated and gitignored; .agents/skills.json is the
# source of truth. Skills present on disk but absent from the manifest are
# removed, the same way a package manager prunes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MANIFEST=".agents/skills.json"
SKILLS_DIR=".agents/skills"

for cmd in gh jq; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: $cmd is required but not installed." >&2
    exit 1
  fi
done

if [ ! -f "$MANIFEST" ]; then
  echo "error: $MANIFEST not found." >&2
  exit 1
fi

# Keys starting with '$' are metadata ($comment), not repositories.
MANIFEST_ENTRIES="$(jq -r '
  to_entries[]
  | select(.key | startswith("$") | not)
  | .key as $repo
  | .value[]
  | "\($repo)\t\(.)"
' "$MANIFEST")"

if [ -z "$MANIFEST_ENTRIES" ]; then
  echo "error: no skills declared in $MANIFEST." >&2
  exit 1
fi

mkdir -p "$SKILLS_DIR"

echo "==> Installing skills declared in $MANIFEST"
while IFS=$'\t' read -r repo skill; do
  [ -n "$repo" ] || continue
  echo "  - $repo $skill"
  gh skill install "$repo" "$skill" --dir "$SKILLS_DIR" -f >/dev/null
done <<<"$MANIFEST_ENTRIES"

# Prune anything not declared. The skill name may carry an '@version' suffix in
# the manifest, so compare against the part before '@'.
echo "==> Pruning skills not in $MANIFEST"
DECLARED="$(while IFS=$'\t' read -r _ skill; do echo "${skill%%@*}"; done <<<"$MANIFEST_ENTRIES")"
PRUNED=0
for path in "$SKILLS_DIR"/*/; do
  [ -d "$path" ] || continue
  name="$(basename "$path")"
  if ! grep -qx "$name" <<<"$DECLARED"; then
    echo "  - removing $name"
    rm -rf "$path"
    PRUNED=$((PRUNED + 1))
  fi
done
[ "$PRUNED" -eq 0 ] && echo "  (nothing to prune)"

# Claude Code reads .claude/skills; keep it pointing at the shared directory so
# Claude Code and the .agents-based agents use one copy.
if [ ! -e ".claude/skills" ]; then
  echo "==> Recreating .claude/skills symlink"
  mkdir -p .claude
  ln -s "../.agents/skills" ".claude/skills"
fi

echo
echo "Done. Installed skills:"
gh skill list --scope project --json skillName,version,sourceURL \
  --jq 'unique_by(.skillName)[] | "  \(.skillName)\t\(.version)\t\(.sourceURL)"'
