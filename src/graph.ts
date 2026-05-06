import path from "node:path"
import fs from "node:fs/promises"
import type { ScanResult } from "./types.js"

export interface GraphNode {
  file: string
  language: string
  imports: string[]
  exports: string[]
  definedSymbols: string[]
  referencedBy: string[]
}

export interface RelationshipGraph {
  root: string
  nodes: Record<string, GraphNode>
  edgeCount: number
}

// Language-agnostic import/export patterns
const PATTERNS: Record<string, { imports: RegExp[]; exports: RegExp[]; symbols: RegExp[] }> = {
  ".py": {
    imports: [
      /^from\s+([\w.]+)\s+import/gm,
      /^import\s+([\w.]+)/gm,
    ],
    exports: [
      /^def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
      /^(\w+)\s*=/gm,
      /__all__\s*=\s*\[([^\]]+)\]/g,
    ],
    symbols: [
      /^def\s+(\w+)/gm,
      /^class\s+(\w+)/gm,
    ],
  },
  ".ts": {
    imports: [
      /from\s+['"]([^'"]+)['"]/g,
      /require\(['"]([^'"]+)['"]\)/g,
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    ],
    exports: [
      /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/gm,
      /export\s*\{([^}]+)\}/g,
    ],
    symbols: [
      /export\s+(?:default\s+)?(?:function|class)\s+(\w+)/gm,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm,
    ],
  },
  ".js": {
    imports: [
      /from\s+['"]([^'"]+)['"]/g,
      /require\(['"]([^'"]+)['"]\)/g,
      /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    ],
    exports: [
      /export\s+(?:default\s+)?(?:function|class|const|let|var)\s+(\w+)/gm,
      /module\.exports\s*=\s*(\w+)/gm,
    ],
    symbols: [
      /^(?:export\s+)?(?:function|class)\s+(\w+)/gm,
      /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm,
    ],
  },
  ".go": {
    imports: [
      /import\s+\(\s*([\s\S]*?)\s*\)/g,
      /import\s+"([^"]+)"/g,
    ],
    exports: [
      /^func\s+(\w+)/gm,
      /^type\s+(\w+)/gm,
    ],
    symbols: [
      /^func\s+([A-Z]\w*)/gm,
      /^type\s+([A-Z]\w*)/gm,
    ],
  },
  ".rs": {
    imports: [
      /use\s+([\w:]+)/gm,
      /extern\s+crate\s+(\w+)/gm,
    ],
    exports: [
      /^pub\s+(?:fn|struct|enum|trait|type|mod|const|static)\s+(\w+)/gm,
    ],
    symbols: [
      /^pub\s+(?:fn|struct|enum|trait)\s+(\w+)/gm,
    ],
  },
  ".java": {
    imports: [
      /^import\s+([\w.]+)/gm,
    ],
    exports: [
      /^public\s+(?:class|interface|enum)\s+(\w+)/gm,
      /^public\s+(?:static\s+)?(?:\w+\s+)?(\w+)\s*\(/gm,
    ],
    symbols: [
      /^public\s+(?:class|interface|enum)\s+(\w+)/gm,
    ],
  },
}

function detectLanguage(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".tsx") return ".ts"
  if (ext === ".jsx") return ".js"
  if (ext === ".mjs" || ext === ".cjs") return ".js"
  if (ext === ".mts" || ext === ".cts") return ".ts"
  return ext
}

function extractMatches(content: string, patterns: RegExp[]): string[] {
  const results = new Set<string>()
  for (const re of patterns) {
    // Reset regex state for global patterns
    const regex = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      if (match[1]) {
        // Handle comma-separated exports like export { a, b, c }
        if (match[1].includes(",")) {
          for (const sym of match[1].split(",")) {
            const cleaned = sym.trim().replace(/^.*\s+as\s+/, "").trim()
            if (cleaned && /^\w/.test(cleaned)) results.add(cleaned)
          }
        } else {
          const cleaned = match[1].trim()
          if (cleaned && /^\w/.test(cleaned)) results.add(cleaned)
        }
      }
    }
  }
  return Array.from(results)
}

function resolveImport(file: string, imp: string, topLevel: string[]): string | null {
  // Python: from my_pkg.module import X → my_pkg/module.py
  if (imp.includes(".")) {
    const asPath = imp.replace(/\./g, "/")
    for (const suffix of [".py", "/__init__.py", ".ts", ".js", "/index.ts", "/index.js"]) {
      const candidate = asPath + suffix
      if (topLevel.includes(candidate) || topLevel.some((f) => f.startsWith(candidate + "/"))) {
        return candidate
      }
    }
  }
  // Direct file reference
  for (const prefix of topLevel) {
    if (imp === prefix || imp.startsWith(prefix + "/") || prefix.startsWith(imp + "/")) {
      return prefix
    }
  }
  // Try with extensions
  for (const ext of [".py", ".ts", ".js", ".go", ".rs", ".java"]) {
    if (topLevel.includes(imp + ext)) return imp + ext
  }
  return null
}

/**
 * Build a language-agnostic relationship graph of the codebase.
 * Extracts imports, exports, defined symbols, and cross-references
 * for every source file. Written to the blackboard for the agent.
 */
export async function buildRelationshipGraph(
  root: string,
  scan: ScanResult,
): Promise<RelationshipGraph> {
  const nodes: Record<string, GraphNode> = {}
  const fileSet = new Set(scan.files)

  // Pass 1: extract imports, exports, symbols from each file
  for (const rel of scan.files) {
    const lang = detectLanguage(rel)
    const patterns = PATTERNS[lang]
    if (!patterns) continue

    const filePath = path.join(root, rel)
    let content: string
    try {
      content = await fs.readFile(filePath, "utf-8")
    } catch {
      continue
    }

    const imports = extractMatches(content, patterns.imports)
    const exports = extractMatches(content, patterns.exports)
    const definedSymbols = extractMatches(content, patterns.symbols)

    nodes[rel] = {
      file: rel,
      language: lang,
      imports,
      exports,
      definedSymbols,
      referencedBy: [],
    }
  }

  // Pass 2: resolve imports → file references, build referencedBy
  for (const [file, node] of Object.entries(nodes)) {
    for (const imp of node.imports) {
      const resolved = resolveImport(file, imp, scan.files)
      if (resolved && nodes[resolved]) {
        if (!nodes[resolved]!.referencedBy.includes(file)) {
          nodes[resolved]!.referencedBy.push(file)
        }
      }
    }
  }

  // Count edges
  let edgeCount = 0
  for (const node of Object.values(nodes)) {
    edgeCount += node.imports.length
  }

  return { root, nodes, edgeCount }
}

/**
 * Serialize the graph for the blackboard in a format the agent can consume.
 */
export function serializeGraphForPrompt(graph: RelationshipGraph, maxFiles: number = 200): string {
  const entries = Object.entries(graph.nodes)
    .sort(([, a], [, b]) => b.referencedBy.length - a.referencedBy.length)
    .slice(0, maxFiles)

  const lines: string[] = [
    `# Codebase Relationship Graph`,
    `Files analyzed: ${Object.keys(graph.nodes).length} | Cross-references: ${graph.edgeCount}`,
    ``,
    `## Most Referenced Files (top ${maxFiles})`,
    ``,
  ]

  for (const [file, node] of entries) {
    const refCount = node.referencedBy.length
    const impCount = node.imports.length
    const symbols = node.definedSymbols.slice(0, 8).join(", ")
    const refs = node.referencedBy.slice(0, 5).join(", ")
    const moreRefs = node.referencedBy.length > 5 ? ` +${node.referencedBy.length - 5} more` : ""

    lines.push(`### ${file} (${node.language})`)
    lines.push(`- Referenced by (${refCount}): ${refs}${moreRefs}`)
    lines.push(`- Imports (${impCount}): ${node.imports.slice(0, 8).join(", ")}`)
    if (symbols) lines.push(`- Key symbols: ${symbols}`)
    lines.push(``)
  }

  return lines.join("\n")
}
