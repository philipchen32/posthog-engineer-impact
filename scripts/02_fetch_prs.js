#!/usr/bin/env node
// Step 2 — GitHub API pull. The ONLY network step. Candidate-scoped per the approved plan:
// eligibility is computed entirely from local Step 1 data first, so we only ever fetch
// review/PR activity involving engineers who already clear the eligibility floor — bounded by
// candidate count (dozens), not by the ~14,200 merged PRs in the window.
//
// Simplification vs. the original design sketch: Step 1's git log already captured full
// file-level numstat for EVERY commit in the window (not just candidates'), so when we need to
// know what a *reviewed* PR touched (for review-breadth's directory count) or who authored it,
// we join locally against commits.json by PR number instead of re-fetching it from the API.
// This cuts the API surface down to exactly one thing the local git history cannot tell us:
// who reviewed what, and whether a follow-up commit landed after the review.
'use strict'

const fs = require('fs')
const path = require('path')
const cfg = require('../config')
const { ghApi, ghApiJson, ghGraphql, rateLimitRemaining } = require('./lib/gh')

const DATA_DIR = path.resolve(__dirname, '..', 'data')
const RAW_DIR = path.join(DATA_DIR, 'raw')
fs.mkdirSync(RAW_DIR, { recursive: true })

function cacheKey(name) {
  return path.join(RAW_DIR, name.replace(/[^a-zA-Z0-9_.-]/g, '_'))
}

function readCache(name) {
  const p = cacheKey(name)
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  return null
}

function writeCache(name, data) {
  fs.writeFileSync(cacheKey(name), JSON.stringify(data, null, 2))
}

function maybeThrottle() {
  const remaining = rateLimitRemaining()
  if (remaining < 50) {
    console.log(`  rate limit low (${remaining} remaining) — sleeping 60s`)
    const { execFileSync } = require('child_process')
    execFileSync('sleep', ['60'])
  }
}

const REVIEW_CONTRIBUTIONS_QUERY = `
query($login: String!, $from: DateTime!, $to: DateTime!, $cursor: String) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      pullRequestReviewContributions(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          pullRequest {
            number
            merged
            mergedAt
            repository { nameWithOwner }
            commits(last: 20) { nodes { commit { committedDate } } }
          }
          pullRequestReview {
            state
            submittedAt
            body
            comments(first: 1) { totalCount }
          }
        }
      }
    }
  }
}`

const CACHE_ONLY = process.env.CACHE_ONLY === '1'
const CANDIDATE_CAP = process.env.CANDIDATE_CAP ? parseInt(process.env.CANDIDATE_CAP, 10) : null

function fetchReviewsForCandidate(login) {
  const cached = readCache(`reviews-${login}.json`)
  if (cached) return cached
  if (CACHE_ONLY) {
    console.log(`  [cache-only] no cached reviews for ${login} — skipping (time-boxed run)`)
    return []
  }

  const all = []
  let cursor = null
  let page = 0
  for (;;) {
    page++
    maybeThrottle()
    const fields = {
      login,
      from: cfg.WINDOW_START.toISOString(),
      to: cfg.WINDOW_END.toISOString(),
    }
    if (cursor) fields.cursor = cursor
    const resp = ghGraphql(REVIEW_CONTRIBUTIONS_QUERY, fields)
    const conn = resp?.data?.user?.contributionsCollection?.pullRequestReviewContributions
    if (!conn) break
    all.push(...conn.nodes)
    if (!conn.pageInfo.hasNextPage || page > 20) break // 20-page safety cap (1000 reviews/candidate)
    cursor = conn.pageInfo.endCursor
  }
  writeCache(`reviews-${login}.json`, all)
  return all
}

function loginForCandidate(email, sampleSha) {
  const cacheName = `login-${email}.json`
  const cached = readCache(cacheName)
  if (cached) return cached.login

  let login = null
  try {
    const commit = ghApiJson([`repos/${cfg.REPO_OWNER}/${cfg.REPO_NAME}/commits/${sampleSha}`])
    login = commit?.author?.login ?? null
  } catch (e) {
    login = null
  }
  writeCache(cacheName, { email, sampleSha, login })
  return login
}

function shaCrossCheck(candidatePrNumbers, localCommitsByPr) {
  // Sanity check only — sample up to 3 PRs per candidate to confirm merge_commit_sha matches
  // the local commit SHA the PR number was extracted from. Not required for scoring.
  const results = []
  for (const num of candidatePrNumbers) {
    try {
      const pr = ghApiJson([`repos/${cfg.REPO_OWNER}/${cfg.REPO_NAME}/pulls/${num}`])
      const local = localCommitsByPr.get(num)
      const match = local && pr && pr.merge_commit_sha === local.sha
      results.push({ prNumber: num, apiSha: pr?.merge_commit_sha, localSha: local?.sha, match: !!match })
    } catch (e) {
      results.push({ prNumber: num, error: String(e.message || e) })
    }
  }
  return results
}

function main() {
  const commitsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'commits.json'), 'utf8'))
  const commits = commitsData.commits

  const localCommitsByPr = new Map()
  for (const c of commits) {
    if (c.prNumber !== null) localCommitsByPr.set(c.prNumber, c)
  }

  // Candidate list: authors with >=3 eligible (non-noise, non-bot, PR-linked) commits.
  const eligibleCommits = commits.filter((c) => !c.isChoreNoise && !c.isBot && c.prNumber !== null)
  const byAuthor = new Map()
  for (const c of eligibleCommits) {
    if (!byAuthor.has(c.authorEmail)) {
      byAuthor.set(c.authorEmail, { authorEmail: c.authorEmail, authorName: c.authorName, prNumbers: [], sampleSha: c.sha })
    }
    byAuthor.get(c.authorEmail).prNumbers.push(c.prNumber)
  }
  let candidates = [...byAuthor.values()].filter((a) => a.prNumbers.length >= cfg.ELIGIBILITY_FLOOR_PRS)

  console.log(`Candidates clearing the ${cfg.ELIGIBILITY_FLOOR_PRS}+ PR eligibility floor: ${candidates.length}`)

  if (CANDIDATE_CAP) {
    candidates = candidates.sort((a, b) => b.prNumbers.length - a.prNumbers.length).slice(0, CANDIDATE_CAP)
    console.log(`CANDIDATE_CAP=${CANDIDATE_CAP} set — capped to top ${candidates.length} by non-noise commit count (time-boxed run)`)
  }
  console.log(`Checking gh auth / rate limit...`)
  const startRemaining = rateLimitRemaining()
  console.log(`Rate limit remaining: ${startRemaining}`)

  // Map email -> login
  let loginFailures = 0
  for (const cand of candidates) {
    cand.login = loginForCandidate(cand.authorEmail, cand.sampleSha)
    if (!cand.login) loginFailures++
    else if (cfg.isBotLogin(cand.login)) {
      console.log(`  NOTE: ${cand.authorEmail} resolved to login "${cand.login}" which matches the bot pattern — flagging, excluding from review fetch`)
      cand.login = null
      cand.flaggedAsBot = true
    }
  }

  const resolvedCandidates = candidates.filter((c) => c.login)
  console.log(`Resolved GitHub logins: ${resolvedCandidates.length} (${loginFailures} lookup failures)`)

  // Fetch reviews given by each resolved candidate
  const reviews = []
  let reviewsWithComment = 0
  let reviewsWithFollowup = 0
  let gapCount = 0 // reviewed PR not found in local commits.json (not merged in-window, or non-standard merge)

  for (const cand of resolvedCandidates) {
    console.log(`  fetching reviews given by ${cand.login} (${cand.authorEmail})...`)
    const nodes = fetchReviewsForCandidate(cand.login)
    for (const node of nodes) {
      const pr = node.pullRequest
      const review = node.pullRequestReview
      if (!pr || !review) continue
      if (pr.repository?.nameWithOwner !== `${cfg.REPO_OWNER}/${cfg.REPO_NAME}`) continue

      const hadComment = (review.body && review.body.trim().length > 0) || (review.comments?.totalCount ?? 0) > 0

      let hadFollowupCommit = false
      if (review.submittedAt && pr.commits?.nodes?.length) {
        const submittedMs = new Date(review.submittedAt).getTime()
        const mergedMs = pr.mergedAt ? new Date(pr.mergedAt).getTime() : Infinity
        hadFollowupCommit = pr.commits.nodes.some((n) => {
          const cMs = new Date(n.commit.committedDate).getTime()
          return cMs > submittedMs && cMs <= mergedMs
        })
      }

      const localCommit = localCommitsByPr.get(pr.number)
      let prAuthorEmail = null
      let prTopDirs = []
      if (localCommit) {
        prAuthorEmail = localCommit.authorEmail
        prTopDirs = [...new Set(localCommit.files.map((f) => cfg.topLevelDir(f.path)))]
      } else {
        gapCount++
      }

      if (hadComment) reviewsWithComment++
      if (hadFollowupCommit) reviewsWithFollowup++

      reviews.push({
        reviewerLogin: cand.login,
        reviewerEmail: cand.authorEmail,
        prNumber: pr.number,
        prAuthorEmail,
        prTopDirs,
        submittedAt: review.submittedAt,
        state: review.state,
        hadComment,
        hadFollowupCommit,
      })
    }
  }

  // Sanity cross-check: sample up to 3 authored PRs per candidate
  const shaChecks = []
  for (const cand of resolvedCandidates) {
    const sample = cand.prNumbers.slice(0, 3)
    shaChecks.push(...shaCrossCheck(sample, localCommitsByPr))
  }
  const shaMismatches = shaChecks.filter((r) => r.error || r.match === false)

  const distinctReviewers = new Set(reviews.map((r) => r.reviewerLogin)).size

  const output = {
    generatedAt: new Date().toISOString(),
    windowStart: cfg.WINDOW_START.toISOString(),
    windowEnd: cfg.WINDOW_END.toISOString(),
    timeBoxed: !!(CANDIDATE_CAP || CACHE_ONLY),
    candidateCount: candidates.length,
    resolvedLoginCount: resolvedCandidates.length,
    loginFailures,
    candidates: candidates.map((c) => ({
      authorEmail: c.authorEmail,
      authorName: c.authorName,
      login: c.login,
      flaggedAsBot: !!c.flaggedAsBot,
      prCount: c.prNumbers.length,
    })),
    reviews,
    shaCrossCheck: shaChecks,
  }

  fs.writeFileSync(path.join(DATA_DIR, 'prs.json'), JSON.stringify(output, null, 2))

  console.log('\n=== Step 2 report ===')
  console.log(`Candidates (>=${cfg.ELIGIBILITY_FLOOR_PRS} eligible PRs): ${candidates.length}`)
  console.log(`Resolved GitHub logins: ${resolvedCandidates.length} (${loginFailures} failures)`)
  console.log(`Total reviews fetched (given by candidates, in-repo, in-window): ${reviews.length}`)
  console.log(`  with comment:          ${reviewsWithComment}`)
  console.log(`  with follow-up commit: ${reviewsWithFollowup}`)
  console.log(`Distinct reviewers (candidates who reviewed >=1 time): ${distinctReviewers}`)
  console.log(`Reviewed-PR local-join gaps (PR not in commits.json): ${gapCount}`)
  console.log(`SHA cross-check: ${shaChecks.length} sampled, ${shaMismatches.length} mismatches/errors`)
  if (shaMismatches.length) {
    console.log('  mismatches:', JSON.stringify(shaMismatches.slice(0, 5), null, 2))
  }
  console.log(`\nWrote ${path.join(DATA_DIR, 'prs.json')}`)
}

main()
