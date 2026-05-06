import path from "node:path"
import fs from "node:fs/promises"
import ignore from "ignore"
import fg from "fast-glob"
import type { ScanResult } from "./types.js"
import { createReadStream } from "node:fs"
import readline from "node:readline"

const DEFAULT_IGNORE = [
  ".git/",
  "_wiki_workspace/",
  "_wiki_gen_docs*/",
  "_docs*/",
  "_docs/",
  "node_modules/",
  "__pycache__/",
  ".venv/",
  "venv/",
  ".tox/",
  ".mypy_cache/",
  ".pytest_cache/",
  ".next/",
  ".nuxt/",
  "dist/",
  "build/",
  "target/",
  "*.pyc",
  "*.pyo",
  "*.class",
  "*.o",
  "*.so",
  "*.dylib",
  "*.dll",
  "*.exe",
  "*.bin",
  "*.lock",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
]

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "TypeScript",
  ".tsx": "TypeScript/React",
  ".js": "JavaScript",
  ".jsx": "JavaScript/React",
  ".py": "Python",
  ".rs": "Rust",
  ".go": "Go",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".c": "C",
  ".cpp": "C++",
  ".cc": "C++",
  ".hpp": "C++",
  ".h": "C/C++ Header",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".fs": "F#",
  ".scala": "Scala",
  ".clj": "Clojure",
  ".ex": "Elixir",
  ".exs": "Elixir",
  ".erl": "Erlang",
  ".hs": "Haskell",
  ".ml": "OCaml",
  ".zig": "Zig",
  ".nim": "Nim",
  ".vue": "Vue",
  ".svelte": "Svelte",
  ".mdx": "MDX",
  ".md": "Markdown",
  ".sql": "SQL",
  ".graphql": "GraphQL",
  ".proto": "Protobuf",
  ".tf": "Terraform",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".toml": "TOML",
  ".json": "JSON",
  ".css": "CSS",
  ".scss": "SCSS",
  ".html": "HTML",
}

function complexityTier(count: number, topLevelCount: number, totalLines: number): ScanResult["complexity"] {
  // File-count based thresholds
  if (count >= 3000) return "enterprise"
  if (count >= 1000) return "high"
  // Code-volume based: dense projects with few files but lots of logic
  if (totalLines >= 40000) return "high"
  if (totalLines >= 15000) return "medium"
  if (count >= 200) return "medium"
  if (topLevelCount > 20 && count >= 100) return "medium"
  if (totalLines >= 5000) return "medium"
  return "low"
}

function recommendedAgents(complexity: ScanResult["complexity"]): number {
  switch (complexity) {
    case "enterprise": return 18
    case "high": return 12
    case "medium": return 7
    default: return 4
  }
}

/**
 * Estimate total lines of code by sampling the largest source files.
 * Fast enough for ~10K files; reads only source-code extensions.
 */
const SRC_EXTS = new Set([
  ".py", ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".cpp",
  ".c", ".h", ".swift", ".kt", ".rb", ".php", ".scala", ".cs", ".ex", ".exs",
])
async function estimateCodeLines(root: string, files: string[]): Promise<number> {
  const srcFiles = files.filter((f) => SRC_EXTS.has(path.extname(f).toLowerCase()))
  if (srcFiles.length === 0) return 0

  // Get file sizes (fast stat, no read), pick the 80 largest to sample.
  // Do not cap before sorting; a large file may be late alphabetically.
  const sized: Array<{ file: string; size: number }> = []
  for (const rel of srcFiles) {
    try {
      const s = await fs.stat(path.join(root, rel))
      sized.push({ file: rel, size: s.size })
    } catch { /* skip */ }
  }
  sized.sort((a, b) => b.size - a.size)
  const sample = sized.slice(0, 80)

  let totalLines = 0
  for (const { file } of sample) {
    try {
      const rl = readline.createInterface({
        input: createReadStream(path.join(root, file)),
        crlfDelay: Infinity,
      })
      let lines = 0
      for await (const _ of rl) lines++
      totalLines += lines
    } catch { /* skip */ }
  }

  // Extrapolate: if we sampled N files and got L lines, estimate total = L * (total / N)
  if (sample.length === 0) return 0
  const ratio = srcFiles.length / sample.length
  return Math.round(totalLines * ratio)
}

/**
 * Scan a codebase directory, applying ignore rules,
 * returning a structured file inventory.
 */
export async function scanCodebase(targetPath: string): Promise<ScanResult> {
  const root = path.resolve(targetPath)

  // Load .gitignore first as the base, then stack .wikigenignore on top (additive).
  // This means .wikigenignore only needs project-specific wiki exclusions — it does
  // not need to repeat everything already in .gitignore.
  let ignorePatterns = [...DEFAULT_IGNORE]
  for (const name of [".gitignore", ".wikigenignore"]) {
    const ignorePath = path.join(root, name)
    try {
      const content = await fs.readFile(ignorePath, "utf-8")
      ignorePatterns = [...ignorePatterns, ...content.split("\n").map((l) => l.trim()).filter(Boolean)]
    } catch {
      // file doesn't exist, skip
    }
  }

  const ig = ignore().add(ignorePatterns)

  // Get all files
  const allFiles = await fg("**/*", {
    cwd: root,
    dot: true,
    absolute: false,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: ["**/node_modules/**", "**/.git/**"],
  })

  // Apply ignore rules
  const relativeFiles: string[] = []
  let ignoredCount = 0
  for (const file of allFiles) {
    const normalized = file.split(path.sep).join("/")
    if (ig.ignores(normalized)) {
      ignoredCount++
    } else {
      relativeFiles.push(normalized)
    }
  }

  // Huge repo guard
  if (relativeFiles.length > 20000) {
    throw new Error(
      `Repository is too large for automatic documentation (${relativeFiles.length} files). ` +
      `Use --depth quick or add a .wikigenignore file to narrow scope.`,
    )
  }

  // Extract top-level directories
  const topLevel = Array.from(
    new Set(relativeFiles.map((f) => f.split("/")[0]!).filter(Boolean)),
  ).sort()

  const complexity = complexityTier(relativeFiles.length, topLevel.length, 0)

  // Detect languages
  const langSet = new Set<string>()
  for (const file of relativeFiles) {
    const ext = path.extname(file).toLowerCase()
    const lang = LANGUAGE_MAP[ext]
    if (lang) langSet.add(lang)
  }

  // Estimate code volume for better complexity grading
  let totalLines = 0
  try {
    totalLines = await estimateCodeLines(root, relativeFiles)
  } catch { /* best-effort */ }
  const volumeComplexity = complexityTier(relativeFiles.length, topLevel.length, totalLines)

  return {
    root,
    files: relativeFiles,
    topLevel,
    count: relativeFiles.length,
    ignored: ignoredCount,
    complexity: volumeComplexity,
    recommendedAgents: recommendedAgents(volumeComplexity),
    languages: Array.from(langSet).sort(),
    totalLines,
  }
}
