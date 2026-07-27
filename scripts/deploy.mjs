#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const envPath = resolve(root, '.env')

function fail(message) {
  console.error(`\n✖ ${message}\n`)
  process.exit(1)
}

function loadEnvFile(path) {
  if (!existsSync(path)) {
    fail(`Missing ${path}. Copy .env.example to .env and fill in your AWS credentials.`)
  }

  const text = readFileSync(path, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env) || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

function requireEnv(keys) {
  const missing = keys.filter((key) => !process.env[key]?.trim())
  if (missing.length) {
    fail(`Missing required env vars in .env: ${missing.join(', ')}`)
  }
}

function run(command, args, options = {}) {
  console.log(`\n› ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

loadEnvFile(envPath)
requireEnv(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_ACCOUNT_ID'])

process.env.CDK_DEFAULT_ACCOUNT = process.env.AWS_ACCOUNT_ID
process.env.CDK_DEFAULT_REGION = process.env.AWS_REGION
process.env.AWS_DEFAULT_REGION = process.env.AWS_REGION

const env = { ...process.env }
const infraDir = resolve(root, 'infra')

run('npm', ['run', 'build'], { cwd: root, env })

if (!existsSync(resolve(infraDir, 'node_modules'))) {
  run('npm', ['install'], { cwd: infraDir, env })
}

const cdkBin = resolve(infraDir, 'node_modules/.bin/cdk')

run(cdkBin, ['bootstrap', `aws://${process.env.AWS_ACCOUNT_ID}/${process.env.AWS_REGION}`], {
  cwd: infraDir,
  env,
})

const outputsPath = resolve(root, 'cdk-outputs.json')

run(cdkBin, ['deploy', '--require-approval', 'never', '--outputs-file', outputsPath], {
  cwd: infraDir,
  env,
})

if (existsSync(outputsPath)) {
  try {
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf8'))
    const siteUrl = outputs?.KairoHostingStack?.SiteUrl
    if (siteUrl) {
      console.log(`\n✔ Deploy finished.\n  Site URL: ${siteUrl}\n`)
      process.exit(0)
    }
  } catch {
    // fall through
  }
}

console.log('\n✔ Deploy finished. Look for SiteUrl in the stack outputs above.\n')
