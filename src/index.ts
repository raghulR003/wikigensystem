#!/usr/bin/env node
/**
 * wiki-gen — Local, OpenCode SDK-powered codebase wiki generator.
 * Created by Raghul R.
 *
 * Usage: wiki-gen <path-to-repo> [options]
 *
 * Full auto flow:
 *   1. Scan codebase
 *   2. Check/create Python 3.10+ venv (_wikigen_env)
 *   3. Scaffold Sphinx project
 *   4. Seed blackboard with analysis context
 *   5. Run per-page agent sessions for content generation
 *   6. Build Sphinx HTML site
 *   7. Serve at http://localhost:33411
 */

import path from "node:path"
import fs from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createServer, type ServerResponse } from "node:http"
import { createReadStream } from "node:fs"
import chalk from "chalk"
import ora from "ora"
import { parseArgs } from "./cli.js"
import { startServer } from "./server.js"
import type { ServerInstance } from "./server.js"
import { scanCodebase } from "./scanner.js"
import { seedBlackboard, runSession } from "./session.js"
import { scaffoldSphinx, preparePythonEnv, buildSphinx, finalizeSphinxIndex, generateVersionIndex } from "./export-sphinx.js"
import { prepareIncrementalUpdate, runUpdateSession } from "./update.js"
import { watermark } from "./watermark.js"
import { fileExists, isPortInUse } from "./utils.js"
import { planPages } from "./planner.js"
import type { WikiGenResult, ScanResult, WikiGenConfig } from "./types.js"

function gitCommit(targetPath: string): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: targetPath, encoding: "utf-8" }).trim() } catch { return "" }
}

async function main(): Promise<void> {
  let config = parseArgs()

  process.stderr.write("\n" + chalk.bold.cyan("  📚 wiki-gen") + chalk.dim(` — by ${watermark()}`) + "\n")
  process.stderr.write(chalk.dim(`  OpenCode SDK v2 • ${new Date().toISOString().split("T")[0]}`) + "\n")

  if (config.model) {
    process.stderr.write(chalk.dim(`  Model:   ${config.model}`) + "\n")
  }
  if (config.watch) {
    process.stderr.write(chalk.dim(`  Mode:    watch (poll every ${config.watchInterval}s)`) + "\n")
  }
  process.stderr.write("\n")

  if (config.serveOnly) {
    await serveExistingDocs(config)
    return
  }

  if (config.clean) {
    await cleanWorkspace(config)
    process.exit(0)
  }

  if (config.dryRun) {
    await runDryRun(config)
    process.exit(0)
  }

  if (config.mode === "update") {
    await runUpdatePass(config)
    if (!serverStarted) process.exit(0)
    return
  }

  const sha = gitCommit(path.resolve(config.target))
  if (sha) {
    config = { ...config, output: `${config.output}_${sha.slice(0, 8)}` }
  }

  if (config.watch) {
    await watchLoop(config)
    return
  }

  await runOnePass(config)

  // If serveDocs started a server, the HTTP listener keeps the process alive.
  // Otherwise, exit cleanly.
  if (!serverStarted) {
    process.exit(0)
  }
}

async function runUpdatePass(config: WikiGenConfig): Promise<WikiGenResult> {
  const prepared = await prepareIncrementalUpdate(config)
  config = prepared.config
  const targetPath = path.resolve(config.target)

  process.stderr.write(chalk.dim(`  Mode:    incremental update`) + "\n")
  process.stderr.write(chalk.dim(`  Range:   ${prepared.from.slice(0, 8)}..${prepared.to.slice(0, 8)}`) + "\n")
  process.stderr.write(chalk.dim(`  Changed: ${prepared.changedFiles.length} files`) + "\n")
  process.stderr.write(chalk.dim(`  Pages:   ${prepared.affectedPages.map((p) => p.filename).join(", ") || "none"}`) + "\n\n")

  let server: ServerInstance | undefined
  let result: WikiGenResult = {
    success: false,
    outputDir: path.join(path.resolve(config.output), "source"),
    pagesGenerated: 0,
    duration: 0,
    errors: [],
  }

  try {
    await validateSafeOutputPath(targetPath, path.resolve(config.output))

    const envSpinner = ora("Checking Python environment...").start()
    await preparePythonEnv(config)
    envSpinner.succeed("Python 3.10+ venv ready (_wikigen_env)")

    const serverSpinner = ora("Starting OpenCode server...").start()
    server = await startServer(config)
    serverSpinner.succeed(`Server ready at ${server.url}`)

    result = await runUpdateSession(server.client, config, prepared.affectedPages, prepared.changedFiles, prepared.diff, prepared.from, prepared.to)

    const buildSpinner = ora("Building updated Sphinx site...").start()
    const buildDir = await buildSphinx(config)
    result.buildOutput = buildDir
    buildSpinner.succeed(`Site built at ${buildDir}`)

    await generateVersionIndex(targetPath, config.output)
    await pruneVersions(targetPath, config.output, config.maxVersions)

    if (config.deployPath) {
      execFileSync("rsync", ["-az", "--delete", `${buildDir}/`, config.deployPath], { stdio: config.verbose ? "inherit" : "pipe" })
      process.stderr.write(chalk.green(`  Deployed:   ${config.deployPath}\n`))
    }
  } catch (err) {
    process.stderr.write("\n" + chalk.red("✖ Fatal error:") + " " + String(err) + "\n")
    process.exitCode = 1
  } finally {
    server?.close()
  }

  if (process.exitCode) return result

  process.stderr.write("\n" + chalk.bold("Update Summary") + "\n")
  process.stderr.write(chalk.dim("─".repeat(50)) + "\n")
  process.stderr.write(`  Output:     ${chalk.cyan(result.outputDir)}\n`)
  process.stderr.write(`  Pages:      ${chalk.cyan(String(result.pagesGenerated))}\n`)
  if (result.buildOutput) process.stderr.write(`  Site:       ${chalk.cyan(result.buildOutput)}\n`)
  process.stderr.write("\n")

  if (result.buildOutput && !config.watch) serveDocs(result.buildOutput, config.servePort, config.verbose)
  return result
}

let serverStarted = false

async function serveExistingDocs(config: WikiGenConfig): Promise<void> {
  const buildDir = path.resolve(config.serveOnly!)
  const stat = await fs.stat(buildDir).catch(() => undefined)
  if (!stat?.isDirectory()) {
    throw new Error(`--serve-only path is not a directory: ${buildDir}`)
  }
  const indexPath = path.join(buildDir, "index.html")
  if (!await fileExists(indexPath)) {
    throw new Error(`--serve-only path does not look like a Sphinx HTML build; missing ${indexPath}`)
  }

  process.stderr.write(chalk.dim(`  Serving: ${buildDir}`) + "\n")
  serveDocs(buildDir, config.servePort, config.verbose)
}

// ── Single pass ────────────────────────────────────────────────────────────

async function runOnePass(config: WikiGenConfig): Promise<WikiGenResult> {
  const targetPath = path.resolve(config.target)
  const outputPath = path.resolve(config.output)

  const targetStat = await fs.stat(targetPath).catch(() => undefined)
  if (!targetStat?.isDirectory()) {
    throw new Error(`Target path is not a directory: ${targetPath}`)
  }
  await validateSafeOutputPath(targetPath, outputPath)

  if (config.buildSite || config.prepareEnv) {
    config = { ...config, format: "sphinx" }
  }

  process.stderr.write(chalk.dim(`  Target:  ${targetPath}`) + "\n")
  process.stderr.write(chalk.dim(`  Output:  ${outputPath}`) + "\n")
  process.stderr.write(chalk.dim(`  Depth:   ${config.depth}`) + "\n")
  process.stderr.write(chalk.dim(`  Format:  ${config.format}`) + "\n\n")

  let scan: ScanResult
  let result: WikiGenResult = {
    success: false,
    outputDir: outputPath,
    pagesGenerated: 0,
    duration: 0,
    errors: [],
  }

  let server: ServerInstance | undefined

  try {
    // ── Phase 1: Scan ──────────────────────────────────
    const scanSpinner = ora("Scanning codebase...").start()
    scan = await scanCodebase(targetPath)
    scanSpinner.succeed(
      `${scan.count} files found (${scan.ignored} ignored) • ${scan.topLevel.length} top-level dirs • ${scan.languages.length} languages`,
    )

    // ── Phase 2: Python Environment ─────────────────────
    if (config.format === "sphinx") {
      const envSpinner = ora("Checking Python environment...").start()
      await fs.mkdir(outputPath, { recursive: true })
      await preparePythonEnv(config)
      envSpinner.succeed("Python 3.10+ venv ready (_wikigen_env)")
    }

    // ── Phase 3: Start OpenCode Server ─────────────────
    const serverSpinner = ora("Starting OpenCode server...").start()
    server = await startServer(config)
    serverSpinner.succeed(`Server ready at ${server.url}`)

    // ── Phase 4: Sphinx Scaffold ──────────────────────────
    if (config.format === "sphinx") {
      const sphinxSpinner = ora("Scaffolding Sphinx project...").start()
      await scaffoldSphinx(config, scan)
      sphinxSpinner.succeed("Sphinx project scaffolded")
    }

    // ── Phase 5: Seed Blackboard ────────────────────────
    const seedSpinner = ora("Preparing analysis context...").start()
    await seedBlackboard(config, scan)
    seedSpinner.succeed("Context seeded")

    // ── Phase 6: Run Wiki Generation ────────────────────
    const genSpinner = ora({
      text: `Generating wiki (${scan.complexity} complexity, ~${scan.recommendedAgents} agents)...`,
      spinner: "dots",
    }).start()

    result = await runSession(server.client, config, scan)

    if (result.success && result.pagesGenerated > 0) {
      genSpinner.succeed(`Wiki generated: ${result.pagesGenerated} pages in ${formatDuration(result.duration)}`)
    } else if (result.pagesGenerated > 0) {
      genSpinner.warn(`Wiki generated with ${result.errors.length} warnings: ${result.pagesGenerated} pages`)
    } else {
      genSpinner.fail(`Wiki generation failed: no pages generated`)
      throw new Error("Wiki generation produced no documentation pages; refusing to build empty Sphinx site")
    }

    // ── Phase 7: Finalize and Build Sphinx ────────────────
    if (config.format === "sphinx") {
      await finalizeSphinxIndex(config)

      const buildSpinner = ora("Building Sphinx site...").start()
      try {
        const buildDir = await buildSphinx(config)
        buildSpinner.succeed(`Site built at ${buildDir}`)
        result.buildOutput = buildDir
      } catch (err) {
        buildSpinner.fail(`Sphinx build failed: ${String(err)}`)
        throw err
      }
    }

    // ── Version index ─────────────────────────────────────
    await generateVersionIndex(targetPath, config.output)
    await pruneVersions(targetPath, config.output, config.maxVersions)

  } catch (err) {
    process.stderr.write("\n" + chalk.red("✖ Fatal error:") + " " + String(err) + "\n")
    process.exitCode = 1
  } finally {
    server?.close()
  }

  if (process.exitCode) return result

  // ── Summary ───────────────────────────────────────────
  process.stderr.write("\n" + chalk.bold("Summary") + "\n")
  process.stderr.write(chalk.dim("─".repeat(50)) + "\n")
  process.stderr.write(`  Output:     ${chalk.cyan(result.outputDir)}\n`)
  process.stderr.write(`  Pages:      ${chalk.cyan(String(result.pagesGenerated))}\n`)
  process.stderr.write(`  Duration:   ${chalk.cyan(formatDuration(result.duration))}\n`)
  if (result.buildOutput) {
    process.stderr.write(`  Site:       ${chalk.cyan(result.buildOutput)}\n`)
  }
  process.stderr.write(`  Versions:   ${chalk.cyan(path.join(path.resolve(config.target), "VERSIONS.md"))}\n`)
  if (result.errors.length > 0) {
    process.stderr.write(`  Warnings:   ${chalk.yellow(String(result.errors.length))}\n`)
  }
  process.stderr.write("\n")

  // ── Phase 8: Serve the built site ──────────────────────
  if (result.buildOutput && !config.watch) {
    serveDocs(result.buildOutput, config.servePort, config.verbose)
  }

  return result
}

// ── Static file server ────────────────────────────────────────────────────

function serveDocs(buildDir: string, port: number, verbose: boolean): void {
  void isPortInUse(port).then((inUse) => {
    if (inUse) {
      process.stderr.write(chalk.yellow(`\n  ⚠ Port ${port} is in use. Skipping serve.\n`))
      process.stderr.write(chalk.dim(`    Manual: wiki-gen <target> --serve-only ${buildDir} --serve-port <free-port>\n\n`))
      return
    }

    const root = path.resolve(buildDir)
    const server = createServer((req, res) => {
      void serveStaticRequest(root, req.url ?? "/", res, verbose)
    })

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        process.stderr.write(chalk.yellow(`\n  ⚠ Port ${port} is in use. Skipping serve.\n`))
        return
      }
      process.stderr.write(chalk.red(`\n  Server error: ${err.message}\n`))
      process.exitCode = 1
    })

    serverStarted = true

    server.listen(port, "127.0.0.1", () => {
      process.stderr.write(chalk.bold.green(`\n  🌐 Documentation live at: `) + chalk.cyan.underline(`http://localhost:${port}`) + "\n")
      process.stderr.write(chalk.dim(`     Serving ${root}\n`))
      process.stderr.write(chalk.dim(`     Press Ctrl+C to stop the server\n\n`))
    })

    const cleanup = () => {
      server.close(() => {
        process.stderr.write(chalk.dim("\n  Server stopped.\n"))
        process.exit(0)
      })
    }

    process.once("SIGINT", cleanup)
    process.once("SIGTERM", cleanup)
  })
}

async function serveStaticRequest(root: string, rawUrl: string, res: ServerResponse, verbose: boolean): Promise<void> {
  try {
    const rootReal = await fs.realpath(root)
    const parsed = new URL(rawUrl, "http://localhost")
    let pathname = decodeURIComponent(parsed.pathname)
    if (pathname.endsWith("/")) pathname += "index.html"

    const rel = pathname.replace(/^\/+/, "")
    const requested = path.resolve(root, rel)
    const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
    if (requested !== root && !requested.startsWith(rootWithSep)) {
      sendText(res, 403, "Forbidden")
      return
    }

    let filePath = requested
    let lst = await fs.lstat(filePath).catch(() => undefined)
    if (lst?.isDirectory()) {
      filePath = path.join(filePath, "index.html")
      lst = await fs.lstat(filePath).catch(() => undefined)
    }

    if (!lst?.isFile() || lst.isSymbolicLink()) {
      sendText(res, 404, "Not Found")
      return
    }

    const real = await fs.realpath(filePath)
    const rootRealWithSep = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
    if (real !== rootReal && !real.startsWith(rootRealWithSep)) {
      sendText(res, 403, "Forbidden")
      return
    }
    const stat = await fs.stat(real)

    res.writeHead(200, {
      "Content-Type": contentType(real),
      "Content-Length": stat.size,
      "Cache-Control": "no-cache",
    })

    createReadStream(real).pipe(res)
    if (verbose) process.stderr.write(`[serve] 200 ${pathname} -> ${real}\n`)
  } catch (err) {
    sendText(res, 500, String(err))
  }
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" })
  res.end(body)
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  switch (ext) {
    case ".html": return "text/html; charset=utf-8"
    case ".css": return "text/css; charset=utf-8"
    case ".js": return "application/javascript; charset=utf-8"
    case ".json": return "application/json; charset=utf-8"
    case ".svg": return "image/svg+xml"
    case ".png": return "image/png"
    case ".jpg":
    case ".jpeg": return "image/jpeg"
    case ".gif": return "image/gif"
    case ".ico": return "image/x-icon"
    case ".woff": return "font/woff"
    case ".woff2": return "font/woff2"
    case ".ttf": return "font/ttf"
    case ".eot": return "application/vnd.ms-fontobject"
    default: return "application/octet-stream"
  }
}

// ── Watch loop ─────────────────────────────────────────────────────────────

async function watchLoop(config: WikiGenConfig): Promise<void> {
  const targetPath = path.resolve(config.target)
  let lastCommit = gitCommit(targetPath)
  if (!lastCommit) {
    throw new Error("Watch mode requires a git repository with at least one commit")
  }

  process.stderr.write(chalk.dim(`  Watching  ${targetPath}`) + "\n")
  process.stderr.write(chalk.dim(`  Initial   ${lastCommit.slice(0, 8)}`) + "\n\n")

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await sleep(config.watchInterval * 1000)

    const current = (() => { try { return gitCommit(targetPath) } catch { return "" } })()
    if (!current || current === lastCommit) continue

    const short = current.slice(0, 8)
    process.stderr.write(`\n${chalk.green("[watch]")} New commit ${chalk.cyan(short)}\n`)

    const watchConfig = { ...config, output: config.output.replace(/_[0-9a-f]{8,}$/, `_${short}`) }
    try {
      await runOnePass(watchConfig)
    } catch (err) {
      process.stderr.write(chalk.red(`[watch] Pass failed: ${String(err)}\n`))
    }

    lastCommit = current
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function pruneVersions(targetPath: string, versionedOutput: string, max: number): Promise<void> {
  const absBase = path.resolve(targetPath, versionedOutput)
  const parent = path.dirname(absBase)
  const prefix = path.basename(versionedOutput).split("_").slice(0, -1).join("_") + "_"
  if (!prefix || prefix === "_") return

  const entries = await fs.readdir(parent).catch(() => [] as string[])
  const versions = entries
    .filter((e) => e.startsWith(prefix) && e.length > prefix.length)
    .sort()
    .reverse()

  for (const old of versions.slice(max)) {
    await fs.rm(path.join(parent, old), { recursive: true, force: true }).catch(() => {})
  }
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

async function cleanWorkspace(config: WikiGenConfig): Promise<void> {
  const targetPath = path.resolve(config.target)
  const workspacePath = path.join(targetPath, "_wiki_workspace")
  const spinner = ora("Cleaning workspace...").start()

  let removed = 0
  if (await fs.stat(workspacePath).then((s) => s.isDirectory()).catch(() => false)) {
    await fs.rm(workspacePath, { recursive: true, force: true })
    removed++
  }

  if (removed === 0) {
    spinner.info("Nothing to clean — _wiki_workspace/ does not exist.")
  } else {
    spinner.succeed(`Removed _wiki_workspace/ from ${targetPath}`)
  }
}

async function runDryRun(config: WikiGenConfig): Promise<void> {
  const targetPath = path.resolve(config.target)

  const scanSpinner = ora("Scanning codebase...").start()
  const scan = await scanCodebase(targetPath)
  scanSpinner.succeed(
    `${scan.count} files • ${scan.languages.length} languages • ${scan.complexity} complexity • ~${scan.totalLines.toLocaleString()} lines`,
  )

  const pages = planPages(scan)

  process.stderr.write("\n" + chalk.bold("Dry Run — Planned Pages") + "\n")
  process.stderr.write(chalk.dim("─".repeat(62)) + "\n")
  for (const [i, page] of pages.entries()) {
    process.stderr.write(
      `  ${chalk.cyan(String(i + 1).padStart(2))}. ${chalk.bold(page.filename.padEnd(36))} ${page.title}\n`,
    )
    if (page.sourcePatterns.length > 0) {
      process.stderr.write(chalk.dim(`       patterns: ${page.sourcePatterns.join(", ")}\n`))
    }
    process.stderr.write(
      chalk.dim(`       targets:  ${page.minWords} words, ${page.minSnippets}+ snippets, ${page.minDiagrams}+ diagrams\n`),
    )
  }
  process.stderr.write("\n")
  process.stderr.write(chalk.dim(`  ${pages.length} pages planned  •  depth: ${config.depth}  •  format: ${config.format}\n`))
  process.stderr.write(chalk.dim(`  Languages: ${scan.languages.join(", ")}\n\n`))
  process.stderr.write(chalk.dim("  Run without --dry-run to generate documentation.\n\n"))
}

async function validateSafeOutputPath(targetPath: string, outputPath: string): Promise<void> {
  const relOutput = path.relative(targetPath, outputPath)
  if (relOutput.startsWith("..") || path.isAbsolute(relOutput)) {
    throw new Error(`Output directory must be inside the target repository: ${outputPath}`)
  }
  if (relOutput === "") {
    throw new Error("Output directory must be a subdirectory, not the repository root")
  }

  const targetReal = await fs.realpath(targetPath)
  const segments = relOutput.split(path.sep).filter(Boolean)
  let existingPath = targetPath
  let missingFrom = -1

  for (let i = 0; i < segments.length; i++) {
    const next = path.join(existingPath, segments[i]!)
    const stat = await fs.lstat(next).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return undefined
      throw err
    })
    if (!stat) { missingFrom = i; break }
    if (stat.isSymbolicLink()) throw new Error(`Output path must not contain symlinks: ${next}`)
    if (i < segments.length - 1 && !stat.isDirectory()) throw new Error(`Output path parent is not a directory: ${next}`)
    if (i === segments.length - 1 && !stat.isDirectory()) throw new Error(`Output path exists but is not a directory: ${next}`)
    existingPath = next
  }

  const existingReal = await fs.realpath(existingPath)
  const candidateReal = missingFrom === -1 ? existingReal : path.join(existingReal, ...segments.slice(missingFrom))
  const relReal = path.relative(targetReal, candidateReal)
  if (relReal === "" || relReal.startsWith("..") || path.isAbsolute(relReal)) {
    throw new Error(`Output directory escapes the target repository via symlink: ${outputPath}`)
  }
}

main().catch((err) => {
  process.stderr.write(chalk.red(`Fatal: ${err}\n`))
  process.exit(1)
})
