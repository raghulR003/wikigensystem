/**
 * Page planner — deterministically maps codebase files to documentation pages.
 *
 * Instead of letting an agent read the entire codebase and overflow,
 * we pre-compute which source files are relevant to each page.
 * Each page gets its own agent session with only its files in context.
 */

import type { ScanResult } from "./types.js"

export interface PagePlan {
  /** Output filename (e.g. "architecture.md") */
  filename: string
  /** Human-readable page title */
  title: string
  /** Source file patterns to read for this page (relative globs or exact paths) */
  sourcePatterns: string[]
  /** Minimum word count target */
  minWords: number
  /** Minimum code snippet count */
  minSnippets: number
  /** Minimum Mermaid diagram count */
  minDiagrams: number
  /** Page-specific writing instructions */
  brief: string
}

/**
 * Given a scan result, produce a list of page plans.
 * Pages 1-4 (index, architecture, data-flow, api-reference, glossary) are universal.
 * Pages 5+ are derived from the actual codebase structure.
 */
export function planPages(scan: ScanResult): PagePlan[] {
  const pages: PagePlan[] = []

  // ── Universal pages ─────────────────────────────────────────────────────

  pages.push({
    filename: "index.md",
    title: "Project Overview",
    sourcePatterns: ["README*", "app.py", "main.*", "index.*", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "app-config*", "config.*"],
    minWords: 1000,
    minSnippets: 2,
    minDiagrams: 1,
    brief: [
      "Landing page for the documentation. Must include:",
      "- A clear, narrative project overview (what does this codebase do, who is it for, what problem does it solve)",
      "- A high-level architecture diagram (Mermaid) showing major components and their relationships",
      "- A 'Quick Orientation' section: what are the key directories, what are the entry points",
      "- Technology stack summary with versions where visible",
      "- Navigation links to every other page in this wiki",
      "Write this as a welcoming, informative landing page — not a dry table of contents.",
    ].join("\n"),
  })

  pages.push({
    filename: "architecture.md",
    title: "System Architecture",
    sourcePatterns: ["app.py", "main.*", "index.*", "config.*", "core/**", "src/**", "lib/**", "internal/**"],
    minWords: 2500,
    minSnippets: 6,
    minDiagrams: 3,
    brief: [
      "Deep architectural analysis. Must include:",
      "- Component-level Mermaid diagram (graph TD) showing ALL major modules and their connections",
      "- Layer-by-layer breakdown: what lives at each architectural layer and why",
      "- Design patterns used (name them explicitly: Factory, Observer, Pipeline, etc.)",
      "- Data model overview with key structures",
      "- Concurrency/async model if applicable",
      "- Critical design decisions: explain WHY the architecture is shaped this way, not just WHAT it looks like",
      "- Code snippets from entry points showing how components are wired together",
    ].join("\n"),
  })

  pages.push({
    filename: "data-flow.md",
    title: "Data Flow",
    sourcePatterns: ["**/*route*", "**/*handler*", "**/*pipe*", "**/*flow*", "**/*stream*", "**/*transform*", "**/*middleware*"],
    minWords: 1500,
    minSnippets: 4,
    minDiagrams: 4,
    brief: [
      "End-to-end data flow documentation. Must include:",
      "- At least 4 Mermaid diagrams showing different data flows through the system",
      "- For each flow: entry point → transformations → storage/output",
      "- Explain data formats at each stage (what goes in, what comes out)",
      "- Error propagation paths: where do errors enter, how do they flow, where are they caught",
      "- State management: what state is held where, how does it change",
    ].join("\n"),
  })

  pages.push({
    filename: "api-reference.md",
    title: "API Reference",
    sourcePatterns: ["**/*route*", "**/*endpoint*", "**/*handler*", "**/*view*", "**/*controller*", "**/*api*"],
    minWords: 1200,
    minSnippets: 5,
    minDiagrams: 1,
    brief: [
      "Complete API endpoint reference. Must include:",
      "- Every HTTP route with method, path, request parameters, and response format",
      "- Authentication requirements per endpoint",
      "- Code snippets showing the handler implementations",
      "- Error response formats",
      "- If the codebase is not HTTP-based, document the primary public interfaces instead",
    ].join("\n"),
  })

  pages.push({
    filename: "runtime-and-deployment.md",
    title: "Runtime & Deployment",
    sourcePatterns: ["Dockerfile*", "docker-compose*", "*.yaml", "*.yml", "app-config*", "config.*", "Makefile", "Procfile", ".env*", "**/*deploy*", "**/*startup*"],
    minWords: 1000,
    minSnippets: 3,
    minDiagrams: 1,
    brief: [
      "Runtime environment and deployment documentation. Must include:",
      "- Startup sequence: what happens when the application boots",
      "- Environment variables and configuration (all of them, with defaults)",
      "- Deployment target and constraints (cloud provider, container, serverless, etc.)",
      "- Dependencies and their versions",
      "- Health checks, monitoring, logging configuration",
    ].join("\n"),
  })

  pages.push({
    filename: "glossary.md",
    title: "Glossary",
    sourcePatterns: [],  // Agent should use grep to discover terms
    minWords: 600,
    minSnippets: 0,
    minDiagrams: 0,
    brief: [
      "Comprehensive glossary of domain terms, abbreviations, and component names. Must include:",
      "- Every domain-specific term used in the codebase, defined clearly",
      "- Every abbreviation and acronym with its expansion",
      "- Key class/module/function names with one-line descriptions",
      "- External service names referenced in the code",
      "Use 'grep' to find domain terms across the codebase.",
    ].join("\n"),
  })

  // ── Codebase-specific pages ─────────────────────────────────────────────
  // Discover major modules from top-level directories and key files

  const modulePages = discoverModulePages(scan)
  pages.push(...modulePages)

  // ── Meta ───────────────────────────────────────────────────────────────

  pages.push({
    filename: "_wiki_meta.json",
    title: "Generation Metadata",
    sourcePatterns: [],
    minWords: 0,
    minSnippets: 0,
    minDiagrams: 0,
    brief: [
      "Write a JSON file with generation metadata:",
      '{ "generated_at": "<ISO timestamp>",',
      '  "generator": "wiki-gen",',
      '  "depth": "<depth>",',
      '  "languages": [<detected>],',
      '  "pages": [<list of .md files generated>],',
      '  "complexity": "<complexity>" }',
    ].join("\n"),
  })

  return pages
}

/**
 * Discover module-specific documentation pages from the codebase structure.
 * Looks at top-level directories first, then expands into subdirectories
 * when a top-level dir has 2+ significant sub-modules (e.g. src/auth/, src/payments/).
 */
function discoverModulePages(scan: ScanResult): PagePlan[] {
  const pages: PagePlan[] = []
  const files = scan.files ?? []

  // Count files per directory — both top-level and one level deep.
  const dirCounts = new Map<string, number>()
  for (const f of files) {
    const parts = f.split("/")
    const first = parts[0]
    if (!first || first.startsWith(".") || first.startsWith("_")) continue
    dirCounts.set(first, (dirCounts.get(first) ?? 0) + 1)
    if (parts.length >= 3 && parts[1] && !parts[1].startsWith(".") && !parts[1].startsWith("_")) {
      const sub = `${first}/${parts[1]}`
      dirCounts.set(sub, (dirCounts.get(sub) ?? 0) + 1)
    }
  }

  const skipDirs = new Set([
    "node_modules", "venv", ".venv", "__pycache__", ".git", "dist", "build",
    "docs", "doc", "test", "tests", "spec", "specs", "fixtures", "mocks",
    "vendor", "third_party", "static", "templates",
    "assets", "public", "migrations",
  ])

  const isSkipped = (name: string) => skipDirs.has(name.toLowerCase())

  // Significant top-level dirs (>= 3 files, not in skip list)
  const significantTopLevel = [...dirCounts.entries()]
    .filter(([dir, count]) => !dir.includes("/") && count >= 3 && !isSkipped(dir))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)

  const MAX_PAGES = 6
  const usedSlugs = new Set<string>()

  for (const [dir, fileCount] of significantTopLevel) {
    if (pages.length >= MAX_PAGES) break

    // Check for significant subdirectories within this top-level dir.
    const subDirs = [...dirCounts.entries()]
      .filter(([d, count]) => {
        if (!d.startsWith(`${dir}/`) || d.split("/").length !== 2) return false
        const subName = d.split("/")[1]!
        return count >= 3 && !isSkipped(subName)
      })
      .sort((a, b) => b[1] - a[1])

    // If 2+ significant subdirs exist and there is room for at least 2 more pages,
    // prefer them over a single flat top-level page.
    if (subDirs.length >= 2 && MAX_PAGES - pages.length >= 2) {
      for (const [subDir, subCount] of subDirs.slice(0, MAX_PAGES - pages.length)) {
        const slug = subDir.toLowerCase().replace(/[^a-z0-9]+/g, "-")
        if (usedSlugs.has(slug)) continue
        usedSlugs.add(slug)
        const label = subDir.split("/")
          .map((p) => p.charAt(0).toUpperCase() + p.slice(1).replace(/[_-]/g, " "))
          .join(" › ")
        pages.push({
          filename: `${slug}.md`,
          title: `${label} Module`,
          sourcePatterns: [`${subDir}/**`],
          minWords: subCount > 10 ? 2000 : 1200,
          minSnippets: Math.min(subCount, 8),
          minDiagrams: 2,
          brief: buildModuleBrief(label, subDir, subCount),
        })
      }
    } else {
      const slug = dir.toLowerCase().replace(/[^a-z0-9]+/g, "-")
      if (usedSlugs.has(slug)) continue
      usedSlugs.add(slug)
      const title = dir.charAt(0).toUpperCase() + dir.slice(1).replace(/[_-]/g, " ")
      pages.push({
        filename: `${slug}.md`,
        title: `${title} Module`,
        sourcePatterns: [`${dir}/**`],
        minWords: fileCount > 10 ? 2000 : 1200,
        minSnippets: Math.min(fileCount, 8),
        minDiagrams: 2,
        brief: buildModuleBrief(title, dir, fileCount),
      })
    }
  }

  return pages
}

function buildModuleBrief(title: string, dir: string, fileCount: number): string {
  return [
    `Deep-dive into the ${title} module (${dir}/ directory, ${fileCount} files).`,
    `Must include:`,
    `- Purpose and responsibility of this module within the larger system`,
    `- Internal architecture diagram (Mermaid) showing how files within ${dir}/ relate to each other`,
    `- Walkthrough of the most important files with inline code snippets`,
    `- External dependencies: what does this module import from other parts of the codebase?`,
    `- What depends on this module? What would break if it changed?`,
    `- Error handling patterns specific to this module`,
    `- Design decisions and trade-offs`,
    `Read ALL files under ${dir}/ before writing.`,
  ].join("\n")
}
