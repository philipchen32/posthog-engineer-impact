# PostHog Engineer Impact Dashboard — Report

## Approach

"Impact" here deliberately excludes commit count, PR count, and lines changed as primary
signals, since raw volume rewards busywork over judgment. Instead the dashboard scores three
things a skeptical eng leader actually cares about, weighted 50/30/20: **durability** (did shipped
code stick, in a part of the codebase that matters — line deltas weighted by a hand-assigned
directory-importance table, halved if the same file was reworked by a different author within 14
days), **review judgment** (a comment that was followed by a real commit on the PR, not a
rubber-stamp approval), and **review breadth** (harmonic mean of distinct people and distinct
codebase areas reviewed — a proxy for being a connective, load-bearing presence rather than just a
high-output IC). Every judgment call — the directory weights, the noise filter, the durability
formula, the generated-file exclusions — is stated in the dashboard's own methodology panel rather
than hidden inside a score.

What was cut for time: Step 2's GitHub API pull was scoped to the ~148 engineers who already
clear the local eligibility floor (3+ merged PRs) from Step 1's git history, rather than crawling
every one of the ~14,000 merged PRs in the 90-day window — the latter isn't tractable in this time
budget on a repo this size, and since only eligible engineers are ever scored, no scoring-relevant
review data was left out.

Two honest limitations worth flagging. First, rework detection only has a full 14-day
observation window for commits in the older half of the window, so recent work structurally looks
more "durable" than it may prove to be once more time passes. Second, and more materially: at this
repo's velocity (~150 commits/day across 220+ engineers), same-file re-touches within 14 days by a
different author are common even for entirely unrelated changes — measured directly at ~79% of
older-half commits. The mechanic itself is correct (spot-checked by hand against git history), but
it can't distinguish "your change was reworked" from "someone else happened to touch a shared
file," so the rework penalty is a directionally-useful but noisy signal, not a precise one.

## Data pipeline notes

- The local clone was a blobless partial clone (`--filter=blob:none`), so the initial `git log
  --numstat` pass was lazily fetching historical file content from GitHub one object at a time —
  effectively a full clone disguised as a log command. Fixed by walking the window once with
  `--raw --no-abbrev` (tree-only, no blob content needed) to enumerate the exact ~143K blob SHAs
  the window's diffs touch, then bulk-prefetching them in three batches via git's own
  `fetch --filter=blob:none --stdin` mechanism — turning thousands of incremental network
  round-trips into three. The window's actual `--numstat` extraction then ran in ~70 seconds.
- One data-quality fix applied mid-build: the durability formula's raw added/deleted line count
  was initially dominated by a single PR that regenerated `.test_durations` (a CI test-timing data
  file, ~200K lines of mechanical churn) — 6.7x larger than the next-biggest contribution. Added an
  explicit, inspectable exclusion list (lockfiles, anything path-matching "generated", confirmed
  auto-generated schema files, the test-durations file, and the snapshot-test manifest) so line
  counts reflect actual hand-written engineering work, not codegen/lockfile noise.
- The judgment formula was corrected during verification: it must require BOTH a comment AND a
  follow-up commit, not a follow-up commit alone (a follow-up commit with no comment could be
  unrelated work landing on the same PR after a content-free approval — exactly the rubber-stamp
  case the spec says shouldn't count).

## Top 5 (of 148 eligible engineers)

| Rank | Engineer | Total | Durability %ile | Judgment %ile | Breadth %ile |
|---|---|---|---|---|---|
| 1 | Tom Owers | 95.3 | 99.7 | 86.1 | 98.3 |
| 2 | Julian Bez | 95.2 | 98.3 | 88.2 | 97.6 |
| 3 | Georgiy Tarasov | 92.7 | 92.2 | 95.6 | 89.5 |
| 4 | Raúl Negrón-Otero | 90.8 | 85.5 | 94.3 | 99.0 |
| 5 | Matt Pua | 90.3 | 91.6 | 90.2 | 86.8 |

Full data, methodology, and directory weight table: `data/scores.json` (rendered by
`dashboard/index.html`).
