# safe-to-merge

**Jev decides if your PR is safe to merge.** A GitHub Action and CLI that answers one question: can this merge right now?

[![CI](https://github.com/Hiccup-za/safe-to-merge/actions/workflows/ci.yml/badge.svg)](https://github.com/Hiccup-za/safe-to-merge/actions/workflows/ci.yml)

Built by [Durable Quality](https://durableqa.xyz) on [Jev](https://docs.typesafe.ai/) by TypeSafe AI. Not affiliated with TypeSafe AI.

**Code computes, Jev decides.** Hard facts (conflicts, failing checks, approvals) are enforced in code. The judgment calls (risk, test adequacy, whether a comment is blocking, whether CI is flaky) go to [TypeSafe Jev](https://docs.typesafe.ai/). Jev returns typed answers with probabilities, so a policy turns them into one verdict:

| Verdict | Meaning |
|---|---|
| 🟢 `safe` | All rules pass, Jev sees no concerns |
| 🟡 `needs_review` | Something a human should look at |
| 🔴 `block` | Fix before merging |

Jev can **raise** concerns. It can never turn a hard-rule block into a pass.

## What it looks at

| Source | Used for |
|---|---|
| PR metadata | draft, conflicts, behind base, labels, size |
| Diff (redacted, size-budgeted, riskiest files first) | Jev: verdict, risk, tests, breaking change, security, description match, mixed concerns |
| Related files | Finds existing tests for each changed source file (`foo.ts` → `foo.test.ts`, `test_foo.py`, `__tests__/…`) and flags source changed without its tests |
| Reviews | latest state per reviewer; changes requested blocks; approvals vs. ruleset minimum |
| Unresolved review threads | Jev: is this blocking? (one call per thread) |
| Conversation comments (humans, last 10) | Jev: is this a "don't merge yet"? |
| Check runs + commit statuses | failing / pending / missing-required; Jev classifies each failure as `caused_by_pr` / `flaky` / `infrastructure` / `unrelated` using its annotations |
| Branch rulesets | required checks + required approvals |
| Secrets in added lines | token formats block; `password = "…"` literals ask for review. Redacted before anything goes to Jev |

## Rules

| Condition | Result |
|---|---|
| Draft · merge conflict · changes requested · credential added | 🔴 |
| Failing check | 🔴, or 🟡 if Jev is ≥80% sure it's flaky/infra/unrelated |
| Unresolved thread, Jev P(blocking) ≥ 70% | 🔴 (🟡 if outdated) |
| Human comment, P(blocking) ≥ 70% | 🔴 |
| Jev verdict `block` ≥ 60% confident | 🔴 |
| Missing approvals · pending / missing required checks · behind base | 🟡 |
| Jev: `needs_review`, unsure `safe`, high risk, under-tested, breaking, security-sensitive | 🟡 |
| Jev unreachable | 🟡 rules-only |
| `safe-to-merge:override` label | 🟢, noted in the report |

All thresholds are configurable.

## Setup (GitHub Action)

1. Get a key at [console.typesafe.ai](https://console.typesafe.ai) → repo secret `TYPESAFE_API_KEY`.
2. Copy [`examples/safe-to-merge.yml`](examples/safe-to-merge.yml) to `.github/workflows/`. It uses `Hiccup-za/safe-to-merge@main` and runs on Bun.
3. Optional: make the `safe-to-merge` status required in branch rules.

It posts a sticky PR comment and a `safe-to-merge` commit status, and waits up to 10 min for other checks first. Re-runs on pushes, reviews, review comments, PR comments and label changes.

## CLI

Requires [Bun](https://bun.sh) 1.1+.

```bash
export GITHUB_TOKEN=… TYPESAFE_API_KEY=…
bun src/cli.js acme/shop#123                 # print report
bun src/cli.js https://github.com/acme/shop/pull/123 --json
bun src/cli.js acme/shop#123 --post comment,status --fail-on block --wait 300
```

Exit codes: `0` ok · `1` verdict hit `--fail-on` · `2` error.

## Config

`.github/safe-to-merge.json`, read from the **base** branch, so a PR can't relax its own gate. See `examples/safe-to-merge.json`.

| Key | Default |
|---|---|
| `model` | `jev-latest`. Pin e.g. `jev-1.13.0` once tuned |
| `minApprovals` | `1` (rulesets can raise it) |
| `ignoreChecks` | `["safe-to-merge", "Safe to merge?*"]` + yours (globs) |
| `overrideLabel` | `safe-to-merge:override` |
| `maxStateChars` | `24000` |
| `thresholds.*` | see `src/config.js` |

## Cost

Calls per run = 1 + unresolved threads (≤20) + human comments (≤10) + failing checks (≤8), all sent in parallel. At $0.042/M input tokens a typical run costs a fraction of a cent.

## Before trusting it

- **Calibrate.** Backtest on ~50 merged PRs you already have labels for (reverted? hotfixed?) and tune thresholds before making the status required.
- **Data.** Diffs and comments go to TypeSafe. Known token formats are redacted, but that's not a DLP system.
- **Forks.** `pull_request` from forks gets no secrets and a read-only token, so it reports to the step summary only.
- **Injection.** PR text, comments or CI output could try to talk Jev round. Hard rules don't read text. Worst case: Jev misses a concern, or a real failure gets softened to 🟡. Neither can produce a 🟢 past a hard rule.

## Website

The marketing site lives in [`site/`](site/): one static `index.html`, no build step.

```bash
bun run site   # http://localhost:3000
```

Deploy `site/` to any static host (GitHub Pages, Vercel, Netlify).

## Repo layout

```
src/        agent: gather → facts → Jev → policy → report
test/       33 tests with a fake GitHub + fake Jev
site/       marketing site
examples/   workflow + config to copy
action.yml  composite GitHub Action (runs on Bun)
```

## Dev

```bash
bun test    # 33 tests, fake GitHub + fake Jev, no network
```

Zero dependencies · Bun ≥ 1.1 · MIT
