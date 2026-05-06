import path from "node:path"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { ScanResult, WikiGenConfig, WikiGenResult } from "./types.js"
import { planPages, type PagePlan } from "./planner.js"

function git(target: string, args: string[]): string {
  return execFileSync("git", args, { cwd: target, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }).trim()
}

function parseModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const [providerID, ...rest] = model.split("/")
  if (!providerID || rest.length === 0) throw new Error(`Model must be in provider/model format, received: ${model}`)
  return { providerID, modelID: rest.join("/") }
}

export async function prepareIncrementalUpdate(config: WikiGenConfig): Promise<{ config: WikiGenConfig; from: string; to: string; changedFiles: string[]; diff: string; affectedPages: PagePlan[] }> {
  const target = path.resolve(config.target)
  const to = git(target, ["rev-parse", config.updateTo ?? "HEAD"])
  const from = config.updateFrom ? git(target, ["rev-parse", config.updateFrom]) : await inferPreviousDocsCommit(target, to)

  const oldDir = await findDocsDir(target, from)
  if (!oldDir) throw new Error(`Could not find previous docs directory for ${from.slice(0, 8)}. Pass --from <ref> or run full generation once.`)

  const newOutput = path.join(target, `_docs_${to.slice(0, 8)}`)
  await fs.rm(newOutput, { recursive: true, force: true })
  await fs.cp(oldDir, newOutput, { recursive: true })

  const changedFiles = git(target, ["diff", "--name-only", `${from}..${to}`]).split(/\r?\n/).filter(Boolean)
  const diff = git(target, ["diff", "--no-ext-diff", `${from}..${to}`])
  if (changedFiles.length === 0) {
    process.stderr.write(`  No source changes detected between ${from.slice(0, 8)} and ${to.slice(0, 8)}.\n`)
  }

  const updateConfig = { ...config, output: newOutput, format: "sphinx" as const, buildSite: true, prepareEnv: true }
  const scan = await import("./scanner.js").then((m) => m.scanCodebase(target))
  const affectedPages = selectAffectedPages(scan, changedFiles)

  return { config: updateConfig, from, to, changedFiles, diff, affectedPages }
}

async function inferPreviousDocsCommit(target: string, current: string): Promise<string> {
  const dirs = await fs.readdir(target).catch(() => [] as string[])
  const candidates = dirs
    .filter((d) => d.startsWith("_docs_") && !d.endsWith(current.slice(0, 8)))
    .map((d) => d.replace(/^_docs_/, ""))
    .filter(Boolean)
  if (candidates.length === 0) throw new Error("No previous _docs_<sha> directories found; pass --from <ref>.")
  // Prefer the newest reachable commit by git log order.
  const log = git(target, ["log", "--format=%H", "-100"]).split(/\r?\n/)
  for (const sha of log) {
    const match = candidates.find((c) => sha.startsWith(c))
    if (match) return sha
  }
  return candidates[0]!
}

async function findDocsDir(target: string, commit: string): Promise<string | undefined> {
  const short = commit.slice(0, 8)
  const exact = path.join(target, `_docs_${short}`)
  if (await fs.stat(exact).then((s) => s.isDirectory()).catch(() => false)) return exact
  const dirs = await fs.readdir(target).catch(() => [] as string[])
  const found = dirs.find((d) => d.startsWith("_docs_") && commit.startsWith(d.replace(/^_docs_/, "")))
  return found ? path.join(target, found) : undefined
}

function selectAffectedPages(scan: ScanResult, changedFiles: string[]): PagePlan[] {
  const pages = planPages(scan).filter((p) => p.filename !== "_wiki_meta.json")
  const affected = new Set<string>()
  const add = (name: string) => affected.add(name)

  for (const file of changedFiles) {
    add("index.md")
    if (/^(app|main|index|config)\./.test(file) || file.includes("/config.")) add("architecture.md")
    if (/route|endpoint|handler|api|sdk/i.test(file)) add("api-reference.md")
    if (/route|endpoint|handler|pipe|flow|stream|transform|middleware/i.test(file)) add("data-flow.md")
    if (/Dockerfile|compose|requirements|package|pyproject|deploy|env|config/i.test(file)) add("runtime-and-deployment.md")
    for (const page of pages) {
      for (const pat of page.sourcePatterns) {
        const prefix = pat.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/$/, "")
        if (prefix && (file === prefix || file.startsWith(prefix.replace(/\/\*$/, "")))) add(page.filename)
      }
    }
  }

  return pages.filter((p) => affected.has(p.filename))
}

export async function runUpdateSession(client: OpencodeClient, config: WikiGenConfig, affectedPages: PagePlan[], changedFiles: string[], diff: string, from: string, to: string): Promise<WikiGenResult> {
  const start = Date.now()
  const target = path.resolve(config.target)
  const sourceDir = path.join(path.resolve(config.output), "source")
  const errors: string[] = []

  if (affectedPages.length === 0) {
    return { success: true, outputDir: sourceDir, pagesGenerated: 0, duration: Date.now() - start, errors: [] }
  }

  for (const page of affectedPages) {
    const pagePath = path.join(sourceDir, page.filename)
    const existing = await fs.readFile(pagePath, "utf-8").catch(() => "")
    const relevantDiff = trimDiffForPage(diff, page, changedFiles)
    const prompt = buildUpdatePrompt(page, target, pagePath, existing, relevantDiff, changedFiles, from, to)
    process.stderr.write(`\n  🔧 updating ${page.filename}\n`)

    try {
      const session = await client.session.create({
        directory: target,
        title: `wiki-gen update: ${page.filename}`,
        permission: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "write", pattern: path.relative(target, sourceDir).split(path.sep).join("/") + "/*", action: "allow" },
          { permission: "external_directory", pattern: "*", action: "deny" },
        ],
      })
      const id = session.data?.id
      if (!id) throw new Error("failed to create update session")
      await Promise.race([
        client.session.prompt({ sessionID: id, directory: target, model: parseModel(config.model), parts: [{ type: "text", text: prompt }] }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("update timed out after 5m")), 5 * 60 * 1000)),
      ])
      const stat = await fs.stat(pagePath).catch(() => undefined)
      if (!stat || stat.size < Math.max(200, existing.length * 0.5)) throw new Error("updated page missing or suspiciously small")
      process.stderr.write(`  ✅ updated ${page.filename}\n`)
    } catch (err) {
      errors.push(`${page.filename}: ${err instanceof Error ? err.message : String(err)}`)
      await deterministicPatch(pagePath, existing, relevantDiff, from, to)
      process.stderr.write(`  🛠️ deterministic patch ${page.filename}\n`)
    }
  }

  return { success: errors.length === 0, outputDir: sourceDir, pagesGenerated: affectedPages.length, duration: Date.now() - start, errors }
}

function trimDiffForPage(diff: string, _page: PagePlan, _changedFiles: string[]): string {
  return diff.length > 45_000 ? diff.slice(0, 45_000) + "\n\n# ... diff truncated by wiki-gen prompt budget ..." : diff
}

function buildUpdatePrompt(page: PagePlan, target: string, pagePath: string, existing: string, diff: string, changedFiles: string[], from: string, to: string): string {
  return [
    `TASK: Incrementally update existing documentation page ${page.filename}.`,
    `Target repo: ${target}`,
    `Page to edit: ${pagePath}`,
    `Commit range: ${from.slice(0, 8)}..${to.slice(0, 8)}`,
    `Changed files:\n${changedFiles.map((f) => `- ${f}`).join("\n")}`,
    ``,
    `RULES:`,
    `- Do NOT rewrite the whole page unless the diff requires it.`,
    `- Preserve existing headings, Mermaid diagrams, and narrative style where still valid.`,
    `- Patch only changed behavior, APIs, config, relationships, snippets, and implications.`,
    `- Add a short "Recent Changes" section if useful.`,
    `- Use the write/edit tool to update ${pagePath}.`,
    ``,
    `EXISTING PAGE:\n${existing.slice(0, 35_000)}`,
    ``,
    `GIT DIFF:\n${diff}`,
  ].join("\n")
}

async function deterministicPatch(pagePath: string, existing: string, diff: string, from: string, to: string): Promise<void> {
  const section = [
    ``,
    `## Recent Changes (${from.slice(0, 8)} → ${to.slice(0, 8)})`,
    ``,
    `wiki-gen could not complete an LLM patch for this page, so it appended the relevant commit diff for follow-up review.`,
    ``,
    `\`\`\`diff`,
    diff.slice(0, 20_000),
    `\`\`\``,
    ``,
  ].join("\n")
  await fs.writeFile(pagePath, existing.trimEnd() + "\n" + section)
}
