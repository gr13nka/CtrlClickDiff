#!/usr/bin/env bash
# Reproducible Kotlin git fixtures for CtrlClickDiff verification.
#
# Builds two throwaway git repos so the repo picker has something to pick
# between and the branch selector has something to select.
#
# Repo A at $HOME/ccd-sample-repo:
#   main (3 commits) exercises cross-file symbol references (Main.kt ->
#   Models.kt, Main.kt -> Utils.kt) and the full A/M/D status matrix:
#     commit 1 (root): A Models.kt, A Main.kt
#     commit 2:        A Utils.kt, A Legacy.kt, M Main.kt
#     commit 3:        M Models.kt, M Main.kt, D Legacy.kt
#   feature/deep-paths (2 commits) exercises the file tree's single-child
#   directory-chain collapsing and cross-file peek at depth.
#   feature/wide (2 commits) exercises a broad change (12 .kt files across 5
#   directories) and, in LongService.kt, a 2-line change buried in a ~120-line
#   file so hideUnchangedRegions has something to collapse.
#
# Repo B at $HOME/ccd-sample-repo-2 (3 commits, 2 branches) is deliberately
# small and deliberately unlike repo A (package com.acme.inventory, different
# class names) so it is obvious at a glance which repo the UI has loaded. Its
# directory basename differs from repo A's because the backend derives the repo
# id slug from the basename.
#
# Idempotent: wipes and recreates both repos on every run. Commit dates are
# pinned (with an explicit UTC offset) so the resulting commit SHAs are
# reproducible across machines/timezones, as long as author/committer
# identity and file contents below are not changed.
#
# The 3 commits on repo A's main are load-bearing: their SHAs are quoted as
# reproducible elsewhere. Append new history after them; never edit them.

set -euo pipefail

REPO_DIR="${CCD_SAMPLE_REPO_DIR:-$HOME/ccd-sample-repo}"
REPO_DIR_2="${CCD_SAMPLE_REPO_DIR_2:-$HOME/ccd-sample-repo-2}"

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
# Branch feature/deep-paths, commit 1: Account.kt + Fmt.kt at deep package
# paths. src/main/kotlin/org/example is a chain of single-child directories,
# which is what the file tree is expected to collapse into one row.
# ---------------------------------------------------------------------------
git checkout -q -b feature/deep-paths main

export GIT_AUTHOR_DATE="2024-01-04T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-04T00:00:00+00:00"

mkdir -p src/main/kotlin/org/example/model src/main/kotlin/org/example/util

cat > src/main/kotlin/org/example/model/Account.kt <<'EOF'
package org.example.model

class Account(val id: Long, val owner: String) {
    var balanceCents: Long = 0
        private set

    fun deposit(cents: Long) {
        balanceCents += cents
    }
}
EOF

cat > src/main/kotlin/org/example/util/Fmt.kt <<'EOF'
package org.example.util

fun format(cents: Long): String {
    val units = cents / 100
    val fraction = (cents % 100).toString().padStart(2, '0')
    return "$units.$fraction"
}
EOF

git add src/main/kotlin/org/example/model/Account.kt src/main/kotlin/org/example/util/Fmt.kt
git commit -q -m "Add Account.kt and Fmt.kt under deep package paths"

# ---------------------------------------------------------------------------
# Branch feature/deep-paths, commit 2: A App.kt (peeks into BOTH Account.kt and
# Fmt.kt across deep paths), M Account.kt (withdraw() that App.kt calls)
# ---------------------------------------------------------------------------
export GIT_AUTHOR_DATE="2024-01-05T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-05T00:00:00+00:00"

cat > src/main/kotlin/org/example/model/Account.kt <<'EOF'
package org.example.model

class Account(val id: Long, val owner: String) {
    var balanceCents: Long = 0
        private set

    fun deposit(cents: Long) {
        balanceCents += cents
    }

    fun withdraw(cents: Long) {
        balanceCents -= cents
    }
}
EOF

cat > src/main/kotlin/org/example/App.kt <<'EOF'
package org.example

import org.example.model.Account
import org.example.util.format

fun main() {
    val account = Account(1, "Ada")
    account.deposit(12_345)
    account.withdraw(45)
    println("${account.owner}: ${format(account.balanceCents)}")
}
EOF

git add src/main/kotlin/org/example/App.kt src/main/kotlin/org/example/model/Account.kt
git commit -q -m "Add App.kt calling Account and format() across deep paths"

# ---------------------------------------------------------------------------
# Branch feature/wide, commit 1: seed 12 .kt files across 5 directories. One of
# them, core/LongService.kt, is ~120 lines on purpose — every other fixture
# file is 4-6 lines, which is under hideUnchangedRegions' minimum line count
# plus context, so nothing would ever collapse without it.
# ---------------------------------------------------------------------------
git checkout -q -b feature/wide main

export GIT_AUTHOR_DATE="2024-01-06T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-06T00:00:00+00:00"

WIDE_DIR="src/main/kotlin/org/example/wide"
mkdir -p "$WIDE_DIR/api" "$WIDE_DIR/core" "$WIDE_DIR/data" "$WIDE_DIR/ui" "$WIDE_DIR/util"

cat > "$WIDE_DIR/core/LongService.kt" <<'EOF'
package org.example.wide.core

// Order pipeline for the wide-change fixture. Deliberately long: collapsed
// unchanged regions only render when a file carries far more context than the
// hunk that changed inside it.

data class Order(
    val id: Long,
    val customer: String,
    val items: List<OrderLine>,
    val status: OrderStatus,
)

data class OrderLine(
    val sku: String,
    val quantity: Int,
    val unitPriceCents: Long,
)

enum class OrderStatus {
    DRAFT,
    SUBMITTED,
    PAID,
    PACKED,
    SHIPPED,
    DELIVERED,
    CANCELLED,
}

fun lineTotalCents(line: OrderLine): Long = line.quantity * line.unitPriceCents

fun subtotalCents(order: Order): Long = order.items.sumOf { lineTotalCents(it) }

fun itemCount(order: Order): Int = order.items.sumOf { it.quantity }

fun distinctSkus(order: Order): Int = order.items.map { it.sku }.distinct().size

fun hasItems(order: Order): Boolean = order.items.isNotEmpty()

fun heaviestLine(order: Order): OrderLine? = order.items.maxByOrNull { it.quantity }

fun cheapestLine(order: Order): OrderLine? = order.items.minByOrNull { it.unitPriceCents }

fun taxCents(order: Order, ratePerMille: Int): Long =
    subtotalCents(order) * ratePerMille / 1000

fun shippingCents(order: Order): Long =
    if (subtotalCents(order) >= 5_000) 0L else 499L

fun totalCents(order: Order, ratePerMille: Int): Long =
    subtotalCents(order) + taxCents(order, ratePerMille) + shippingCents(order)

fun describeStatus(status: OrderStatus): String = when (status) {
    OrderStatus.DRAFT -> "not submitted yet"
    OrderStatus.SUBMITTED -> "waiting for payment"
    OrderStatus.PAID -> "paid, awaiting fulfilment"
    OrderStatus.PACKED -> "packed in the warehouse"
    OrderStatus.SHIPPED -> "handed to the carrier"
    OrderStatus.DELIVERED -> "delivered to the customer"
    OrderStatus.CANCELLED -> "cancelled by the customer"
}

fun priorityScore(order: Order): Int {
    val base = itemCount(order) * 2
    return base + if (order.status == OrderStatus.PAID) 10 else 0
}

fun isTerminal(status: OrderStatus): Boolean = when (status) {
    OrderStatus.DELIVERED, OrderStatus.CANCELLED -> true
    else -> false
}

fun canCancel(status: OrderStatus): Boolean = when (status) {
    OrderStatus.DRAFT, OrderStatus.SUBMITTED, OrderStatus.PAID -> true
    OrderStatus.PACKED, OrderStatus.SHIPPED -> false
    OrderStatus.DELIVERED, OrderStatus.CANCELLED -> false
}

fun nextStatus(status: OrderStatus): OrderStatus = when (status) {
    OrderStatus.DRAFT -> OrderStatus.SUBMITTED
    OrderStatus.SUBMITTED -> OrderStatus.PAID
    OrderStatus.PAID -> OrderStatus.PACKED
    OrderStatus.PACKED -> OrderStatus.SHIPPED
    OrderStatus.SHIPPED -> OrderStatus.DELIVERED
    OrderStatus.DELIVERED -> OrderStatus.DELIVERED
    OrderStatus.CANCELLED -> OrderStatus.CANCELLED
}

fun formatCents(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    val abs = if (cents < 0) -cents else cents
    val fraction = (abs % 100).toString().padStart(2, '0')
    return "$sign${abs / 100}.$fraction"
}

fun receiptLine(line: OrderLine): String =
    "${line.sku} x${line.quantity} = ${formatCents(lineTotalCents(line))}"

fun receipt(order: Order, ratePerMille: Int): String {
    val body = order.items.joinToString("\n") { receiptLine(it) }
    val total = formatCents(totalCents(order, ratePerMille))
    return "$body\ntotal: $total"
}

fun validate(order: Order): List<String> {
    val problems = mutableListOf<String>()
    if (order.customer.isBlank()) problems += "customer is blank"
    if (order.items.isEmpty()) problems += "order has no lines"
    order.items.forEach { line ->
        if (line.quantity <= 0) problems += "${line.sku}: quantity must be positive"
        if (line.unitPriceCents < 0) problems += "${line.sku}: price must not be negative"
    }
    return problems
}

fun isValid(order: Order): Boolean = validate(order).isEmpty()

fun summarize(order: Order): String =
    "#${order.id} ${order.customer}: ${itemCount(order)} items, " +
        "${describeStatus(order.status)}, ${formatCents(subtotalCents(order))}"
EOF

cat > "$WIDE_DIR/util/Log.kt" <<'EOF'
package org.example.wide.util

fun log(msg: String) {
    println("[wide] $msg")
}
EOF

cat > "$WIDE_DIR/util/Ids.kt" <<'EOF'
package org.example.wide.util

fun nextId(seed: Long): Long {
    log("nextId from $seed")
    return seed + 1
}
EOF

cat > "$WIDE_DIR/api/Routes.kt" <<'EOF'
package org.example.wide.api

import org.example.wide.util.log

fun routeOf(path: String): String {
    log("routing $path")
    return path.trimEnd('/')
}
EOF

cat > "$WIDE_DIR/api/Handlers.kt" <<'EOF'
package org.example.wide.api

import org.example.wide.util.log

fun handle(request: String): String {
    log("handling $request")
    return "ok: ${routeOf(request)}"
}
EOF

cat > "$WIDE_DIR/api/Dto.kt" <<'EOF'
package org.example.wide.api

import org.example.wide.util.log

data class PageDto(val title: String, val body: String)

fun render(dto: PageDto): String {
    log("rendering ${dto.title}")
    return "${dto.title}\n${dto.body}"
}
EOF

cat > "$WIDE_DIR/core/Engine.kt" <<'EOF'
package org.example.wide.core

import org.example.wide.util.log

fun runOrder(order: Order, ratePerMille: Int): String {
    log("running order ${order.id}")
    return receipt(order, ratePerMille)
}
EOF

cat > "$WIDE_DIR/core/Policy.kt" <<'EOF'
package org.example.wide.core

import org.example.wide.util.log

fun allows(status: OrderStatus): Boolean {
    log("policy check for $status")
    return !isTerminal(status)
}
EOF

cat > "$WIDE_DIR/data/Repo.kt" <<'EOF'
package org.example.wide.data

import org.example.wide.util.log

class Repo(private val rows: MutableList<String> = mutableListOf()) {
    fun save(row: String) {
        log("saving $row")
        rows += row
    }

    fun all(): List<String> = rows.toList()
}
EOF

cat > "$WIDE_DIR/data/Cache.kt" <<'EOF'
package org.example.wide.data

import org.example.wide.util.log

class Cache(private val entries: MutableMap<String, String> = mutableMapOf()) {
    fun put(key: String, value: String) {
        log("caching $key")
        entries[key] = value
    }

    fun get(key: String): String? = entries[key]
}
EOF

cat > "$WIDE_DIR/ui/Screen.kt" <<'EOF'
package org.example.wide.ui

import org.example.wide.util.log

fun draw(title: String, lines: List<String>): String {
    log("drawing $title")
    return (listOf(title) + lines).joinToString("\n")
}
EOF

cat > "$WIDE_DIR/ui/Widget.kt" <<'EOF'
package org.example.wide.ui

import org.example.wide.util.log

fun badge(count: Int): String {
    log("badge for $count")
    return if (count > 99) "99+" else count.toString()
}
EOF

git add "$WIDE_DIR"
git commit -q -m "Add wide fixture package: 12 Kotlin files across 5 directories"

# ---------------------------------------------------------------------------
# Branch feature/wide, commit 2: the breadth commit — a package-wide log() ->
# trace() rename across 11 files, plus a 2-line tweak to priorityScore() in the
# middle of LongService.kt. That tweak is the whole point: ~60 untouched lines
# sit on either side of it, so hideUnchangedRegions has something to collapse.
#
# Edited with sed rather than a second heredoc so LongService.kt's ~120 lines
# live in exactly one place; duplicating them would mean editing both copies
# in lockstep forever.
# ---------------------------------------------------------------------------
export GIT_AUTHOR_DATE="2024-01-07T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-01-07T00:00:00+00:00"

sed -i \
  -e 's/\blog(/trace(/g' \
  -e 's/^import org\.example\.wide\.util\.log$/import org.example.wide.util.trace/' \
  "$WIDE_DIR/util/Log.kt" \
  "$WIDE_DIR/util/Ids.kt" \
  "$WIDE_DIR/api/Routes.kt" \
  "$WIDE_DIR/api/Handlers.kt" \
  "$WIDE_DIR/api/Dto.kt" \
  "$WIDE_DIR/core/Engine.kt" \
  "$WIDE_DIR/core/Policy.kt" \
  "$WIDE_DIR/data/Repo.kt" \
  "$WIDE_DIR/data/Cache.kt" \
  "$WIDE_DIR/ui/Screen.kt" \
  "$WIDE_DIR/ui/Widget.kt"

sed -i \
  -e 's/^    val base = itemCount(order) \* 2$/    val base = itemCount(order) * 3/' \
  -e 's/^    return base + if (order.status == OrderStatus.PAID) 10 else 0$/    return base + if (order.status == OrderStatus.PAID) 25 else 0/' \
  "$WIDE_DIR/core/LongService.kt"

git add "$WIDE_DIR"
git commit -q -m "Rename log() to trace() package-wide; reweight priorityScore()"

git checkout -q main

# ---------------------------------------------------------------------------
# Repo B: a second, obviously different repo so the picker has a real choice.
# Different basename (the backend slugs the repo id from it), different
# package, different class names.
# ---------------------------------------------------------------------------
rm -rf "$REPO_DIR_2"
mkdir -p "$REPO_DIR_2"
cd "$REPO_DIR_2"

git init -q -b main
git config user.name "CtrlClickDiff Fixture"
git config user.email "fixture@ctrlclickdiff.test"

INV_DIR="src/main/kotlin/com/acme/inventory"
mkdir -p "$INV_DIR"

# Commit 1 (root): A Sku.kt, A Warehouse.kt
export GIT_AUTHOR_DATE="2024-02-01T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-02-01T00:00:00+00:00"

cat > "$INV_DIR/Sku.kt" <<'EOF'
package com.acme.inventory

data class Sku(val code: String, val description: String)

fun label(sku: Sku): String = "${sku.code} - ${sku.description}"
EOF

cat > "$INV_DIR/Warehouse.kt" <<'EOF'
package com.acme.inventory

class Warehouse(val name: String) {
    private val stock = mutableMapOf<Sku, Int>()

    fun receive(sku: Sku, units: Int) {
        stock[sku] = (stock[sku] ?: 0) + units
    }

    fun onHand(sku: Sku): Int = stock[sku] ?: 0
}
EOF

git add "$INV_DIR"
git commit -q -m "Add Sku.kt and Warehouse.kt"

# Commit 2: A Restock.kt (uses Warehouse + label), M Warehouse.kt (skus())
export GIT_AUTHOR_DATE="2024-02-02T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-02-02T00:00:00+00:00"

cat > "$INV_DIR/Warehouse.kt" <<'EOF'
package com.acme.inventory

class Warehouse(val name: String) {
    private val stock = mutableMapOf<Sku, Int>()

    fun receive(sku: Sku, units: Int) {
        stock[sku] = (stock[sku] ?: 0) + units
    }

    fun onHand(sku: Sku): Int = stock[sku] ?: 0

    fun skus(): List<Sku> = stock.keys.toList()
}
EOF

cat > "$INV_DIR/Restock.kt" <<'EOF'
package com.acme.inventory

const val REORDER_POINT = 10

fun needsRestock(warehouse: Warehouse, sku: Sku): Boolean =
    warehouse.onHand(sku) < REORDER_POINT

fun restockPlan(warehouse: Warehouse): List<String> =
    warehouse.skus().filter { needsRestock(warehouse, it) }.map { label(it) }
EOF

git add "$INV_DIR"
git commit -q -m "Add Restock.kt; expose Warehouse.skus()"

# Branch feature/reporting, commit 1: A Report.kt
git checkout -q -b feature/reporting main

export GIT_AUTHOR_DATE="2024-02-03T00:00:00+00:00"
export GIT_COMMITTER_DATE="2024-02-03T00:00:00+00:00"

cat > "$INV_DIR/Report.kt" <<'EOF'
package com.acme.inventory

fun report(warehouse: Warehouse): String {
    val header = "Inventory report for ${warehouse.name}"
    val body = warehouse.skus().joinToString("\n") {
        "${label(it)}: ${warehouse.onHand(it)}"
    }
    return "$header\n$body"
}
EOF

git add "$INV_DIR"
git commit -q -m "Add Report.kt rendering on-hand counts per SKU"

git checkout -q main

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
echo "Sample repo A created at $REPO_DIR"
echo "Sample repo B created at $REPO_DIR_2"
echo
echo "=== Repo A: $REPO_DIR ==="
echo
echo "git branch:"
git -C "$REPO_DIR" branch
echo
echo "git log --oneline --graph --all --decorate:"
git -C "$REPO_DIR" log --oneline --graph --all --decorate
echo
for i in 2 3; do
  sha=$(git -C "$REPO_DIR" rev-parse "main~$((3 - i))")
  echo "Commit $i ($sha) name-status:"
  git -C "$REPO_DIR" diff-tree --root --no-commit-id --name-status -r "$sha"
  echo
done
for branch in feature/deep-paths feature/wide; do
  echo "$branch tip ($(git -C "$REPO_DIR" rev-parse "$branch")) name-status:"
  git -C "$REPO_DIR" diff-tree --no-commit-id --name-status -r "$branch"
  echo
done
echo "feature/wide tip diffstat (small hunk inside a long file):"
git -C "$REPO_DIR" diff-tree --no-commit-id --stat -r feature/wide
echo
echo "=== Repo B: $REPO_DIR_2 ==="
echo
echo "git branch:"
git -C "$REPO_DIR_2" branch
echo
echo "git log --oneline --graph --all --decorate:"
git -C "$REPO_DIR_2" log --oneline --graph --all --decorate
echo
