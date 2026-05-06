#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)

if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
  console.log(`wiki-gen-watch <target-repo> [options]

Watches a git repository and runs diff-aware documentation updates on new commits.

Options:
  --interval SECONDS       Poll interval (default: 30)
  --wiki-gen PATH          Path to wiki-gen CLI (default: this package)
  --deploy DEST            Optional rsync destination for built HTML
  --port PORT              OpenCode server port (default: 4096)
  --serve-port PORT        Local docs server port (default: 33411)
  --model PROVIDER/MODEL   OpenCode model override
  --verbose                Verbose wiki-gen output

Example:
  wiki-gen-watch ./my-repo --interval 60 --deploy user@host:/srv/docs/my-repo/
`)
  process.exit(0)
}

const targetRepo = path.resolve(args[0])
const rest = args.slice(1)

function option(name, fallback) {
  const idx = rest.indexOf(name)
  return idx >= 0 && idx + 1 < rest.length ? rest[idx + 1] : fallback
}

function has(name) {
  return rest.includes(name)
}

const interval = Number(option("--interval", "30"))
const deploy = option("--deploy", "")
const wikiGenOverride = option("--wiki-gen", "")

function git(gitArgs) {
  return execFileSync("git", gitArgs, { cwd: targetRepo, encoding: "utf-8" }).trim()
}

function gitSafe(gitArgs) {
  try { return git(gitArgs) } catch { return "" }
}

function wikiGenCommand() {
  if (wikiGenOverride) return { cmd: wikiGenOverride, args: [] }
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  return { cmd: process.execPath, args: [path.resolve(__dirname, "wiki-gen.js")] }
}

function forwardedFlags() {
  const skipWithValue = new Set(["--interval", "--wiki-gen", "--deploy"])
  const out = []
  for (let i = 0; i < rest.length; i++) {
    const item = rest[i]
    if (skipWithValue.has(item)) { i++; continue }
    out.push(item)
  }
  if (deploy) out.push("--deploy", deploy)
  if (!out.includes("--format")) out.push("--format", "sphinx")
  if (!out.includes("--build-site")) out.push("--build-site")
  if (!out.includes("--prepare-env")) out.push("--prepare-env")
  return out
}

async function runUpdate(from, to) {
  const wg = wikiGenCommand()
  const cmdArgs = [...wg.args, "update", targetRepo, "--from", from, "--to", to, ...forwardedFlags()]
  console.log(`[wiki-gen-watch] Running: ${wg.cmd} ${cmdArgs.join(" ")}`)
  const child = spawn(wg.cmd, cmdArgs, { stdio: "inherit" })
  await new Promise((resolve) => child.on("exit", resolve))
}

async function main() {
  console.log(`[wiki-gen-watch] Watching ${targetRepo}`)
  console.log(`[wiki-gen-watch] Interval ${interval}s`)
  let last = git(["rev-parse", "HEAD"])
  console.log(`[wiki-gen-watch] Initial ${last.slice(0, 8)}`)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000))
    const current = gitSafe(["rev-parse", "HEAD"])
    if (!current || current === last) continue

    const changed = gitSafe(["diff", "--name-only", `${last}..${current}`]).split(/\r?\n/).filter(Boolean)
    console.log(`\n[wiki-gen-watch] New commit ${current.slice(0, 8)}; changed ${changed.length} files`)
    await runUpdate(last, current)
    last = current
  }
}

main().catch((err) => {
  console.error(`[wiki-gen-watch] Fatal: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
