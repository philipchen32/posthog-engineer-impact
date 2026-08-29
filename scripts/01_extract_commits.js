#!/usr/bin/env node
// Step 1 — Local git pull. No network. Single `git log` pass over the whole window.
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const cfg = require('../config')

const RECORD_SEP = '@@COMMIT@@'
const FIELD_SEP = '\x1f'

function isoStrict(d) {
  return d.toISOString()
}

function runGitLog() {
  const args = [
    '-C', cfg.REPO_PATH,
    'log', cfg.DEFAULT_BRANCH,
    `--since=${isoStrict(cfg.WINDOW_START)}`,
    `--until=${isoStrict(cfg.WINDOW_END)}`,
    '--no-merges',
    '--numstat',
    '--date=iso-strict',
    `--pretty=format:${RECORD_SEP}%H${FIELD_SEP}%ae${FIELD_SEP}%an${FIELD_SEP}%ad${FIELD_SEP}%s`,
  ]
  return execFileSync('git', args, { maxBuffer: 1 << 30, encoding: 'utf8' })
}

function looksLikeBotAuthor(name, email) {
  const n = (name || '').toLowerCase()
  const e = (email || '').toLowerCase()
  if (cfg.BOT_SUFFIX_RE.test(n)) return true
  for (const known of cfg.KNOWN_BOT_LOGINS) {
    if (n.includes(known) || e.includes(known)) return true
  }
  return false
}

function parseLog(raw) {
  const blocks = raw.split(RECORD_SEP).filter(Boolean)
  const commits = []
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = lines[0]
    const [sha, authorEmail, authorName, dateStr, ...subjectParts] = header.split(FIELD_SEP)
    const subject = subjectParts.join(FIELD_SEP) // subject could theoretically contain the sep; defensive join
    const date = new Date(dateStr)

    const files = []
    let totalAdded = 0
    let totalDeleted = 0
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line.trim()) continue
      const m = line.match(/^(-|\d+)\t(-|\d+)\t(.+)$/)
      if (!m) continue
      const added = m[1] === '-' ? 0 : parseInt(m[1], 10)
      const deleted = m[2] === '-' ? 0 : parseInt(m[2], 10)
      const filePath = m[3]
      files.push({ path: filePath, added, deleted })
      totalAdded += added
      totalDeleted += deleted
    }

    const prMatch = subject.match(cfg.PR_REF_RE)
    const prNumber = prMatch ? parseInt(prMatch[1], 10) : null
    const isChoreNoise = cfg.CHORE_NOISE_RE.test(subject)
    const isBot = looksLikeBotAuthor(authorName, authorEmail)

    commits.push({
      sha,
      prNumber,
      authorEmail,
      authorName,
      date: date.toISOString(),
      dateMs: date.getTime(),
      message: subject,
      files,
      totalAdded,
      totalDeleted,
      isChoreNoise,
      isBot,
      reworked: false, // filled in below
    })
  }
  return commits
}

// Reworked-commit check: for commits in the older half of the window, was any touched file
// touched again by a DIFFERENT author within 14 days after? Single pass, no O(n^2).
function computeReworked(commits) {
  const fileTouches = new Map() // path -> [{ author, dateMs }]
  for (const c of commits) {
    for (const f of c.files) {
      let arr = fileTouches.get(f.path)
      if (!arr) {
        arr = []
        fileTouches.set(f.path, arr)
      }
      arr.push({ author: c.authorEmail, dateMs: c.dateMs })
    }
  }
  for (const arr of fileTouches.values()) arr.sort((a, b) => a.dateMs - b.dateMs)

  const cutoffMs = cfg.OLDER_HALF_CUTOFF.getTime()
  const lookaheadMs = cfg.REWORK_LOOKAHEAD_DAYS * 86400_000
  let checked = 0
  let flagged = 0
  for (const c of commits) {
    if (c.dateMs > cutoffMs) continue // newer half: not enough elapsed time to judge, leave false
    checked++
    const upperBound = c.dateMs + lookaheadMs
    const wasReworked = c.files.some((f) => {
      const touches = fileTouches.get(f.path) || []
      return touches.some((t) => t.dateMs > c.dateMs && t.dateMs <= upperBound && t.author !== c.authorEmail)
    })
    if (wasReworked) {
      c.reworked = true
      flagged++
    }
  }
  return { checked, flagged }
}

function main() {
  console.log(`Extracting commits from ${cfg.REPO_PATH} (${cfg.DEFAULT_BRANCH})`)
  console.log(`Window: ${cfg.WINDOW_START.toISOString()} .. ${cfg.WINDOW_END.toISOString()}`)

  const raw = runGitLog()
  const commits = parseLog(raw)

  const total = commits.length
  const noiseCount = commits.filter((c) => c.isChoreNoise).length
  const botCount = commits.filter((c) => c.isBot).length
  const noPrCount = commits.filter((c) => c.prNumber === null).length

  const { checked, flagged } = computeReworked(commits)

  // Top 20 authors by commit count, excluding noise + bots (the population that matters for eligibility)
  const eligibleForCounting = commits.filter((c) => !c.isChoreNoise && !c.isBot)
  const byAuthor = new Map()
  for (const c of eligibleForCounting) {
    const key = c.authorEmail
    if (!byAuthor.has(key)) byAuthor.set(key, { authorEmail: key, authorName: c.authorName, count: 0 })
    byAuthor.get(key).count++
  }
  const top20 = [...byAuthor.values()].sort((a, b) => b.count - a.count).slice(0, 20)

  const outDir = path.resolve(__dirname, '..', 'data')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'commits.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        windowStart: cfg.WINDOW_START.toISOString(),
        windowEnd: cfg.WINDOW_END.toISOString(),
        commits,
      },
      null,
      2
    )
  )

  console.log('\n=== Step 1 report ===')
  console.log(`Total commits in window:         ${total}`)
  console.log(`Excluded as chore/noise:         ${noiseCount} (${((noiseCount / total) * 100).toFixed(1)}% — expect ~15%)`)
  console.log(`Excluded as bot-authored:        ${botCount}`)
  console.log(`Commits with no PR number:       ${noPrCount} (expect ~44, mostly chore(cli) release commits)`)
  console.log(`Rework check: ${checked} older-half commits checked, ${flagged} flagged reworked=true`)
  console.log(`\nTop 20 authors by commit count (excl. noise/bots):`)
  for (const a of top20) {
    console.log(`  ${String(a.count).padStart(4)}  ${a.authorName} <${a.authorEmail}>`)
  }
  console.log(`\nWrote ${path.join(outDir, 'commits.json')}`)
}

main()
