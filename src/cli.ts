import yargs from "yargs"
import { hideBin } from "yargs/helpers"
import path from "node:path"
import os from "node:os"
import type { WikiGenConfig } from "./types.js"
import { resolveModel, setConfigValue, getConfigValue, listConfig, printAvailableModels } from "./config.js"

function expandHome(value: string): string {
  if (value === "~") return os.homedir()
  if (value.startsWith(`~${path.sep}`) || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2))
  return value
}

export function parseArgs(argv: string[] = process.argv): WikiGenConfig {
  const raw = hideBin(argv)
  const updateMode = raw[0] === "update"
  const parseInput = updateMode ? raw.slice(1) : raw

  const args = yargs(parseInput)
    .command(
      "$0 <target>",
      "Generate a codebase wiki",
      (y) =>
        y
          .positional("target", {
            describe: "Path to the repository to document",
            type: "string",
            demandOption: true,
          })
          .option("output", {
            alias: "o",
            type: "string",
            describe: "Output directory for generated documentation",
            default: "_docs",
          })
          .option("depth", {
            type: "string",
            choices: ["quick", "standard", "deep"] as const,
            describe: "Documentation depth: quick (overview), standard (thorough), deep (exhaustive)",
            default: "standard",
          })
          .option("format", {
            alias: "f",
            type: "string",
            choices: ["markdown", "sphinx"] as const,
            describe: "Output format: raw markdown or Sphinx-oriented docs",
            default: "markdown",
          })
          .option("build-site", {
            type: "boolean",
            describe: "Build a static HTML site from generated docs (requires Python for Sphinx)",
            default: false,
          })
          .option("prepare-env", {
            type: "boolean",
            describe: "Prepare Python virtual environment for Sphinx build",
            default: false,
          })
          .option("python-packages", {
            type: "string",
            array: true,
            describe: "Extra Python packages to install for docs build",
          })
          .option("model", {
            alias: "m",
            type: "string",
            describe: "OpenCode model override (provider/model). Must be configured in opencode.json. Run 'wiki-gen config models' for available models.",
          })
          .option("port", {
            type: "number",
            describe: "Port for local OpenCode server",
            default: 4096,
          })
          .option("hostname", {
            type: "string",
            describe: "Hostname for local OpenCode server",
            default: "127.0.0.1",
          })
          .option("serve-port", {
            type: "number",
            describe: "Port for serving the built docs site (default: config servePort or 33411)",
          })
          .option("serve-only", {
            type: "string",
            describe: "Serve an existing built Sphinx HTML directory and skip generation/build",
          })
          .option("dangerously-skip-permissions", {
            type: "boolean",
            describe: "Auto-approve all permission requests (use with caution)",
            default: false,
          })
          .option("verbose", {
            alias: "v",
            type: "boolean",
            describe: "Enable verbose logging",
            default: false,
          })
          .option("max-versions", {
            type: "number",
            describe: "Maximum versioned snapshot directories to keep",
            default: 20,
          })
          .option("watch", {
            type: "boolean",
            describe: "Continuous watch mode: poll git and regenerate on new commits",
            default: false,
          })
          .option("watch-interval", {
            type: "number",
            describe: "Poll interval in seconds for watch mode",
            default: 30,
          })
          .option("targeted-pages", {
            type: "string",
            describe: "Comma-separated page list for partial regeneration (e.g., 'architecture,pipeline')",
          })
          .option("concurrency", {
            type: "number",
            describe: "Number of pages to generate in parallel (default: 1 — sequential)",
            default: 1,
          })
          .option("resume", {
            type: "boolean",
            describe: "Skip pages whose output file already exists — resume an interrupted run",
            default: false,
          })
          .option("clean", {
            type: "boolean",
            describe: "Remove _wiki_workspace/ from the target repo and exit",
            default: false,
          })
          .option("dry-run", {
            type: "boolean",
            describe: "Print planned pages and exit without calling the LLM",
            default: false,
          })
          .option("from", {
            type: "string",
            describe: "Incremental update base git commit/ref (update mode)",
          })
          .option("to", {
            type: "string",
            describe: "Incremental update target git commit/ref (default: HEAD)",
          })
          .option("deploy", {
            type: "string",
            describe: "Optional rsync destination for built HTML (e.g. user@host:/srv/docs/project/)",
          })
          .option("project-slug", {
            type: "string",
            describe: "Project slug for portal metadata/deployment",
          }),
    )
    .command(
      "config <action> [key] [value]",
      "Manage persistent wiki-gen configuration",
      (y) =>
        y
          .positional("action", {
            describe: "Config action",
            choices: ["set", "get", "list", "models"] as const,
            demandOption: true,
          })
          .positional("key", {
            describe: "Config key (e.g., 'model')",
            type: "string",
          })
          .positional("value", {
            describe: "Config value (for 'set' action)",
            type: "string",
          }),
      (argv) => {
        const action = argv.action as string
        const key = argv.key as string | undefined
        const value = argv.value as string | undefined

        switch (action) {
          case "models": {
            printAvailableModels()
            process.exit(0)
          }
          case "set": {
            if (!key || !value) {
              process.stderr.write("\n  Usage: wiki-gen config set <key> <value>\n\n")
              process.stderr.write("  Supported keys:\n")
              process.stderr.write("    model      OpenCode model (provider/model format)\n")
              process.stderr.write("    servePort  Default docs serve port (default: 33411)\n\n")
              process.stderr.write("  Examples:\n")
              process.stderr.write("    wiki-gen config set model anthropic/claude-3-5-sonnet\n")
              process.stderr.write("    wiki-gen config set servePort 8080\n\n")
              process.stderr.write("  Run 'wiki-gen config models' to see all available models.\n\n")
              process.exit(1)
            }
            try {
              setConfigValue(key, value)
              process.stderr.write(`✓ Set ${key} = ${value}\n`)
            } catch (err) {
              process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
              process.exit(1)
            }
            process.exit(0)
          }
          case "get": {
            if (!key) {
              process.stderr.write("Usage: wiki-gen config get <key>\n")
              process.stderr.write("Supported keys: model, servePort\n")
              process.exit(1)
            }
            const val = getConfigValue(key)
            if (val) {
              process.stdout.write(`${val}\n`)
            } else {
              process.stderr.write(`(not set)\n`)
            }
            process.exit(0)
          }
          case "list": {
            const cfg = listConfig()
            if (Object.keys(cfg).length === 0) {
              process.stderr.write("\n  No configuration set.\n\n")
              process.stderr.write("  Quick start:\n")
              process.stderr.write("    wiki-gen config models              List available models\n")
              process.stderr.write("    wiki-gen config set model <id>      Set default model\n")
              process.stderr.write("    wiki-gen config set servePort 8080  Set docs server port\n\n")
            } else {
              process.stderr.write("\n  Current configuration (~/.wiki-gen/config.json):\n")
              process.stderr.write("  " + "─".repeat(40) + "\n")
              for (const [k, v] of Object.entries(cfg)) {
                process.stderr.write(`    ${k} = ${v}\n`)
              }
              process.stderr.write("\n")
            }
            process.exit(0)
          }
        }
      },
    )
    .usage("wiki-gen <target> [options]\nwiki-gen update <target> [--from <ref>] [--to HEAD]\nwiki-gen config <set|get|list|models> [key] [value]")
    .example("wiki-gen ./my-project", "Generate wiki with default settings")
    .example(
      "wiki-gen ./app -f sphinx --build-site --prepare-env",
      "Full Sphinx build with auto env setup",
    )
    .example("wiki-gen config models", "List all available models from opencode.json")
    .example("wiki-gen config set model anthropic/claude-3-5-sonnet", "Set default model globally")
    .example("wiki-gen config list", "Show all current settings")
    .version("0.1.0")
    .help()
    .strict()
    .parseSync()

  const target = path.resolve(expandHome(args.target as string))
  const outputArg = expandHome((args.output as string) ?? "_docs")
  const output = path.isAbsolute(outputArg) ? path.resolve(outputArg) : path.resolve(target, outputArg)
  const configuredServePort = Number(getConfigValue("servePort"))
  const servePort = Number.isInteger(args["serve-port"] as number)
    ? (args["serve-port"] as number)
    : Number.isInteger(configuredServePort) && configuredServePort > 0
      ? configuredServePort
      : 33411

  return {
    mode: updateMode ? "update" : "generate",
    target,
    output,
    depth: (args.depth as WikiGenConfig["depth"]) ?? "standard",
    format: (args.format as WikiGenConfig["format"]) ?? "markdown",
    buildSite: (args["build-site"] as boolean) ?? false,
    prepareEnv: (args["prepare-env"] as boolean) ?? false,
    pythonPackages: args["python-packages"] as string[] | undefined,
    model: resolveModel(args.model as string | undefined),
    port: (args.port as number) ?? 4096,
    hostname: (args.hostname as string) ?? "127.0.0.1",
    servePort,
    serveOnly: args["serve-only"] ? path.resolve(expandHome(args["serve-only"] as string)) : undefined,
    skipPermissions: (args["dangerously-skip-permissions"] as boolean) ?? false,
    verbose: (args.verbose as boolean) ?? false,
    maxVersions: (args["max-versions"] as number) ?? 20,
    watch: (args.watch as boolean) ?? false,
    watchInterval: (args["watch-interval"] as number) ?? 30,
    targetedPages: args["targeted-pages"]
      ? (args["targeted-pages"] as string).split(",").map((s) => s.trim()).filter(Boolean)
      : undefined,
    updateFrom: args.from as string | undefined,
    updateTo: (args.to as string | undefined) ?? "HEAD",
    deployPath: args.deploy as string | undefined,
    projectSlug: args["project-slug"] as string | undefined,
    concurrency: Math.max(1, (args.concurrency as number) ?? 1),
    resume: (args.resume as boolean) ?? false,
    clean: (args.clean as boolean) ?? false,
    dryRun: (args["dry-run"] as boolean) ?? false,
  }
}
