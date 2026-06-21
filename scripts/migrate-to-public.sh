#!/usr/bin/env bash
# migrate-to-public.sh — Validate pre-flight and push main to the public GitHub repo.
#
# Usage:
#   scripts/migrate-to-public.sh          # run all checks then push
#   scripts/migrate-to-public.sh --check  # run checks only, no push
#
# All checks must pass before the push proceeds.

set -euo pipefail

PUBLIC_REMOTE_URL="https://github.com/newrelic-experimental/preflight"
REMOTE_NAME="public"
PASS="✓"
FAIL="✗"
WARN="!"
errors=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

check_pass() { printf "  %s  %s\n" "$PASS" "$1"; }
check_fail() { printf "  %s  %s\n" "$FAIL" "$1"; (( errors++ )) || true; }
check_warn() { printf "  %s  %s\n" "$WARN" "$1"; }

require_clean_branch() {
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [[ "$branch" == "main" ]]; then
    check_fail "Currently on main — run this from the cleanup branch (chore/prepare-for-public-release) to avoid pushing internal files from private main"
    return
  fi
  check_pass "On branch '$branch' (not private main)"

  if [[ -n "$(git status --porcelain)" ]]; then
    check_fail "Working tree is dirty — commit all changes before migrating"
  else
    check_pass "Working tree is clean"
  fi
}

check_excluded_files() {
  local missing=0
  for f in \
    "docs/IMPLEMENTATION.md" \
    "docs/PRODUCT_BRIEF.md" \
    "docs/RELEASE_AUDIT.md" \
    "docs/ROADMAP.md" \
    "docs/PUBLIC_RELEASE_PLAN.md" \
    "scripts/migrate-to-public.sh" \
    "scripts/sync-shared.ts" \
    "scripts/remove-staging.ts"
  do
    if [[ -f "$f" ]]; then
      check_fail "Internal file still present: $f (must be removed before pushing)"
      missing=1
    fi
  done
  if [[ "$missing" -eq 0 ]]; then
    check_pass "Internal files removed"
  fi
}

check_codeowners() {
  if [[ ! -f ".github/CODEOWNERS" ]]; then
    check_pass "CODEOWNERS absent (no required reviewers)"
    return
  fi
  if grep -q "@cdehaan" .github/CODEOWNERS; then
    check_fail "CODEOWNERS still contains '@cdehaan' — update or remove before pushing"
  else
    check_pass "CODEOWNERS does not reference @cdehaan"
  fi
}

check_nr_experimental_badge() {
  if grep -q "opensource-website.*Experimental" README.md 2>/dev/null; then
    check_pass "NR Experimental badge present in README"
  else
    check_fail "NR Experimental badge missing from README (required by OSPO)"
  fi
}

check_staging_internal_refs() {
  local matches
  matches=$(grep -rn "staging-one\.newrelic\.com\|NR-internal use\|internal staging" \
    --include="*.md" --include="*.ts" . 2>/dev/null \
    | grep -v ".git/" || true)
  if [[ -n "$matches" ]]; then
    check_fail "Internal staging references still present:"
    echo "$matches" | sed 's/^/      /'
  else
    check_pass "No internal staging references found"
  fi
}

check_internal_repo_refs() {
  local matches
  matches=$(grep -rn \
    "nr-ai-typescript-shared\|nr-ai-typescript-agent\|nr-ai-github-tools\|sync:shared\|sync-shared" \
    --include="*.md" --include="*.json" . 2>/dev/null \
    | grep -v ".git/\|package-lock" || true)
  if [[ -n "$matches" ]]; then
    check_fail "Internal repo references still present:"
    echo "$matches" | sed 's/^/      /'
  else
    check_pass "No internal repo references found"
  fi
}

check_history_for_secrets() {
  printf "  Scanning git history for secret patterns (this may take a moment)...\n"
  local found=0

  # NR key prefixes
  if git log -p --all -- . 2>/dev/null \
      | grep -qE 'NR[AIRLK]{2}-[A-Z0-9]{36,}'; then
    check_fail "Possible NR API/license key found in git history — run 'git log -p --all | grep -E NR' to inspect"
    found=1
  fi

  if [[ "$found" -eq 0 ]]; then
    check_pass "No obvious secrets found in git history"
    check_warn "Consider running trufflehog for a deeper scan: trufflehog git file://\$(pwd)"
  fi
}

check_package_json() {
  local repo_url
  repo_url=$(node -e "const p=require('./package.json'); console.log((p.repository||{}).url||'')" 2>/dev/null || true)
  if echo "$repo_url" | grep -q "newrelic-experimental/preflight"; then
    check_pass "package.json repository URL points to newrelic-experimental/preflight"
  else
    check_warn "package.json repository URL may need updating to newrelic-experimental/preflight (current: '$repo_url')"
  fi

  if node -e "const p=require('./package.json'); process.exit(p.scripts&&p.scripts['sync:shared']?1:0)" 2>/dev/null; then
    check_pass "package.json 'sync:shared' script removed"
  else
    check_fail "package.json still contains 'sync:shared' — remove it along with scripts/sync-shared.ts"
  fi
}

check_remote() {
  if git remote | grep -q "^${REMOTE_NAME}$"; then
    local url
    url=$(git remote get-url "$REMOTE_NAME")
    if [[ "$url" == "$PUBLIC_REMOTE_URL" ]]; then
      check_pass "Remote '$REMOTE_NAME' already set to $PUBLIC_REMOTE_URL"
    else
      check_fail "Remote '$REMOTE_NAME' exists but points to '$url', expected '$PUBLIC_REMOTE_URL'"
    fi
  else
    check_warn "Remote '$REMOTE_NAME' not configured — will add it before pushing"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

cd "$(git rev-parse --show-toplevel)"

echo ""
echo "Preflight → Public GitHub Migration"
echo "===================================="
echo ""
echo "Checks:"
echo ""

require_clean_branch
check_excluded_files
check_codeowners
check_nr_experimental_badge
check_staging_internal_refs
check_internal_repo_refs
check_package_json
check_history_for_secrets
check_remote

echo ""

if [[ "$errors" -gt 0 ]]; then
  echo "  $errors check(s) failed. Fix the issues above and re-run."
  echo ""
  exit 1
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo "  All checks passed. Run without --check to proceed with the push."
  echo ""
  exit 0
fi

echo "  All checks passed."
echo ""
echo "Pushing to $PUBLIC_REMOTE_URL ..."
echo ""

# Add the remote if it doesn't exist yet
if ! git remote | grep -q "^${REMOTE_NAME}$"; then
  git remote add "$REMOTE_NAME" "$PUBLIC_REMOTE_URL"
  echo "  Added remote '$REMOTE_NAME' → $PUBLIC_REMOTE_URL"
fi

branch=$(git rev-parse --abbrev-ref HEAD)
git push "$REMOTE_NAME" "${branch}:main"

# Push tags if any exist
if git tag | grep -q .; then
  git push "$REMOTE_NAME" --tags
  echo "  Tags pushed."
fi

echo ""
echo "Done. Verify at: https://github.com/newrelic-experimental/preflight"
echo ""
echo "Post-migration steps:"
echo "  1. cd /Users/cdehaan/Documents/development/newrelic-experimental/preflight && git pull"
echo "  2. Confirm excluded docs are absent: ls docs/"
echo "  3. Submit npm publish request to James Sumners (Node.js agent team)"
echo "  4. Submit to NR I/O Catalog via the I/O Ecosystem Runbook"
echo "  5. Register on Smithery: npx @smithery/cli publish (from repo root)"
echo ""
