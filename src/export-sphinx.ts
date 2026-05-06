import path from "node:path"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import type { WikiGenConfig, ScanResult } from "./types.js"
import { watermark, watermarkCredit, watermarkInline } from "./watermark.js"

/**
 * Scaffold a Sphinx documentation project from the generated markdown files.
 */
export async function scaffoldSphinx(config: WikiGenConfig, _scan: ScanResult): Promise<string> {
  const docsDir = path.resolve(config.output)
  const sourceDir = path.join(docsDir, "source")

  await fs.mkdir(sourceDir, { recursive: true })
  await fs.mkdir(path.join(sourceDir, "_static"), { recursive: true })
  await fs.mkdir(path.join(sourceDir, "_templates"), { recursive: true })

  // Write conf.py
  const confPy = generateConfPy(config)
  await fs.writeFile(path.join(sourceDir, "conf.py"), confPy)

  // Write custom.css for full-width content
  await writeCustomCss(sourceDir)

  // Force a stable global sidebar. sphinx_rtd_theme renders navigation from
  // its layout block, not from html_sidebars, so a direct layout override is
  // required to prevent page-context filtering on child pages.
  await writeRtdLayoutTemplate(sourceDir)

  // Write Makefile
  const makefile = generateMakefile()
  await fs.writeFile(path.join(docsDir, "Makefile"), makefile)

  if (config.verbose) {
    process.stderr.write(`[sphinx] Scaffolded at ${docsDir}\n`)
  }

  return docsDir
}

/**
 * Unique venv directory name — identifiable as wiki-gen's, reusable across runs.
 */
const WIKIGEN_VENV = "_wikigen_env"

/**
 * Minimum supported Python version.
 */
const MIN_PYTHON_VERSION = [3, 10]

/**
 * Check the system Python version. Returns the python3 binary path and version.
 * Throws if Python < 3.10 or not found.
 */
function checkPython(): { binary: string; version: string } {
  const candidates = ["python3", "python"]
  for (const bin of candidates) {
    try {
      const raw = execFileSync(bin, ["--version"], { encoding: "utf-8" }).trim()
      const match = raw.match(/Python (\d+)\.(\d+)\.(\d+)/)
      if (!match) continue
      const major = parseInt(match[1]!, 10)
      const minor = parseInt(match[2]!, 10)
      if (major > MIN_PYTHON_VERSION[0]! || (major === MIN_PYTHON_VERSION[0]! && minor >= MIN_PYTHON_VERSION[1]!)) {
        return { binary: bin, version: `${match[1]}.${match[2]}.${match[3]}` }
      }
    } catch {
      continue
    }
  }
  throw new Error(
    `Python ${MIN_PYTHON_VERSION.join(".")}+ is required but not found.\n` +
    `Install Python 3.10+ and ensure 'python3' is on your PATH.`,
  )
}

/**
 * Prepare a Python virtual environment for Sphinx.
 * Uses _wikigen_env as the venv name (unique to wiki-gen, reusable across runs).
 * Checks Python 3.10+ before proceeding.
 * Skips creation if venv already exists and is healthy.
 */
export async function preparePythonEnv(config: WikiGenConfig): Promise<void> {
  const docsDir = path.resolve(config.output)
  const venvDir = path.join(docsDir, WIKIGEN_VENV)
  const pip = path.join(venvDir, "bin", "pip")

  try {
    const python = checkPython()
    if (config.verbose) {
      process.stderr.write(`[sphinx] Using Python ${python.version} (${python.binary})\n`)
    }

    // Check if venv already exists and is healthy
    const venvHealthy = await fileExists(pip)
    if (venvHealthy) {
      if (config.verbose) {
        process.stderr.write(`[sphinx] Reusing existing venv at ${venvDir}\n`)
      }
    } else {
      // Create virtual env
      execFileSync(python.binary, ["-m", "venv", WIKIGEN_VENV], {
        cwd: docsDir,
        stdio: config.verbose ? "inherit" : "pipe",
      })
    }

    // Always ensure required packages are installed (idempotent)
    const packages = ["sphinx", "myst-parser", "sphinxcontrib-mermaid", "sphinx-rtd-theme"]
    if (config.pythonPackages) packages.push(...config.pythonPackages)

    execFileSync(pip, ["install", "--quiet", ...packages], {
      cwd: docsDir,
      stdio: config.verbose ? "inherit" : "pipe",
    })

    if (config.verbose) {
      process.stderr.write(`[sphinx] Python environment ready\n`)
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("Python")) throw err
    throw new Error(`Failed to prepare Python environment: ${err}`)
  }
}

/**
 * Build the Sphinx site.
 */
export async function buildSphinx(config: WikiGenConfig): Promise<string> {
  const docsDir = path.resolve(config.output)
  const sourceDir = path.join(docsDir, "source")
  const buildDir = path.join(docsDir, "_build", "html")

  // Look for sphinx-build in our venv first, then system. The venv may be
  // absent if an earlier interrupted run left only the source tree behind, so
  // buildSphinx self-heals instead of assuming preparePythonEnv already worked.
  const venvSphinx = path.join(docsDir, WIKIGEN_VENV, "bin", "sphinx-build")
  const legacySphinx = path.join(docsDir, "_venv", "bin", "sphinx-build")  // backwards compat
  let sphinxBuild = "sphinx-build"
  if (await fileExists(venvSphinx)) sphinxBuild = venvSphinx
  else if (await fileExists(legacySphinx)) sphinxBuild = legacySphinx
  else {
    await preparePythonEnv(config)
    if (await fileExists(venvSphinx)) sphinxBuild = venvSphinx
    else if (await fileExists(legacySphinx)) sphinxBuild = legacySphinx
  }

  try {
    await finalizeSphinxIndex(config)
    await normalizeMermaidFences(sourceDir)
    await injectVersionsIntoConf(config)
    await injectWikiNavigationIntoConf(config)
    await writeCustomCss(sourceDir)  // ensure custom.css exists before build
    await writeRtdLayoutTemplate(sourceDir)  // ensure deterministic RTD sidebar
    execFileSync(sphinxBuild, ["-b", "html", sourceDir, buildDir], {
      cwd: docsDir,
      stdio: config.verbose ? "inherit" : "pipe",
    })

    if (config.verbose) {
      process.stderr.write(`[sphinx] Built at ${buildDir}\n`)
    }

    return buildDir
  } catch (err) {
    throw new Error(`Sphinx build failed: ${err}`)
  }
}

/**
 * Convert ```mermaid and untagged Mermaid-syntax code blocks to :::{mermaid}
 * colon-fence directives so sphinxcontrib-mermaid can process them.
 * Handles both ```mermaid (tagged) and ``` (untagged but with Mermaid keywords).
 */
async function normalizeMermaidFences(sourceDir: string): Promise<void> {
  const entries = await fs.readdir(sourceDir, { recursive: true }).catch(() => [] as string[])
  const mdFiles = entries.filter((e): e is string => typeof e === "string" && e.endsWith(".md"))

  const mermaidKeywords = /^(graph |sequenceDiagram|classDiagram|flowchart |gantt|pie |erDiagram|stateDiagram|journey|gitGraph|mindmap|timeline|block |quadrantChart)/m

  for (const rel of mdFiles) {
    const filePath = path.join(sourceDir, rel)
    const content = await fs.readFile(filePath, "utf-8")
    let changed = false

    // Pass 1: ``` + mermaid keyword (untagged) → ```mermaid
    let tagged = content.replace(
      /```\s*\n((?:graph |sequenceDiagram|classDiagram|flowchart |gantt|pie |erDiagram|stateDiagram|journey|gitGraph|mindmap|timeline|block |quadrantChart)[\s\S]*?)```/g,
      (_, body: string) => `\`\`\`mermaid\n${body.trimEnd()}\n\`\`\``,
    )
    if (tagged !== content) changed = true

    // Pass 2: ```mermaid → :::{mermaid} colon fence
    const normalized = tagged.replace(
      /```mermaid\s*\n([\s\S]*?)```/g,
      (_, body: string) => `:::{mermaid}\n${body.trimEnd()}\n:::`,
    )
    if (normalized !== tagged) changed = true

    if (changed) {
      await fs.writeFile(filePath, normalized)
    }
  }
}

/**
 * Discover all sibling version directories and inject their URLs into the
 * Sphinx conf.py so sphinx_rtd_theme renders a version flyout menu.
 */
async function injectVersionsIntoConf(config: WikiGenConfig): Promise<void> {
  const docsDir = path.resolve(config.output)
  const confPath = path.join(docsDir, "source", "conf.py")
  const parent = path.dirname(docsDir)
  const prefix = path.basename(docsDir).split("_").slice(0, -1).join("_") + "_"
  if (!prefix || prefix === "_") return

  const entries = await fs.readdir(parent).catch(() => [] as string[])
  const versions = entries
    .filter((e) => e.startsWith(prefix) && e.length > prefix.length)
    .sort()
    .reverse()

  const currentSha = path.basename(docsDir).split("_").pop() ?? ""

  const versionEntries = versions.map((ver) => {
    const sha = ver.split("_").pop() ?? ""
    return `        ("${sha}", "../${ver}/_build/html/")`
  })

  const versionLines = [
    `    "versions": [`,
    ...(versionEntries.length > 0 ? [versionEntries.join(",\n")] : []),
    `    ],`,
    `    "current_version": "${currentSha}",`,
  ].join("\n")

  let existing = await fs.readFile(confPath, "utf-8").catch(() => "")

  // Strip any previously injected version lines from html_context
  existing = existing.replace(/\n\s*"versions":\s*\[[\s\S]*?\],\s*\n\s*"current_version":\s*"[^"]*",?/g, "")

  // Merge version entries into the existing html_context block.
  // The template defines html_context = { "display_github": ... } — we inject
  // versions right after the opening brace.
  if (!existing.includes("html_context = {")) {
    // No existing html_context — append one
    existing += `\n# ── Version flyout (auto-generated) ──────────────────────────────────\nhtml_context = {\n${versionLines}\n}\n`
  } else {
    // Merge into existing html_context block
    existing = existing.replace(
      /(html_context\s*=\s*\{)/,
      `$1\n${versionLines}\n`
    )
  }

  await fs.writeFile(confPath, existing)
}

/**
 * Ensure Sphinx has a usable master document with a proper toctree.
 * Runs AFTER generation. If index.md exists but lacks a toctree, appends
 * one. If index.md doesn't exist, creates a minimal one with toctree.
 * This prevents the RTD sidebar from collapsing all content under one entry.
 */
export async function finalizeSphinxIndex(config: WikiGenConfig): Promise<void> {
  const sourceDir = path.join(path.resolve(config.output), "source")
  if (!(await directoryExists(sourceDir))) return

  const indexPath = path.join(sourceDir, "index.md")
  let existing = await fileExists(indexPath)
    ? await fs.readFile(indexPath, "utf-8").catch(() => "")
    : ""

  // Discover all .md files that should appear in the toctree
  const entries = await fs.readdir(sourceDir, { recursive: true })
  const pages = entries
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".md") && entry !== "index.md")
    .map((entry) => entry.replace(/\.md$/, ""))
    .sort()

  const toctree = [
    "",
    "```{toctree}",
    ":maxdepth: 3",
    ":caption: Contents",
    "",
    ...pages,
    "```",
    "",
  ].join("\n")

  // Strip any existing MyST or RST toctree block so we always inject a fresh one
  if (existing) {
    // MyST fenced toctree: ```{toctree} ... ```
    existing = existing.replace(/```\{toctree\}[\s\S]*?```/g, "")
    // RST-style: .. toctree:: block (directive + indented content)
    existing = existing.replace(/^\.\.\s+toctree::.*(?:\n\s+.*)*/gm, "")
    existing = existing.trimEnd()
  }

  // If no index.md at all, create a minimal landing page
  if (!existing) {
    const title = path.basename(path.resolve(config.target))
    existing = [
      `# ${title} Documentation`,
      "",
      `Generated by wiki-gen by ${watermark()}. Select a page below or use the sidebar navigation.`,
      "",
    ].join("\n")
  }

  await fs.writeFile(indexPath, existing + "\n" + toctree)
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((stat) => stat.isFile()).catch(() => false)
}

async function directoryExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then((stat) => stat.isDirectory()).catch(() => false)
}

const CUSTOM_CSS = [
  "/* ── Full-width content area (RTD defaults to max-width: 800px) ───────── */",
  ".wy-nav-content { max-width: none !important; }",
  "",
  "/* ── Sidebar usability ──────────────────────────────────────────────── */",
  ".wy-nav-side { overflow-y: auto; }",
  ".wy-side-nav-search { background-color: #2980b9; }",
  ".wiki-gen-global-nav { margin-bottom: 1rem; }",
  ".wiki-gen-global-nav li.current > a { background: #fcfcfc; color: #404040; font-weight: 700; }",
  ".wiki-gen-global-nav li a { display: block; padding: 0.4045em 1.618em; color: #d9d9d9; }",
  ".wiki-gen-global-nav li a:hover { background: #4e4a4a; color: #fff; }",
  ".wiki-gen-local-toc ul { margin-bottom: 0; }",
  ".wiki-gen-local-toc li a { font-size: 0.9em; }",
  "",
  "/* ── Mobile responsiveness ──────────────────────────────────────────── */",
  "@media (max-width: 768px) {",
  "  .wy-nav-content {",
  "    max-width: 100% !important;",
  "    padding: 0.75rem !important;",
  "    word-wrap: break-word;",
  "    overflow-wrap: break-word;",
  "  }",
  "  .wy-nav-content-wrap {",
  "    margin-left: 0 !important;",
  "  }",
  "  .wy-nav-side {",
  "    position: relative !important;",
  "    width: 100% !important;",
  "    padding-bottom: 1rem;",
  "  }",
  "  .wy-side-scroll {",
  "    height: auto;",
  "    overflow-y: visible;",
  "  }",
  "  .wy-menu-vertical {",
  "    font-size: 0.95rem;",
  "  }",
  "  .wy-plain-list-disc, .rst-content .section ul, .rst-content .toctree-wrapper ul, article ul {",
  "    padding-left: 1rem;",
  "  }",
  "  /* Prevent code blocks from overflowing on mobile */",
  "  .highlight pre, .rst-content pre, pre {",
  "    white-space: pre-wrap !important;",
  "    word-break: break-word;",
  "    font-size: 0.8rem;",
  "  }",
  "  /* Mermaid diagrams should scale down */",
  "  .mermaid {",
  "    max-width: 100%;",
  "    overflow-x: auto;",
  "  }",
  "  /* Tables on mobile */",
  "  .wy-table-responsive table {",
  "    display: block;",
  "    overflow-x: auto;",
  "    white-space: nowrap;",
  "  }",
  "}",
  "",
  "/* ── Small phones ────────────────────────────────────────────────────── */",
  "@media (max-width: 480px) {",
  "  .wy-nav-content {",
  "    padding: 0.5rem !important;",
  "  }",
  "  h1 { font-size: 1.5rem; }",
  "  h2 { font-size: 1.25rem; }",
  "  h3 { font-size: 1.1rem; }",
  "}",
  "",
].join("\n")

async function writeCustomCss(sourceDir: string): Promise<void> {
  const staticDir = path.join(sourceDir, "_static")
  await fs.mkdir(staticDir, { recursive: true })
  await fs.writeFile(path.join(staticDir, "custom.css"), CUSTOM_CSS)
}

async function writeRtdLayoutTemplate(sourceDir: string): Promise<void> {
  const templatesDir = path.join(sourceDir, "_templates")
  await fs.mkdir(templatesDir, { recursive: true })
  await fs.writeFile(path.join(templatesDir, "layout.html"), RTD_LAYOUT_TEMPLATE)
}

const RTD_LAYOUT_TEMPLATE = `{#
  wiki-gen override for sphinx_rtd_theme.

  RTD builds its left navigation by calling Sphinx's toctree() helper from the
  layout template. On child pages that helper can render only the current
  subtree, which looks like the sidebar has "filtered out" every sibling page.
  Generated wikis need stable page navigation, so we render our own page list
  from html_context["wiki_nav_pages"] and reserve the local headings for a
  separate "On this page" block.
#}
{% extends "!layout.html" %}

{% block menu %}
  {% if wiki_nav_pages %}
    <p class="caption" role="heading"><span class="caption-text">Contents</span></p>
    <ul class="wiki-gen-global-nav">
    {%- for slug, label in wiki_nav_pages %}
      <li class="toctree-l1{% if pagename == slug %} current{% endif %}">
        <a class="reference internal{% if pagename == slug %} current{% endif %}" href="{{ pathto(slug) }}">{{ label }}</a>
      </li>
    {%- endfor %}
    </ul>

    {% if toc %}
      <p class="caption" role="heading"><span class="caption-text">On this page</span></p>
      <div class="wiki-gen-local-toc local-toc">{{ toc }}</div>
    {% endif %}
  {% else %}
    {{ super() }}
  {% endif %}
{% endblock %}
`

async function injectWikiNavigationIntoConf(config: WikiGenConfig): Promise<void> {
  const docsDir = path.resolve(config.output)
  const sourceDir = path.join(docsDir, "source")
  const confPath = path.join(sourceDir, "conf.py")
  const pages = await discoverWikiNavPages(sourceDir)
  if (pages.length === 0) return

  const navLines = [
    `    "wiki_nav_pages": [`,
    ...pages.map((page) => `        ("${pythonString(page.slug)}", "${pythonString(page.title)}"),`),
    `    ],`,
  ].join("\n")

  let existing = await fs.readFile(confPath, "utf-8").catch(() => "")
  existing = existing.replace(/\n\s*"wiki_nav_pages":\s*\[[\s\S]*?\],\s*/g, "\n")

  if (!existing.includes("html_context = {")) {
    existing += `\n# ── wiki-gen stable sidebar navigation ───────────────────────────────\nhtml_context = {\n${navLines}\n}\n`
  } else {
    existing = existing.replace(/(html_context\s*=\s*\{)/, `$1\n${navLines}\n`)
  }

  await fs.writeFile(confPath, existing)
}

async function discoverWikiNavPages(sourceDir: string): Promise<Array<{ slug: string; title: string }>> {
  const entries = await fs.readdir(sourceDir, { recursive: true }).catch(() => [] as string[])
  const mdFiles = entries
    .filter((entry): entry is string => typeof entry === "string")
    .filter((entry) => entry.endsWith(".md"))

  const bySlug = new Map<string, { slug: string; title: string }>()
  for (const rel of mdFiles) {
    const slug = rel.replace(/\.md$/, "").split(path.sep).join("/")
    const content = await fs.readFile(path.join(sourceDir, rel), "utf-8").catch(() => "")
    const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || titleFromSlug(slug)
    bySlug.set(slug, { slug, title })
  }

  const ordered: Array<{ slug: string; title: string }> = []
  const add = (slug: string) => {
    const page = bySlug.get(slug)
    if (page && !ordered.some((p) => p.slug === slug)) ordered.push(page)
  }

  add("index")

  const indexContent = await fs.readFile(path.join(sourceDir, "index.md"), "utf-8").catch(() => "")
  const toctreeMatch = indexContent.match(/```\{toctree\}\s*\n([\s\S]*?)```/)
  if (toctreeMatch) {
    const lines = toctreeMatch[1]!.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith(":"))
    for (const line of lines) add(line.replace(/\.md$/, ""))
  }

  for (const slug of [...bySlug.keys()].sort()) add(slug)
  return ordered
}

function titleFromSlug(slug: string): string {
  if (slug === "index") return "Home"
  return slug
    .split("/").pop()!
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ")
}

function generateConfPy(config: WikiGenConfig): string {
  const w = watermark()
  return `# Sphinx configuration — auto-generated by wiki-gen by ${w}
project = '${pythonString(path.basename(path.resolve(config.target)))}'
copyright = '${new Date().getFullYear()}, ${w}. Documentation generated by wiki-gen.'
author = '${w}'
release = '0.1.0'

extensions = [
    'myst_parser',
    'sphinxcontrib.mermaid',
]

templates_path = ['_templates']
exclude_patterns = ['_build', 'Thumbs.db', '.DS_Store']

# Read The Docs is the only supported theme (compulsory)
html_theme = 'sphinx_rtd_theme'
html_static_path = ['_static']

# ── Custom CSS: full-width content, mobile responsiveness, ${w} watermark ──
html_css_files = ['custom.css']

# ── Force globaltoc on every page (RTD switches to localtoc on sub-pages) ──
html_sidebars = {
    '**': ['globaltoc.html', 'relations.html', 'searchbox.html']
}

# RTD theme options
html_theme_options = {
    "navigation_depth": 3,
    "collapse_navigation": False,
    "sticky_navigation": True,
    "includehidden": True,  # Show :hidden: toctree entries in sidebar
    "titles_only": False,
}

# ── ${w} watermark in footer ─────────────────────────────────────────────
html_context = {
    "display_github": False,
    "github_user": "",
    "github_repo": "",
}
html_show_copyright = True
html_show_sphinx = False

# MyST configuration
myst_enable_extensions = [
    "colon_fence",
    "deflist",
]
myst_fence_as_directive = ["mermaid"]
myst_heading_anchors = 3
`
}

function pythonString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

function generateMakefile(): string {
  return `# Minimal Makefile for Sphinx documentation

SPHINXOPTS    ?=
SPHINXBUILD   ?= sphinx-build
SOURCEDIR     = source
BUILDDIR      = _build

help:
	@$(SPHINXBUILD) -M help "$(SOURCEDIR)" "$(BUILDDIR)" $(SPHINXOPTS) $(O)

.PHONY: help Makefile

  %: Makefile
	@$(SPHINXBUILD) -M $@ "$(SOURCEDIR)" "$(BUILDDIR)" $(SPHINXOPTS) $(O)
`
}

/**
 * Generate an HTML version-selector landing page at the parent directory.
 * Scans for directories matching <outputPrefix>_<commitSHA> and lists them
 * with links to their built HTML sites, plus a JavaScript dropdown switcher.
 */
export async function generateVersionIndex(targetPath: string, outputDir: string): Promise<void> {
  const parent = path.dirname(path.resolve(targetPath, outputDir))
  const basePrefix = path.basename(outputDir).split("_").slice(0, -1).join("_")
  const prefix = basePrefix + "_"
  if (!prefix || prefix === "_") return

  const entries = await fs.readdir(parent).catch(() => [] as string[])
  const versions = entries
    .filter((e) => e.startsWith(prefix) && e.length > prefix.length)
    .sort()
    .reverse()

  const currentSha = path.basename(outputDir).split("_").pop() ?? ""

  const versionOptions = versions.map((ver) => {
    const sha = ver.split("_").pop() ?? ""
    const selected = sha === currentSha ? " selected" : ""
    return `          <option value="${ver}/_build/html/"${selected}>${sha}</option>`
  })

  const versionLinks = versions.map((ver) => {
    const sha = ver.split("_").pop() ?? ""
    const html = `${ver}/_build/html/index.html`
    const label = sha === currentSha ? `▶ ${sha} (latest)` : sha
    return `          <li><a href="${html}">${label}</a></li>`
  })

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Documentation Versions</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1a1a2e; color: #eee; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #16213e; border: 1px solid #0f3460; border-radius: 12px; padding: 40px; max-width: 520px; width: 90%; box-shadow: 0 8px 32px rgba(0,0,0,.4); }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
  select { width: 100%; padding: 12px 16px; border-radius: 8px; border: 1px solid #0f3460; background: #0f3460; color: #eee; font-size: 16px; cursor: pointer; margin-bottom: 24px; }
  select:focus { outline: 2px solid #e94560; }
  ul { list-style: none; }
  li { margin-bottom: 8px; }
  a { color: #e94560; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .footer { margin-top: 24px; font-size: 12px; color: #666; }
  .watermark { margin-top: 12px; font-size: 11px; color: #555; }
</style>
</head>
<body>
  <div class="card">
    <h1>📚 Documentation Versions</h1>
    <p class="subtitle">Select a commit snapshot to view its documentation</p>
    <select onchange="if(this.value) window.location.href=this.value">
      <option value="">— Jump to version —</option>
${versionOptions.join("\n")}
    </select>
    <ul>
${versionLinks.join("\n")}
    </ul>
    <p class="footer">Generated by wiki-gen · ${new Date().toISOString()}</p>
    <p class="watermark">Created by ${watermark()} · MIT License</p>
  </div>
</div>
</body>
</html>
`

  await fs.writeFile(path.join(parent, "index.html"), html)

  // Also write VERSIONS.md for plain-text reference
  const mdRows = versions.map((ver) => {
    const sha = ver.split("_").pop() ?? ""
    return `| \`${sha}\` | [View](${ver}/_build/html/index.html) |`
  })
  await fs.writeFile(path.join(parent, "VERSIONS.md"), [
    "# Documentation Versions",
    "",
    "| Commit | Link |",
    "|--------|------|",
    ...mdRows,
    "",
    "---",
    "",
    "Generated by wiki-gen · Created by " + watermark(),
    "",
  ].join("\n") + "\n")
}
