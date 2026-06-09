#!/usr/bin/env bash
# release.sh — push commits and tag the current package.json version.
# Usage: ./release.sh [optional commit message]
#
# If there are staged/unstaged changes and a message is supplied, commits first.
# Then pushes, creates a version tag, and pushes the tag.

set -e

VERSION=$(node -p "require('./package.json').version")
TAG="$VERSION"

# Optional: commit any staged changes if a message was provided.
if [ -n "$1" ]; then
  git add -A
  git commit -m "$1"
fi

# Push commits.
git push

# Create and push the tag (skip if it already exists locally).
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag $TAG already exists locally — skipping tag creation."
else
  git tag "$TAG"
  echo "Created tag $TAG"
fi

git push origin "$TAG"
echo "Pushed tag $TAG → https://github.com/$(git remote get-url origin | sed 's/.*github.com[:/]\(.*\)\.git/\1/')/releases/tag/$TAG"
