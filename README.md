# wiki-gen

Local, AI-powered codebase documentation generator. Point it at any repository and get a Read-the-Docs themed Sphinx knowledge base — architecture deep-dives, dependency analysis, inline code snippets, Mermaid diagrams, and incremental update support.

---

## How it works

wiki-gen runs an 8-phase pipeline entirely on your machine:

1. **Scan** — Indexes every source file, detects languages, estimates complexity, builds a relationship graph of imports and exports.
2. **Environment** — Bootstraps a Python virtualenv (`_wikigen_env`) and installs Sphinx + RTD theme if `--prepare-env` is set.
3. **OpenCode server** — Starts a local OpenCode AI server on the configured port.
4. **Sphinx scaffold** — Creates the `conf.py`, `index.rst`, custom CSS, and sidebar overrides.
5. **Blackboard** — Writes the file tree, relationship graph, and docgen options to `_wiki_workspace/recon/` for the AI to read.
6. **CEO pass** — A single orchestration session reads the full blackboard and writes a cross-page strategy brief (`_wiki_workspace/orchestrate/ceo-brief.md`) before any docs page is written.
7. **Per-page generation** — Each documentation page gets its own isolated AI session with a graph slice and the CEO brief as context. Falls back through three tiers: normal → compact (inline source) → deterministic repair writer.
8. **Build + Serve** — Sphinx builds the HTML site; wiki-gen serves it locally and optionally rsyncs to a remote host.

---

## Supported languages

TypeScript · JavaScript · Python · Go · Rust · Java · Kotlin · Swift · C · C++ · C# · F# · Ruby · PHP · Scala · Clojure · Elixir · Erlang · Haskell · OCaml · Zig · Nim · Vue · Svelte · MDX · SQL · GraphQL · Protobuf · Terraform · YAML/TOML/JSON

---

## Prerequisites

- **Node.js** >= 18
- **Python** >= 3.10 (for Sphinx builds; only required when using `--build-site`)
- **OpenCode** — wiki-gen uses the `@opencode-ai/sdk` to drive AI sessions. Install and configure OpenCode with at least one provider/model before using wiki-gen.
  - OpenCode config is typically at `~/.config/opencode/opencode.json`
  - Run `wiki-gen config models` to verify wiki-gen can see your configured models

---

## Install

```bash
npm install -g wiki-gen
```

For local development:

```bash
npm install
npm run build
node dist/index.js ./my-project --help
```

---

## Model setup

wiki-gen only uses models configured in your local OpenCode config:

```text
~/.config/opencode/opencode.json   (Linux/macOS)
~/.opencode/opencode.json          (alternative)
```

List available models:

```bash
wiki-gen config models
```

Set a default model (used for all future runs):

```bash
wiki-gen config set model anthropic/claude-3-5-sonnet
```

Override for a single run:

```bash
wiki-gen ./my-project --model anthropic/claude-3-5-sonnet
```

Override via environment variable:

```bash
WIKIGEN_MODEL=anthropic/claude-3-5-sonnet wiki-gen ./my-project
```

Resolution order (first wins):

```text
--model flag  >  WIKIGEN_MODEL env var  >  ~/.wiki-gen/config.json  >  OpenCode default
```

---

## Quick start

```bash
# Markdown output only (no Python needed)
wiki-gen ./my-project

# Full Sphinx site with HTML output
wiki-gen ./my-project \
  --format sphinx \
  --prepare-env \
  --build-site \
  --depth deep \
  --dangerously-skip-permissions
```

Generated output layout:

```text
my-project/
├── _docs_<commit>/
│   ├── source/          Markdown + Sphinx source (.md files)
│   └── _build/html/     Built RTD HTML site
├── _wiki_workspace/
│   ├── recon/           File tree, relationship graph, docgen config
│   └── orchestrate/     CEO strategy brief
├── _wikigen_env/        Python virtualenv (Sphinx + RTD theme)
└── VERSIONS.md          Index of all generated documentation snapshots
```

Each run produces a versioned `_docs_<commit-sha>` directory and appends an entry to `VERSIONS.md`.

---

## CLI reference

### `wiki-gen <target> [options]`

| Flag | Default | Description |
|------|---------|-------------|
| `--format`, `-f` | `markdown` | Output format: `markdown` (raw .md files) or `sphinx` (Sphinx conf + RTD theme) |
| `--depth` | `standard` | Documentation depth: `quick` (overview only), `standard` (thorough), `deep` (exhaustive) |
| `--build-site` | `false` | Build a static HTML site with Sphinx after generation (requires Python) |
| `--prepare-env` | `true` | Bootstrap a Python virtualenv and install Sphinx dependencies |
| `--model`, `-m` | _(config)_ | OpenCode model override in `provider/model` format |
| `--dangerously-skip-permissions` | `false` | Auto-approve all AI permission requests. **Required for unattended runs.** |
| `--targeted-pages` | _(all)_ | Comma-separated list of pages to (re)generate, e.g. `architecture,data-flow` |
| `--concurrency` | `1` | Number of pages to generate in parallel. `1` = sequential (default, safest). Higher values cut wall-clock time on large repos. |
| `--resume` | `false` | Skip pages whose output file already exists — resumes an interrupted run without starting from scratch |
| `--clean` | `false` | Remove `_wiki_workspace/` from the target repo and exit without generating anything |
| `--dry-run` | `false` | Print planned pages with quality targets and exit — no LLM calls made |
| `--serve-port` | `33411` | Port for serving the built docs locally |
| `--serve-only <path>` | — | Serve an existing built HTML directory without regenerating |
| `--output`, `-o` | `_docs` | Output directory (relative to target or absolute) |
| `--deploy <dest>` | — | rsync destination for the built HTML, e.g. `user@host:/var/www/docs/` |
| `--project-slug` | — | Project slug for portal metadata |
| `--python-packages` | — | Extra Python packages to install into the docs virtualenv |
| `--port` | `4096` | Port for the local OpenCode server |
| `--hostname` | `127.0.0.1` | Hostname for the local OpenCode server |
| `--max-versions` | `20` | Maximum `_docs_<sha>` snapshot directories to keep |
| `--watch` | `false` | Continuous watch mode: poll git and regenerate on new commits |
| `--watch-interval` | `30` | Poll interval in seconds for `--watch` mode |
| `--verbose`, `-v` | `false` | Enable verbose logging |

#### `--depth` explained

| Value | Behaviour |
|-------|-----------|
| `quick` | High-level overview pages only. Fast, lower token cost. Good for initial exploration. |
| `standard` | Thorough module-by-module documentation. Recommended for most projects. |
| `deep` | Exhaustive: every function, every relationship, every edge case. Best quality, highest cost. |

#### `--format` explained

| Value | Output |
|-------|--------|
| `markdown` | Raw `.md` files only. No Python required. Viewable on GitHub or any Markdown renderer. |
| `sphinx` | Adds `conf.py`, `index.rst`, custom RTD CSS, sidebar overrides. Required for `--build-site`. |

---

### `wiki-gen update <target> [options]`

Incrementally update existing docs after a git commit range, patching only the pages affected by changed files.

```bash
wiki-gen update ./my-project --from <old-ref> --to HEAD
```

If `--from` is omitted, wiki-gen auto-detects the most recent previous `_docs_<sha>` snapshot directory.

```bash
# With remote deploy
wiki-gen update ./my-project \
  --from <old-ref> \
  --to HEAD \
  --deploy user@host:/var/www/docs/
```

Update pipeline:

1. Copies the previous `_docs_<old>` snapshot to `_docs_<new>`.
2. Reads `git diff <old>..<new>`.
3. Maps changed files to affected documentation pages.
4. Asks OpenCode to patch existing pages in-place rather than rewriting the wiki.
5. Falls back to a deterministic "Recent Changes" diff section if the model fails.
6. Rebuilds Sphinx and optionally rsyncs the site.

---

### `wiki-gen config <action>`

Manage persistent wiki-gen preferences stored in `~/.wiki-gen/config.json`.

```bash
wiki-gen config models                         # List all models from OpenCode config
wiki-gen config set model <provider/model>     # Set default model
wiki-gen config set servePort 8080             # Set default serve port
wiki-gen config get model                      # Print current model
wiki-gen config list                           # Print all settings
```

---

## Watch mode

The `wiki-gen-watch` binary polls git and runs `wiki-gen update` whenever `HEAD` advances.

```bash
wiki-gen-watch ./my-project \
  --interval 60 \
  --deploy user@host:/var/www/docs/
```

---

## Partial regeneration

Regenerate only specific pages without a full run:

```bash
wiki-gen ./my-project \
  --targeted-pages architecture,data-flow \
  --format sphinx \
  --build-site \
  --prepare-env
```

---

## Serving existing docs

Serve a previously built HTML directory without regenerating:

```bash
wiki-gen ./my-project \
  --serve-only ./my-project/_docs_<commit>/_build/html \
  --serve-port 8080
```

---

## Ignore files

Create `.wikigenignore` at the target repo root to exclude files from documentation scanning. It uses gitignore syntax and is applied **on top of** your existing `.gitignore` — you only need to add wiki-gen-specific exclusions.

```gitignore
# .wikigenignore — wiki-gen-specific exclusions only
# Your .gitignore rules are already applied automatically.
_docs*/
_wiki_workspace/
_wikigen_env/
fixtures/
test-data/
*.snap
```

If neither `.wikigenignore` nor `.gitignore` is found, wiki-gen falls back to built-in defaults that exclude `node_modules`, `dist`, `build`, `venv`, `__pycache__`, and other common non-source directories.

---

## Generated documentation pages

Every run produces these standard pages:

| Page | Contents |
|------|----------|
| `index.md` | Project overview and navigation |
| `architecture.md` | System architecture with Mermaid diagrams |
| `data-flow.md` | End-to-end data flow |
| `api-reference.md` | Public interface or endpoint reference |
| `runtime-and-deployment.md` | Runtime constraints, config, deployment |
| `glossary.md` | Domain terms and component names |
| `_wiki_meta.json` | Generation metadata (model, commit, page list) |
| _(8–12 module pages)_ | One deep-dive per major subsystem discovered |

---

## Safety constraints

- Output directories must stay inside the target repository.
- Symlink traversal in output paths is rejected.
- AI agents are only granted write access to `_wiki_workspace/` and the generated docs output directory.
- Documentation scaffolding, Sphinx build, and local serving are deterministic code — not delegated to AI agents.

---

## Requirements

- Node.js >= 18
- OpenCode CLI/SDK-compatible environment with at least one configured model
- Python >= 3.10 for Sphinx builds (auto-detected; only needed with `--build-site`)
- Sphinx dependencies are installed automatically into `_wikigen_env/`

---

## License

MIT
