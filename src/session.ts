import path from "node:path"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client"
import type { WikiGenConfig, WikiGenResult, ScanResult } from "./types.js"
import { buildRelationshipGraph, serializeGraphForPrompt } from "./graph.js"
import { watermark } from "./watermark.js"
import { planPages, type PagePlan } from "./planner.js"
import { glob as fastGlob } from "fast-glob"
import { parseModel, fileExists } from "./utils.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROMPTS_DIR = path.resolve(__dirname, "prompts")
const CEO_PROMPT_PATH = path.join(PROMPTS_DIR, "wiki-ceo.txt")
const CEO_BRIEF_PATH = "_wiki_workspace/orchestrate/ceo-brief.md"

// ── Blackboard seeding ──────────────────────────────────────────────────────

export async function seedBlackboard(
  config: WikiGenConfig,
  scan: ScanResult,
): Promise<void> {
  const blackboardDir = path.join(config.target, "_wiki_workspace")
  const reconDir = path.join(blackboardDir, "recon")
  const orchestrateDir = path.join(blackboardDir, "orchestrate")

  await fs.mkdir(reconDir, { recursive: true })
  await fs.mkdir(orchestrateDir, { recursive: true })

  await fs.writeFile(
    path.join(reconDir, "file-tree.json"),
    JSON.stringify({
      root: scan.root,
      top_level: scan.topLevel,
      files: scan.files,
      count: scan.count,
      languages: scan.languages,
    }, null, 2),
  )

  await fs.writeFile(
    path.join(reconDir, "docgen-options.json"),
    JSON.stringify({
      target_path: scan.root,
      output_dir: getContentOutputPath(config),
      project_output_root: path.resolve(config.output),
      depth: config.depth,
      format: config.format,
      build_site: config.buildSite,
      prepare_env: config.prepareEnv,
      complexity: scan.complexity,
      recommended_agents: scan.recommendedAgents,
      python_packages: config.pythonPackages ?? [],
    }, null, 2),
  )

  const graph = await buildRelationshipGraph(scan.root, scan)
  await fs.writeFile(
    path.join(reconDir, "relationship-graph.json"),
    JSON.stringify(graph, null, 2),
  )
  await fs.writeFile(
    path.join(reconDir, "relationship-graph.md"),
    serializeGraphForPrompt(graph, 300),
  )

  // Write the page plan for visibility
  const pages = planPages(scan)
  await fs.writeFile(
    path.join(orchestrateDir, "page-plan.json"),
    JSON.stringify(pages.map((p) => ({ filename: p.filename, title: p.title, minWords: p.minWords })), null, 2),
  )

  if (config.verbose) {
    process.stderr.write(`[blackboard] Seeded at ${blackboardDir}\n`)
    process.stderr.write(`[blackboard] ${scan.count} files, ${scan.topLevel.length} top-level dirs\n`)
    process.stderr.write(`[blackboard] Complexity: ${scan.complexity}, agents: ${scan.recommendedAgents}\n`)
    process.stderr.write(`[blackboard] Page plan: ${pages.length} pages\n`)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getContentOutputPath(config: WikiGenConfig): string {
  const outputRoot = path.resolve(config.output)
  return config.format === "sphinx" ? path.join(outputRoot, "source") : outputRoot
}

// ── Permission handling ─────────────────────────────────────────────────────

async function handlePermission(
  client: OpencodeClient,
  permission: { id: string; permission: string; patterns: string[] },
  targetPath: string,
  outputPath: string,
  skipPermissions: boolean,
): Promise<void> {
  if (skipPermissions) {
    await client.permission.reply({ requestID: permission.id, reply: "always" })
    return
  }

  const safePermissions = new Set([
    "question", "read", "grep", "glob", "codesearch",
    "repo_map", "repo_graph", "lsp", "blackboard",
  ])
  if (safePermissions.has(permission.permission)) {
    await client.permission.reply({ requestID: permission.id, reply: "once" })
    return
  }

  if (permission.permission === "write") {
    const outputRel = path.relative(targetPath, outputPath).split(path.sep).join("/")
    const allowed = permission.patterns.every((p: string) => {
      const pattern = p.split(path.sep).join("/").replace(/^\.\//, "")
      return pattern === "_wiki_workspace" || pattern.startsWith("_wiki_workspace/") ||
        pattern === "_wiki_workspace/*" || pattern === outputRel ||
        pattern.startsWith(`${outputRel}/`) || pattern === `${outputRel}/*`
    })
    await client.permission.reply({ requestID: permission.id, reply: allowed ? "always" : "reject" })
    return
  }

  if (permission.permission === "bash") {
    const safeCommands = new Set(["git", "pwd", "ls", "rg", "grep", "find", "tree", "wc"])
    const allowed = permission.patterns.every((pattern) => safeCommands.has(pattern))
    await client.permission.reply({ requestID: permission.id, reply: allowed ? "once" : "reject" })
    return
  }

  await client.permission.reply({ requestID: permission.id, reply: "reject" })
}

// ── Event display ───────────────────────────────────────────────────────────

function formatToolEvent(part: Record<string, unknown>): string {
  const tool = part.tool as string | undefined ?? "unknown"
  const state = part.state as Record<string, unknown> | undefined
  const input = state && "input" in state ? state.input : undefined
  const title =
    (state && "title" in state && typeof state.title === "string" ? state.title : undefined) ??
    (input && typeof input === "object" && Object.keys(input).length > 0
      ? JSON.stringify(input).slice(0, 80)
      : tool)
  return `    ${tool === "task" ? "▸" : "›"} ${title}`
}

// ── Per-page prompt construction ────────────────────────────────────────────

function buildPagePrompt(
  page: PagePlan,
  targetPath: string,
  outputPath: string,
  blackboardPath: string,
  allPages: PagePlan[],
  ceoBrief: string,
  graphSlice: string,
): string {
  const otherPages = allPages
    .filter((p) => p.filename !== page.filename && p.filename !== "_wiki_meta.json")
    .map((p) => `- ${p.filename} — ${p.title}`)
    .join("\n")

  const sourceInstruction = page.sourcePatterns.length > 0
    ? [
        `SOURCE FILES TO READ:`,
        `Read these files/patterns from ${targetPath} BEFORE writing:`,
        ...page.sourcePatterns.map((p) => `  - ${p}`),
        `Also read the relationship graph for dependencies: ${path.join(blackboardPath, "recon", "relationship-graph.md")}`,
        ``,
        `If patterns return too many files, focus on the largest/most important ones.`,
        `If patterns return nothing relevant, use grep and glob to discover the right files.`,
      ].join("\n")
    : `Use grep and glob on ${targetPath} to discover relevant content.`

  return [
    `TASK: Write "${page.filename}" — ${page.title}`,
    ``,
    `You are writing ONE page of a comprehensive technical wiki.`,
    `This documentation is generated by wiki-gen, created by ${watermark()}.`,
    ``,
    `Target repository: ${targetPath}`,
    `Output file: ${path.join(outputPath, page.filename)}`,
    ``,
    `── CEO ORCHESTRATION BRIEF (AUTHORITATIVE) ───────────`,
    `Read the complete CEO brief at ${path.join(targetPath, CEO_BRIEF_PATH)} before writing.`,
    `Key excerpts (executive thesis + page directives):`,
    ceoBrief
      ? ceoBrief.slice(0, 5000) + (ceoBrief.length > 5000 ? `\n\n<!-- Truncated. Read full brief at ${path.join(targetPath, CEO_BRIEF_PATH)}. -->` : "")
      : `(CEO brief unavailable — fall back to blackboard recon files.)`,
    ``,
    `── RELATIONSHIP GRAPH SLICE FOR THIS PAGE ─────────────`,
    `Use this slice as the dependency/dependent source of truth for this page.`,
    graphSlice || `(No page-specific graph slice; read ${path.join(blackboardPath, "recon", "relationship-graph.md")})`,
    ``,
    sourceInstruction,
    ``,
    `── PAGE REQUIREMENTS ──────────────────────────────────`,
    page.brief,
    ``,
    `── QUALITY TARGETS ────────────────────────────────────`,
    `Minimum word count: ${page.minWords}`,
    `Minimum code snippets: ${page.minSnippets}`,
    `Minimum Mermaid diagrams: ${page.minDiagrams}`,
    ``,
    `── WRITING STYLE (MANDATORY) ──────────────────────────`,
    ``,
    `1. NARRATIVE FLOW: Write in flowing paragraphs, not bullet-point lists. Open each section`,
    `   with context — WHY does this component exist? What problem does it solve?`,
    ``,
    `2. EXPLAIN THE WHY: Never write "This function does X". Instead write "The system needs to`,
    `   handle Y because of Z constraint, so function_name() implements X by..."`,
    ``,
    `3. CONCRETE BEFORE ABSTRACT: Show code first, then explain the pattern. Lead with a real`,
    `   snippet, then zoom out to the architectural implication.`,
    ``,
    `4. PROGRESSIVE DISCLOSURE: Start with a 2-3 sentence executive summary, then mid-level`,
    `   walkthrough, then implementation details.`,
    ``,
    `5. SPECIFICITY: Never write "handles errors gracefully". Write exactly HOW — which exception,`,
    `   what retry logic, what line number, what happens on failure.`,
    ``,
    `6. TRANSITIONS: End each section with a bridge to the next concept.`,
    ``,
    `── CODE SNIPPET FORMAT ────────────────────────────────`,
    `For every function/class reference, include an inline code snippet:`,
    ``,
    "**File:** `path/to/source_file.ext` (lines 45-78)",
    "```<language>",
    "// actual implementation from source",
    "...",
    "```",
    ``,
    `Then explain what the code does, why it's written this way, and what design decision it represents.`,
    ``,
    `── RELATIONSHIP ANALYSIS ──────────────────────────────`,
    `For every module covered on this page, state:`,
    `- Imports from: [files it depends on]`,
    `- Used by: [files that depend on it]`,
    `- Why these relationships exist`,
    `- What breaks if this changes`,
    ``,
    `── DIAGRAM RULES ─────────────────────────────────────`,
    `ALL diagrams MUST use \`\`\`mermaid fenced blocks. NEVER ASCII art.`,
    `Above every diagram, write a brief sentence explaining what the reader should observe.`,
    ``,
    `── CROSS-REFERENCES ──────────────────────────────────`,
    `Other pages in this wiki (link to them where relevant):`,
    otherPages,
    ``,
    `── EXECUTION RULES ───────────────────────────────────`,
    `CONTEXT MANAGEMENT (CRITICAL):`,
    `1. Read only 3-5 source files, then write those sections immediately. Read more, write more.`,
    `2. Do NOT read all files before writing — you will exhaust the context window.`,
    `3. Build the document incrementally:`,
    `   a. Read brief + graph first`,
    `   b. Read 3-5 source files for the first module`,
    `   c. Write that module's section with snippets and analysis`,
    `   d. Repeat for the next module`,
    `4. After all sections are written, do a final edit pass to add transitions and cross-refs.`,
    `5. Use the write tool to create ${path.join(outputPath, page.filename)}`,
    `6. Every claim MUST cite a file path and line range.`,
    `7. Do NOT spawn sub-agents. Write the file directly yourself.`,
    `8. Do NOT use docgen commands. Use read/glob/grep/write directly.`,
  ].join("\n")
}

async function buildRetryPrompt(page: PagePlan, targetPath: string, outputPath: string, blackboardPath: string): Promise<string> {
  // Pre-read the most important source files so the agent has NO excuse to read.
  const sourceFiles = await resolveTopSourceFiles(page, targetPath, 5, 10_000)
  const sourceBlock = sourceFiles.length > 0
    ? [
        `── EMBEDDED SOURCE CODE (READ FROM DISK BY WIKI-GEN) ──`,
        `All source files below are provided INLINE. DO NOT read any files.`,
        `The content is already here:`,
        ...sourceFiles.map((f) => `\n**${f.file}** (${f.lines} lines):\n\`\`\`${f.lang}\n${f.content}\n\`\`\``),
      ].join("\n")
    : `(No source files could be pre-read. Use the relationship graph below.)`

  const ceoExcerpt = await readCompact(path.join(targetPath, CEO_BRIEF_PATH), 6_000)
  const graphExcerpt = await readCompact(path.join(blackboardPath, "recon", "relationship-graph.md"), 6_000)

  return [
    `RETRY: Write "${page.filename}" — ${page.title}`,
    ``,
    `CRITICAL: ALL source code is embedded in this prompt. DO NOT call read/glob/grep.`,
    `Use only the embedded content below. WRITE THE FILE IMMEDIATELY.`,
    ``,
    sourceBlock,
    ``,
    `── CEO BRIEF ──────────────────────────────────────────`,
    ceoExcerpt,
    ``,
    `── RELATIONSHIP GRAPH ────────────────────────────────`,
    graphExcerpt,
    ``,
    `── REQUIREMENTS ───────────────────────────────────────`,
    `Target: ${page.minWords} words, ${page.minSnippets}+ code snippets, ${page.minDiagrams}+ Mermaid diagrams`,
    `Brief: ${page.brief.split("\n")[0]}`,
    `Write to: ${path.join(outputPath, page.filename)}`,
    ``,
    `WRITE NOW. Do not read, do not explore, do not search. All content is above.`,
  ].join("\n")
}

async function resolveTopSourceFiles(page: PagePlan, targetPath: string, maxFiles: number, maxCharsPerFile: number): Promise<Array<{ file: string; lines: number; lang: string; content: string }>> {
  const candidates: Array<{ file: string; size: number }> = []
  for (const pattern of page.sourcePatterns) {
    const clean = pattern.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/?$/, "")
    const globPattern = clean.includes("*") ? clean : `${clean}/**`
    try {
      const matches = await fastGlob(globPattern, { cwd: targetPath, onlyFiles: true, dot: false })
      for (const m of matches) {
        try {
          const stat = await fs.stat(path.join(targetPath, m))
          candidates.push({ file: m, size: stat.size })
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  candidates.sort((a, b) => b.size - a.size)
  const top = candidates.slice(0, maxFiles)

  const results: Array<{ file: string; lines: number; lang: string; content: string }> = []
  for (const { file } of top) {
    const content = await readCompact(path.join(targetPath, file), maxCharsPerFile)
    if (!content) continue
    const lines = content.split("\n").length
    const ext = path.extname(file).slice(1) || "text"
    results.push({ file, lines, lang: ext, content })
  }
  return results
}

function buildCeoPrompt(targetPath: string, outputPath: string, blackboardPath: string, pages: PagePlan[]): string {
  const pageList = pages
    .filter((p) => p.filename !== "_wiki_meta.json")
    .map((p) => [
      `- ${p.filename} — ${p.title}`,
      `  Source patterns: ${p.sourcePatterns.length ? p.sourcePatterns.join(", ") : "discover via grep/glob"}`,
      `  Brief: ${p.brief.split("\n")[0]}`,
    ].join("\n"))
    .join("\n")

  return [
    `TASK: CEO documentation orchestration pass`,
    ``,
    `You are the documentation CEO. DO NOT write final documentation pages in this pass.`,
    `Your job is to read the blackboard, read the relationship graph, inspect the most important source files, and write the strategic brief that every per-page writer must obey.`,
    ``,
    `Target repository: ${targetPath}`,
    `Documentation output directory: ${outputPath}`,
    `CEO brief output: ${path.join(targetPath, CEO_BRIEF_PATH)}`,
    ``,
    `READ FIRST:`,
    `- ${path.join(blackboardPath, "recon", "file-tree.json")}`,
    `- ${path.join(blackboardPath, "recon", "docgen-options.json")}`,
    `- ${path.join(blackboardPath, "recon", "relationship-graph.md")}`,
    `- ${path.join(blackboardPath, "recon", "relationship-graph.json")}`,
    `- ${path.join(blackboardPath, "orchestrate", "page-plan.json")}`,
    ``,
    `PLANNED PAGES:`,
    pageList,
    ``,
    `WRITE EXACTLY ONE FILE: ${path.join(targetPath, CEO_BRIEF_PATH)}`,
    ``,
    `The CEO brief MUST contain these sections:`,
    `1. Executive thesis — what the system is, its true architecture, and the main mental model.`,
    `2. Dependency spine — the 10-20 most important files/modules from the relationship graph, with why they matter.`,
    `3. Cross-cutting flows — auth, request handling, persistence, external APIs, LLM/agent flows, error handling, deployment.`,
    `4. Page directives — for each planned page: what it must prove, which files it must read, which graph relationships it must cite, and what not to miss.`,
    `5. Consistency contract — naming conventions, preferred terminology, canonical Mermaid node names, and cross-reference rules.`,
    `6. Risks and critical analysis — architecture weaknesses, operational traps, coupling points, and likely documentation blind spots.`,
    ``,
    `Rules:`,
    `- The brief is orchestration metadata, not final docs. Keep it dense and actionable.`,
    `- Cite source files and line ranges for concrete claims when you inspect files.`,
    `- Use the relationship graph as the authoritative dependency map.`,
    `- Do not spawn sub-agents.`,
  ].join("\n")
}

async function runCeoPass(
  client: OpencodeClient,
  config: WikiGenConfig,
  targetPath: string,
  outputPath: string,
  blackboardPath: string,
  system: string,
  pages: PagePlan[],
  wikiGenSessionIDs: Set<string>,
): Promise<string> {
  const orchestrateDir = path.join(blackboardPath, "orchestrate")
  const briefPath = path.join(orchestrateDir, "ceo-brief.md")

  if (config.targetedPages && config.targetedPages.length > 0 && await fileExists(briefPath)) {
    return readCompact(briefPath, 18_000)
  }

  process.stderr.write(`\n  👑 CEO orchestration pass\n`)
  await fs.mkdir(orchestrateDir, { recursive: true })

  const ceoSessionRes = await client.session.create({
    directory: targetPath,
    title: `wiki-gen CEO: ${path.basename(targetPath)}`,
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
      { permission: "write", pattern: "_wiki_workspace/*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "deny" },
    ],
  })
  const ceoSessionID = ceoSessionRes.data?.id
  if (!ceoSessionID) throw new Error("Failed to create CEO OpenCode session")
  wikiGenSessionIDs.add(ceoSessionID)

  const timeout = config.depth === "deep" ? 12 * 60 * 1000
    : config.depth === "standard" ? 8 * 60 * 1000
    : 5 * 60 * 1000

  const started = Date.now()
  try {
    await Promise.race([
      client.session.prompt({
        sessionID: ceoSessionID,
        directory: targetPath,
        model: parseModel(config.model),
        system,
        parts: [{ type: "text", text: buildCeoPrompt(targetPath, outputPath, blackboardPath, pages) }],
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`CEO timed out after ${timeout / 60000}m`)), timeout)),
    ])
  } catch (err) {
    process.stderr.write(`  ⚠️ CEO pass failed: ${err instanceof Error ? err.message : String(err)}\n`)
    await writeFallbackCeoBrief(briefPath, pages, blackboardPath)
  }

  if (!await fileExists(briefPath)) {
    await writeFallbackCeoBrief(briefPath, pages, blackboardPath)
  }

  const stat = await fs.stat(briefPath).catch(() => undefined)
  process.stderr.write(`  ✅ CEO brief ready (${stat ? (stat.size / 1024).toFixed(1) : "0"}KB, ${Math.round((Date.now() - started) / 1000)}s)\n`)
  return readCompact(briefPath, 18_000)
}

async function writeFallbackCeoBrief(briefPath: string, pages: PagePlan[], blackboardPath: string): Promise<void> {
  const graphSummary = await readCompact(path.join(blackboardPath, "recon", "relationship-graph.md"), 14_000)
  const body = [
    `# CEO Brief`,
    ``,
    `Generated fallback CEO brief because the live CEO pass did not produce a file. Per-page writers must still treat this as authoritative orchestration metadata.`,
    ``,
    `## Dependency Spine`,
    graphSummary,
    ``,
    `## Page Directives`,
    ...pages.filter((p) => p.filename !== "_wiki_meta.json").map((p) => [
      `### ${p.filename} — ${p.title}`,
      p.brief,
      `Source patterns: ${p.sourcePatterns.length ? p.sourcePatterns.join(", ") : "discover via grep/glob"}`,
    ].join("\n")),
    ``,
    `## Consistency Contract`,
    `Use Mermaid only. Cite source files and line ranges. Every module page must explain imports, dependents, blast radius, and operational risks using the relationship graph.`,
  ].join("\n\n")
  await fs.writeFile(briefPath, body)
}

// ── Core session runner ─────────────────────────────────────────────────────

async function countPages(outputPath: string): Promise<number> {
  const entries = await fs.readdir(outputPath, { recursive: true }).catch(() => [])
  return entries.filter((e): e is string => typeof e === "string" && e.endsWith(".md")).length
}

async function readCompact(filePath: string, maxChars: number): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8").catch(() => "")
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars) + `\n\n<!-- Truncated by wiki-gen prompt budget; read full file at ${filePath}. -->`
}

async function buildGraphSlice(page: PagePlan, blackboardPath: string): Promise<string> {
  const graphPath = path.join(blackboardPath, "recon", "relationship-graph.json")
  const raw = await fs.readFile(graphPath, "utf-8").catch(() => "")
  if (!raw) return ""

  try {
    const graph = JSON.parse(raw) as { nodes?: Record<string, { file: string; language: string; imports: string[]; exports: string[]; definedSymbols: string[]; referencedBy: string[] }> }
    const nodes = graph.nodes ?? {}
    const patterns = page.sourcePatterns
      .map((p) => p.replace(/\*\*/g, "").replace(/\*/g, "").replace(/\/+/g, "/").replace(/\/$/, ""))
      .filter(Boolean)

    const selected = Object.entries(nodes)
      .filter(([file]) => patterns.length === 0 || patterns.some((p) => file === p || file.startsWith(p.replace(/\/\*$/, "")) || file.includes(p.replace(/^\//, ""))))
      .sort(([, a], [, b]) => (b.referencedBy?.length ?? 0) - (a.referencedBy?.length ?? 0))
      .slice(0, 40)

    if (selected.length === 0) return readCompact(path.join(blackboardPath, "recon", "relationship-graph.md"), 12_000)

    const lines = [
      `# Relationship Graph Slice — ${page.filename}`,
      `Selected files: ${selected.length}`,
      ``,
    ]
    for (const [file, node] of selected) {
      lines.push(`## ${file}`)
      lines.push(`- Language: ${node.language}`)
      lines.push(`- Imports: ${(node.imports ?? []).slice(0, 12).join(", ") || "none detected"}`)
      lines.push(`- Referenced by: ${(node.referencedBy ?? []).slice(0, 12).join(", ") || "none detected"}`)
      if (node.referencedBy && node.referencedBy.length > 12) lines.push(`- Additional dependents: ${node.referencedBy.length - 12}`)
      lines.push(`- Key symbols: ${(node.definedSymbols ?? []).slice(0, 12).join(", ") || "none detected"}`)
      lines.push("")
    }
    return lines.join("\n").slice(0, 20_000)
  } catch {
    return readCompact(path.join(blackboardPath, "recon", "relationship-graph.md"), 12_000)
  }
}

async function writeDeterministicFallbackPage(
  page: PagePlan,
  targetPath: string,
  outputPath: string,
  blackboardPath: string,
  ceoBrief: string,
  graphSlice: string,
): Promise<void> {
  const out = path.join(outputPath, page.filename)
  if (page.filename === "_wiki_meta.json") {
    await fs.writeFile(out, JSON.stringify({
      generated_at: new Date().toISOString(),
      generator: "wiki-gen",
      mode: "deterministic-fallback",
      page: page.filename,
      note: "LLM did not create this file; wiki-gen emitted fallback metadata."
    }, null, 2))
    return
  }

  const sourceFiles = await resolveTopSourceFiles(page, targetPath, 6, 7000)
  const title = page.title || page.filename.replace(/\.md$/, "")
  const sections: string[] = []

  sections.push(`# ${title}`)
  sections.push("")
  sections.push(`> This page was generated by wiki-gen's deterministic repair writer because the LLM did not create \`${page.filename}\` in the allotted context budget. It is intentionally code-grounded: it uses the CEO brief, relationship graph, and sampled source files to preserve coverage instead of leaving the knowledge base incomplete.`)
  sections.push("")

  sections.push(`## Purpose and Scope`)
  sections.push("")
  sections.push(page.brief)
  sections.push("")
  sections.push(`The documentation target is \`${targetPath}\`. The output file is \`${out}\`. This page should be treated as a repair-grade page: complete enough to navigate the subsystem, but less polished than pages authored fully by the LLM.`)
  sections.push("")

  sections.push(`## Relationship Graph Summary`)
  sections.push("")
  sections.push(graphSlice || await readCompact(path.join(blackboardPath, "recon", "relationship-graph.md"), 8000))
  sections.push("")

  sections.push(`## CEO Brief Excerpt`)
  sections.push("")
  sections.push(ceoBrief.slice(0, 5000))
  sections.push("")

  sections.push(`## Source File Evidence`)
  sections.push("")
  if (sourceFiles.length === 0) {
    sections.push(`No source files could be embedded for this page from the planned patterns: \`${page.sourcePatterns.join(", ") || "<none>"}\`.`)
  } else {
    for (const f of sourceFiles) {
      sections.push(`### \`${f.file}\``)
      sections.push("")
      sections.push(`This file is part of the evidence set for \`${page.filename}\`. It has approximately ${f.lines} lines in the embedded excerpt.`)
      sections.push("")
      sections.push("```" + f.lang)
      sections.push(f.content)
      sections.push("```")
      sections.push("")
      sections.push(`**Relationship note:** consult the graph above for imports, dependents, and blast-radius implications for \`${f.file}\`.`)
      sections.push("")
    }
  }

  sections.push(`## Architecture Sketch`)
  sections.push("")
  sections.push("```mermaid")
  sections.push("graph TD")
  sections.push(`  Page[${title}] --> Brief[CEO brief]`)
  sections.push(`  Page --> Graph[Relationship graph]`)
  for (const f of sourceFiles.slice(0, 5)) {
    const node = f.file.replace(/[^A-Za-z0-9]/g, "_").slice(0, 40)
    sections.push(`  Graph --> ${node}[${f.file}]`)
  }
  sections.push("```")
  sections.push("")

  sections.push(`## Repair Notes`)
  sections.push("")
  sections.push(`The LLM did not create this page before context or tool limits were reached. wiki-gen emitted this deterministic page so the generated documentation remains buildable, navigable, and complete enough for follow-up targeted regeneration.`)
  sections.push("")
  sections.push(`For a polished version, rerun targeted generation for this page only after reducing source patterns or using a model/backend that reliably honors write instructions.`)
  sections.push("")

  await fs.writeFile(out, sections.join("\n"))
}

/**
 * Run the full wiki generation session using per-page strategy.
 *
 * Architecture:
 *   - Each documentation page gets its own FRESH session
 *   - Each session loads only the files relevant to that page
 *   - No monolithic "read everything" pass → no context overflow
 *   - Pages are generated sequentially (shared session for permission caching)
 */
export async function runSession(
  client: OpencodeClient,
  config: WikiGenConfig,
  scan: ScanResult,
): Promise<WikiGenResult> {
  const startTime = Date.now()
  const outputPath = getContentOutputPath(config)
  const targetPath = path.resolve(config.target)
  const blackboardPath = path.join(targetPath, "_wiki_workspace")
  const errors: string[] = []

  await fs.mkdir(outputPath, { recursive: true })

  // Load system prompt (writing style guide)
  const systemPrompt = await fs.readFile(CEO_PROMPT_PATH, "utf-8")
  const system = systemPrompt
    .replace(/\$BLACKBOARD/g, blackboardPath)
    .replace(/\$OUTPUT_DIR/g, outputPath)
    .replace(/\{\{WATERMARK\}\}/g, watermark())

  // Plan pages
  const pages = planPages(scan)

  // Validate --targeted-pages against known page slugs and warn on typos.
  if (config.targetedPages && config.targetedPages.length > 0) {
    const knownSlugs = pages.map((p) => p.filename.replace(/\.md$/, "")).filter((s) => s !== "_wiki_meta")
    const unknown = config.targetedPages.filter((p) => !knownSlugs.includes(p))
    if (unknown.length > 0) {
      process.stderr.write(`  ⚠ Unknown targeted pages: ${unknown.join(", ")}\n`)
      process.stderr.write(`    Known pages: ${knownSlugs.join(", ")}\n\n`)
    }
  }

  if (config.verbose) {
    process.stderr.write(`[session] Planned ${pages.length} pages\n`)
  }

  // Track ALL wiki-gen session IDs so per-page events are not silently dropped.
  const wikiGenSessionIDs = new Set<string>()

  const ceoBrief = await runCeoPass(client, config, targetPath, outputPath, blackboardPath, system, pages, wikiGenSessionIDs)

  // Determine timeout per page based on depth
  const perPageTimeout = config.depth === "deep" ? 10 * 60 * 1000
    : config.depth === "standard" ? 6 * 60 * 1000
    : 4 * 60 * 1000

  const eventAbort = new AbortController()
  const events = await client.event.subscribe({ directory: targetPath }, { signal: eventAbort.signal })
  let allDone = false

  const eventLoop = (async () => {
    for await (const event of events.stream) {
      if (allDone) break

      if (event.type === "message.part.updated") {
        const part = event.properties.part as Record<string, unknown>
        if (typeof part.sessionID !== "string" || !wikiGenSessionIDs.has(part.sessionID)) continue

        if (part.type === "tool" && (part.state as Record<string, unknown>)?.status === "completed") {
          process.stderr.write(formatToolEvent(part) + "\n")
        }
      }

      if (event.type === "session.error") {
        const props = event.properties
        if (typeof props.sessionID !== "string" || !wikiGenSessionIDs.has(props.sessionID)) continue
        const errMsg = String(props.error?.name ?? "Unknown error")
        errors.push(errMsg)
        process.stderr.write(`  ❌ ${errMsg}\n`)
      }

      if (event.type === "permission.asked") {
        const perm = event.properties
        if (typeof perm.sessionID !== "string" || !wikiGenSessionIDs.has(perm.sessionID)) continue
        await handlePermission(client, perm, targetPath, outputPath, config.skipPermissions)
      }
    }
  })().catch((err) => {
    if (!allDone) errors.push(`event loop: ${String(err)}`)
  })

  // ── Generate pages (sequential or concurrent pool) ──────────────────────

  const concurrency = Math.max(1, config.concurrency ?? 1)
  const totalPages = pages.length
  let completedPages = 0
  let pageCounter = 0

  const processPage = async (page: PagePlan): Promise<void> => {
    const myNum = ++pageCounter
    const pageStart = Date.now()
    const label = `[${myNum}/${totalPages}] ${page.filename}`

    process.stderr.write(`\n  📝 ${label}\n`)

    // Skip pages not in --targeted-pages
    if (config.targetedPages && config.targetedPages.length > 0) {
      const pageName = page.filename.replace(/\.md$/, "")
      if (!config.targetedPages.includes(pageName)) {
        process.stderr.write(`  ⏭ Skipped (not in targeted pages)\n`)
        completedPages++
        return
      }
    }

    const expectedPath = path.join(outputPath, page.filename)

    // --resume: skip pages that already have meaningful output
    if (config.resume) {
      const existing = await fs.stat(expectedPath).catch(() => null)
      if (existing && existing.size > 100) {
        process.stderr.write(`  ⏭ ${label} — resumed (${(existing.size / 1024).toFixed(1)}KB)\n`)
        completedPages++
        return
      }
    }

    const graphSlice = await buildGraphSlice(page, blackboardPath)
    const prompt = buildPagePrompt(page, targetPath, outputPath, blackboardPath, pages, ceoBrief, graphSlice)

    try {
      // Each page gets a FRESH session to avoid context accumulation
      const pageSessionRes = await client.session.create({
        directory: targetPath,
        title: `wiki-gen: ${page.filename}`,
        permission: [
          { permission: "read", pattern: "*", action: "allow" },
          { permission: "question", pattern: "*", action: "allow" },
          { permission: "write", pattern: "_wiki_workspace/*", action: "allow" },
          { permission: "write", pattern: path.relative(targetPath, outputPath).split(path.sep).join("/") + "/*", action: "allow" },
          { permission: "external_directory", pattern: "*", action: "deny" },
        ],
      })
      const pageSessionID = pageSessionRes.data?.id
      if (!pageSessionID) throw new Error(`Failed to create session for ${page.filename}`)
      wikiGenSessionIDs.add(pageSessionID)

      await Promise.race([
        client.session.prompt({
          sessionID: pageSessionID,
          directory: targetPath,
          model: parseModel(config.model),
          system,
          parts: [{ type: "text", text: prompt }],
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timed out after ${perPageTimeout / 60000}m`)), perPageTimeout),
        ),
      ])

      // Verify file was created
      const exists = await fs.stat(expectedPath).catch(() => null)
      if (exists) {
        process.stderr.write(`  ✅ ${label} (${(exists.size / 1024).toFixed(1)}KB, ${((Date.now() - pageStart) / 1000).toFixed(0)}s)\n`)
        completedPages++
      } else {
        process.stderr.write(`  ⚠️ ${label} — file not created\n`)

        // Retry with compact prompt (context overflow often prevents the write)
        const retryLabel = `[RETRY ${page.filename}]`
        process.stderr.write(`  🔄 ${retryLabel} (compact mode)\n`)
        const retryPrompt = await buildRetryPrompt(page, targetPath, outputPath, blackboardPath)
        try {
          const retrySessionRes = await client.session.create({
            directory: targetPath,
            title: `wiki-gen retry: ${page.filename}`,
            permission: [
              { permission: "read", pattern: "*", action: "allow" },
              { permission: "question", pattern: "*", action: "allow" },
              { permission: "write", pattern: "_wiki_workspace/*", action: "allow" },
              { permission: "write", pattern: path.relative(targetPath, outputPath).split(path.sep).join("/") + "/*", action: "allow" },
              { permission: "external_directory", pattern: "*", action: "deny" },
            ],
          })
          const retrySessionID = retrySessionRes.data?.id
          if (retrySessionID) {
            wikiGenSessionIDs.add(retrySessionID)
            await Promise.race([
              client.session.prompt({
                sessionID: retrySessionID,
                directory: targetPath,
                model: parseModel(config.model),
                system,
                parts: [{ type: "text", text: retryPrompt }],
              }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error(`Retry timed out after ${perPageTimeout / 60000}m`)), perPageTimeout),
              ),
            ])
          }
          const retryExists = await fs.stat(expectedPath).catch(() => null)
          if (retryExists) {
            process.stderr.write(`  ✅ ${retryLabel} (${(retryExists.size / 1024).toFixed(1)}KB)\n`)
            completedPages++
            return
          }
          process.stderr.write(`  ⚠️ ${retryLabel} — still not created\n`)
        } catch (retryErr) {
          process.stderr.write(`  ❌ ${retryLabel} — ${retryErr instanceof Error ? retryErr.message : String(retryErr)}\n`)
        }

        process.stderr.write(`  🛠️ [FALLBACK ${page.filename}] deterministic repair writer\n`)
        await writeDeterministicFallbackPage(page, targetPath, outputPath, blackboardPath, ceoBrief, graphSlice)
        const fallbackExists = await fs.stat(expectedPath).catch(() => null)
        if (fallbackExists) {
          process.stderr.write(`  ✅ [FALLBACK ${page.filename}] (${(fallbackExists.size / 1024).toFixed(1)}KB)\n`)
          completedPages++
        } else {
          errors.push(`${page.filename} not created`)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`  ❌ ${label} — ${msg}\n`)
      errors.push(`${page.filename}: ${msg}`)
    }
  }

  if (concurrency === 1) {
    for (const page of pages) {
      await processPage(page)
    }
  } else {
    process.stderr.write(`\n  ⚡ Concurrency: ${concurrency} pages in parallel\n`)
    const queue = [...pages]
    await Promise.all(
      Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
        while (queue.length > 0) {
          const page = queue.shift()
          if (!page) break
          await processPage(page)
        }
      }),
    )
  }

  // Clean up
  allDone = true
  eventAbort.abort()
  await Promise.race([eventLoop, new Promise((resolve) => setTimeout(resolve, 500))])

  const pageCount = await countPages(outputPath)

  return {
    success: errors.length === 0 && pageCount >= pages.length - 1,  // allow 1 missing
    outputDir: outputPath,
    pagesGenerated: pageCount,
    duration: Date.now() - startTime,
    errors,
  }
}
