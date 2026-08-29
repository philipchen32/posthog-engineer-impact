// Shared helper for calling `gh` with the broken GITHUB_TOKEN env var excluded, since a valid
// keyring login exists underneath it (verified during planning: `env -u GITHUB_TOKEN gh auth status`
// succeeds as philipchen32 with `repo` scope; the ambient GITHUB_TOKEN is invalid and would otherwise
// take precedence and break every call).
'use strict'

const { execFileSync } = require('child_process')

function cleanEnv() {
  const env = { ...process.env }
  delete env.GITHUB_TOKEN
  delete env.GH_TOKEN
  return env
}

function ghApi(args, opts = {}) {
  const out = execFileSync('gh', ['api', ...args], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: cleanEnv(),
    ...opts,
  })
  return out
}

function ghApiJson(args, opts = {}) {
  const out = ghApi(args, opts)
  return out.trim() ? JSON.parse(out) : null
}

function ghGraphql(query, fields = {}) {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(fields)) {
    args.push('-f', `${k}=${v}`)
  }
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 28, env: cleanEnv() })
  return JSON.parse(out)
}

function rateLimitRemaining() {
  const j = ghApiJson(['rate_limit'])
  return j.resources.core.remaining
}

module.exports = { ghApi, ghApiJson, ghGraphql, rateLimitRemaining, cleanEnv }
