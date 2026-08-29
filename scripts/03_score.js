#!/usr/bin/env node
// Step 3 — Score. Joins commits.json and prs.json, computes the three pillars, percentile-ranks
// each within the eligible pool, and combines per the approved weights (durability 50 / judgment
// 30 / breadth 20). All formulas are deliberately simple — see the methodology block emitted into
// scores.json, which the dashboard renders verbatim so every judgment call stays inspectable.
'use strict'

const fs = require('fs')
const path = require('path')
const cfg = require('../config')

const DATA_DIR = path.resolve(__dirname, '..', 'data')

function percentileRank(values, v) {
  if (values.length === 0) return 0
  let countBelow = 0
  let countEqual = 0
  for (const x of values) {
    if (x < v) countBelow++
    else if (x === v) countEqual++
  }
  return (100 * (countBelow + 0.5 * countEqual)) / values.length
}

function prUrl(number) {
  return `https://github.com/${cfg.REPO_OWNER}/${cfg.REPO_NAME}/pull/${number}`
}

function main() {
  const commitsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'commits.json'), 'utf8'))
  const prsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'prs.json'), 'utf8'))
  const commits = commitsData.commits
  const reviews = prsData.reviews

  // Eligible pool: candidates from Step 2 (>=3 eligible PRs), minus anyone flagged as a bot by login.
  const eligible = prsData.candidates.filter((c) => !c.flaggedAsBot)
  console.log(`Eligible pool: ${eligible.length} (of ${prsData.candidates.length} candidates, ${prsData.candidates.length - eligible.length} excluded as bots)`)

  const scorableCommits = commits.filter((c) => !c.isChoreNoise && !c.isBot && c.prNumber !== null)
  const commitsByAuthor = new Map()
  for (const c of scorableCommits) {
    if (!commitsByAuthor.has(c.authorEmail)) commitsByAuthor.set(c.authorEmail, [])
    commitsByAuthor.get(c.authorEmail).push(c)
  }

  const reviewsByReviewer = new Map()
  for (const r of reviews) {
    if (!reviewsByReviewer.has(r.reviewerEmail)) reviewsByReviewer.set(r.reviewerEmail, [])
    reviewsByReviewer.get(r.reviewerEmail).push(r)
  }

  function prDurability(c) {
    // Exclude generated/data-artifact files from the line count — a lockfile bump or codegen run
    // isn't engineering signal, and can otherwise dominate the raw added/deleted numbers (see
    // config.isGeneratedOrDataFile for the explicit, inspectable list).
    const countedFiles = c.files.filter((f) => !cfg.isGeneratedOrDataFile(f.path))
    if (countedFiles.length === 0) return 0
    const added = countedFiles.reduce((s, f) => s + f.added, 0)
    const deleted = countedFiles.reduce((s, f) => s + f.deleted, 0)
    const dirWeight = Math.max(...countedFiles.map((f) => cfg.directoryWeight(f.path)))
    let val = (added - 0.3 * deleted) * dirWeight
    if (c.reworked) val *= 0.5
    return Math.max(0, val)
  }

  const engineers = []
  for (const cand of eligible) {
    const myCommits = commitsByAuthor.get(cand.authorEmail) || []
    const perPr = myCommits.map((c) => ({ prNumber: c.prNumber, durability: prDurability(c), sha: c.sha }))
    const durabilityRaw = perPr.reduce((sum, p) => sum + p.durability, 0)

    const myReviews = reviewsByReviewer.get(cand.authorEmail) || []
    // Judgment requires BOTH a comment and a follow-up commit — a follow-up commit alone could be
    // unrelated work landing on the PR after a content-free rubber-stamp approval, which the spec
    // explicitly says shouldn't count ("a comment that caused a real change, not a rubber-stamp approval").
    const judgmentRaw = myReviews.filter((r) => r.hadComment && r.hadFollowupCommit).length

    const distinctAuthors = new Set(myReviews.map((r) => r.prAuthorEmail).filter(Boolean)).size
    const distinctDirs = new Set(myReviews.flatMap((r) => r.prTopDirs)).size
    const breadthRaw =
      distinctAuthors === 0 || distinctDirs === 0 ? 0 : (2 * distinctAuthors * distinctDirs) / (distinctAuthors + distinctDirs)

    const topPRs = perPr
      .sort((a, b) => b.durability - a.durability)
      .slice(0, 3)
      .map((p) => ({ number: p.prNumber, url: prUrl(p.prNumber), durabilityContribution: Math.round(p.durability * 100) / 100 }))

    engineers.push({
      login: cand.login,
      authorEmail: cand.authorEmail,
      name: cand.authorName,
      prCount: cand.prCount,
      durabilityRaw,
      judgmentRaw,
      breadthRaw,
      distinctAuthorsReviewed: distinctAuthors,
      distinctDirsReviewed: distinctDirs,
      reviewsGiven: myReviews.length,
      topPRs,
    })
  }

  const durabilityValues = engineers.map((e) => e.durabilityRaw)
  const judgmentValues = engineers.map((e) => e.judgmentRaw)
  const breadthValues = engineers.map((e) => e.breadthRaw)

  for (const e of engineers) {
    const durPct = percentileRank(durabilityValues, e.durabilityRaw)
    const judPct = percentileRank(judgmentValues, e.judgmentRaw)
    const brePct = percentileRank(breadthValues, e.breadthRaw)

    e.pillars = {
      durability: { raw: Math.round(e.durabilityRaw * 100) / 100, percentile: Math.round(durPct * 10) / 10, weightedContribution: Math.round(cfg.WEIGHTS.durability * durPct * 10) / 10 },
      judgment: { raw: e.judgmentRaw, percentile: Math.round(judPct * 10) / 10, weightedContribution: Math.round(cfg.WEIGHTS.judgment * judPct * 10) / 10 },
      breadth: { raw: Math.round(e.breadthRaw * 100) / 100, percentile: Math.round(brePct * 10) / 10, weightedContribution: Math.round(cfg.WEIGHTS.breadth * brePct * 10) / 10 },
    }
    e.total = Math.round((e.pillars.durability.weightedContribution + e.pillars.judgment.weightedContribution + e.pillars.breadth.weightedContribution) * 10) / 10

    // clean up scratch fields not part of the public schema
    delete e.durabilityRaw
    delete e.judgmentRaw
    delete e.breadthRaw
  }

  engineers.sort((a, b) => b.total - a.total)

  const top15 = engineers.slice(0, 15)

  const output = {
    generatedAt: new Date().toISOString(),
    windowStart: cfg.WINDOW_START.toISOString(),
    windowEnd: cfg.WINDOW_END.toISOString(),
    methodology: {
      concept:
        'Impact is not volume. Commit count, PR count, and lines changed are excluded as primary signals because they reward busywork over judgment. We score three things a skeptical eng leader actually cares about: durability (did shipped code stick, in a part of the codebase that matters), review judgment (did reviews change outcomes, not just rubber-stamp), and review breadth (connective presence across people and codebase areas).',
      weights: { durability: 50, judgment: 30, breadth: 20 },
      eligibilityFloor: cfg.ELIGIBILITY_FLOOR_PRS,
      noiseFilter: 'commit subject matches conventional-commit chore type: /^chore(\\(...\\))?:/ — measured at ~14.6% of commits in this repo, consistent with prior observation',
      durabilityFormula: "per PR: max(0, (added_lines - 0.3*deleted_lines) * directoryWeight), halved if the same file was touched again by a different author within 14 days (reworked); generated/data-artifact files (lockfiles, codegen output, test-snapshot manifests — see the generated-file list) are excluded from the line count first, since a codegen run isn't engineering signal. Summed across an author's eligible PRs.",
      judgmentFormula: "count of reviews given that included a comment AND were followed by a commit on the PR after the review and before merge — a comment that caused a real change, not a rubber-stamp approval (a follow-up commit with no comment doesn't count; nor does a comment with no follow-up).",
      breadthFormula: 'harmonic mean of (distinct PR authors reviewed, distinct top-level directories reviewed); 0 if the engineer gave no reviews.',
      directoryWeights: { ...cfg.DIRECTORY_WEIGHTS, _default: cfg.DEFAULT_DIRECTORY_WEIGHT },
      generatedFileExclusions: [...cfg.GENERATED_EXACT_PATHS, 'any path containing "generated" (case-insensitive)'],
      limitations: [
        'Directory weights are hand-assigned from a short look at repo structure, not computed — a judgment call, stated here for inspection rather than hidden in the score.',
        'Rework detection only has a full 14-day observation window for commits in the older half of the 90-day window; newer commits default to reworked=false and so look more "durable" than they may prove to be once more time passes.',
        "At this repo's commit velocity (~150 commits/day across 220+ engineers), same-file re-touches within 14 days by a different author are common even for unrelated changes — measured at ~79% of older-half commits. The heuristic is directionally right (verified by hand against git history) but has real false-positive risk: it can't distinguish \"your change was reworked\" from \"someone else happened to touch the same file.\"",
        'The GitHub API pull was scoped to engineers who already clear the local eligibility floor, not a full crawl of every merged PR in the window, to stay tractable — review data for eligible engineers is complete, but no attempt was made to discover review activity outside that candidate set.',
        "About 10% of fetched reviews target a PR not found in the local 90-day commit window (merged outside the window, or otherwise not resolved) — those reviews still count toward judgment (which only needs the PR's own commit timestamps) but contribute nothing to review-breadth's author/directory counts.",
      ],
      eligiblePoolSize: eligible.length,
    },
    engineers: top15,
  }

  fs.writeFileSync(path.join(DATA_DIR, 'scores.json'), JSON.stringify(output, null, 2))

  console.log('\n=== Step 3 report ===')
  console.log(`Eligible pool: ${eligible.length}`)
  console.log('Top 5:')
  for (const e of top15.slice(0, 5)) {
    console.log(`  ${e.total.toFixed(1)}  ${e.name} (${e.login || e.authorEmail})  [dur ${e.pillars.durability.percentile} / jud ${e.pillars.judgment.percentile} / bre ${e.pillars.breadth.percentile}]`)
  }
  console.log(`\nWrote ${path.join(DATA_DIR, 'scores.json')}`)
}

main()
