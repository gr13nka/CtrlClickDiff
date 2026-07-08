#!/usr/bin/env bash
# Reproducible Kotlin git fixture for CtrlClickDiff verification.
#
# Builds a throwaway git repo at $HOME/ccd-sample-repo with 3 commits that
# exercise cross-file symbol references (Main.kt -> Models.kt, Main.kt ->
# Utils.kt) and the full A/M/D status matrix:
#   commit 1 (root): A Models.kt, A Main.kt
#   commit 2:        A Utils.kt, A Legacy.kt, M Main.kt
#   commit 3:        M Models.kt, M Main.kt, D Legacy.kt
#
# Idempotent: wipes and recreates the repo on every run. Commit dates are
# pinned (with an explicit UTC offset) so the resulting commit SHAs are
# reproducible across machines/timezones, as long as author/committer
# identity and file contents below are not changed.

set -euo pipefail

REPO_DIR="${CCD_SAMPLE_REPO_DIR:-$HOME/ccd-sample-repo}"

rm -rf "$REPO_DIR"
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

git init -q -b main
git config user.name "CtrlClickDiff Fixture"
git config user.email "fixture@ctrlclickdiff.test"

export GIT_AUTHOR_NAME="CtrlClickDiff Fixture"
export GIT_AUTHOR_EMAIL="fixture@ctrlclickdiff.test"
export GIT_COMMITTER_NAME="CtrlClickDiff Fixture"
export GIT_COMMITTER_EMAIL="fixture@ctrlclickdiff.test"

# ---------------------------------------------------------------------------
# Commit 1 (root): Models.kt + Main.kt, cross-file Main.kt -> Models.kt
# ---------------------------------------------------------------------------
export GIT_AUTHOR_DATE="2024-01-01T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-01T00:00:00+00:00"

cat > Models.kt <<'EOF'
data class User(val name: String)

fun greeting(u: User): String {
    return "Hello, ${u.name}!"
}
EOF

cat > Main.kt <<'EOF'
fun main() {
    val u = User("Ada")
    println(greeting(u))
}
EOF

git add Models.kt Main.kt
git commit -q -m "Add Models.kt (User, greeting) and Main.kt"

# ---------------------------------------------------------------------------
# Commit 2: A Utils.kt, A Legacy.kt (throwaway), M Main.kt (calls shout())
# ---------------------------------------------------------------------------
export GIT_AUTHOR_DATE="2024-01-02T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-02T00:00:00+00:00"

cat > Utils.kt <<'EOF'
fun shout(s: String): String = s.uppercase()
EOF

cat > Legacy.kt <<'EOF'
// Throwaway file, deleted in commit 3.
fun legacyNoop() {
    // intentionally empty
}
EOF

cat > Main.kt <<'EOF'
fun main() {
    val u = User("Ada")
    println(greeting(u))
    println(shout(u.name))
}
EOF

git add Utils.kt Legacy.kt Main.kt
git commit -q -m "Add Utils.kt (shout) and Legacy.kt; wire shout() into Main.kt"

# ---------------------------------------------------------------------------
# Commit 3: M Models.kt (User.email, domainOf), M Main.kt (uses domainOf),
# D Legacy.kt
# ---------------------------------------------------------------------------
export GIT_AUTHOR_DATE="2024-01-03T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-03T00:00:00+00:00"

cat > Models.kt <<'EOF'
data class User(val name: String, val email: String)

fun greeting(u: User): String {
    return "Hello, ${u.name}!"
}

fun domainOf(u: User): String {
    return u.email.substringAfter("@")
}
EOF

cat > Main.kt <<'EOF'
fun main() {
    val u = User("Ada", "ada@example.com")
    println(greeting(u))
    println(shout(u.name))
    println(domainOf(u))
}
EOF

git rm -q Legacy.kt
git add Models.kt Main.kt
git commit -q -m "Add User.email/domainOf() to Models.kt, use in Main.kt; delete Legacy.kt"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
echo "Sample repo created at $REPO_DIR"
echo
echo "git log --oneline:"
git log --oneline
echo
for i in 2 3; do
  sha=$(git rev-parse "HEAD~$((3 - i))")
  echo "Commit $i ($sha) name-status:"
  git diff-tree --root --no-commit-id --name-status -r "$sha"
  echo
done
