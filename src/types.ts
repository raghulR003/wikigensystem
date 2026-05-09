/** Core types for wiki-gen */

export interface WikiGenConfig {
  /** Operation mode */
  mode?: "generate" | "update"
  /** Target repository path */
  target: string
  /** Output directory */
  output: string
  /** Documentation depth */
  depth: "quick" | "standard" | "deep"
  /** Export format */
  format: "markdown" | "sphinx"
  /** Whether to attempt a site build */
  buildSite: boolean
  /** Whether to prepare Python env for Sphinx */
  prepareEnv: boolean
  /** OpenCode model override (format: provider/model). Uses OpenCode config default if not set. */
  model?: string
  /** OpenCode server port */
  port: number
  /** OpenCode server hostname */
  hostname: string
  /** Extra Python packages for docs build */
  pythonPackages?: string[]
  /** Skip permission prompts */
  skipPermissions: boolean
  /** Verbose logging */
  verbose: boolean
  /** Max versioned snapshot directories */
  maxVersions: number
  /** Watch mode: poll git and regenerate on commits */
  watch: boolean
  /** Watch poll interval in seconds */
  watchInterval: number
  /** Targeted page list for partial regeneration */
  targetedPages?: string[]
  /** Port for serving the built documentation site */
  servePort: number
  /** Serve an existing built Sphinx HTML directory without regenerating docs */
  serveOnly?: string
  /** Incremental update base commit/ref */
  updateFrom?: string
  /** Incremental update target commit/ref */
  updateTo?: string
  /** Optional rsync destination for built HTML */
  deployPath?: string
  /** Optional project slug/metadata for portal deployment */
  projectSlug?: string
  /** Max parallel page-generation sessions (default: 1) */
  concurrency: number
  /** Skip pages whose output file already exists — resume a previously interrupted run */
  resume: boolean
  /** Remove _wiki_workspace/ from the target repo and exit */
  clean: boolean
  /** Print planned pages and exit without calling the LLM */
  dryRun: boolean
}

export interface ScanResult {
  /** Absolute path to target */
  root: string
  /** Relative file paths (forward-slash) */
  files: string[]
  /** Top-level directories */
  topLevel: string[]
  /** Total file count */
  count: number
  /** Ignored file count */
  ignored: number
  /** Complexity tier */
  complexity: "low" | "medium" | "high" | "enterprise"
  /** Recommended agent count */
  recommendedAgents: number
  /** Languages detected */
  languages: string[]
  /** Estimated total lines of source code */
  totalLines: number
}

export interface PipelinePhase {
  name: string
  status: "pending" | "running" | "completed" | "failed"
  startedAt?: number
  completedAt?: number
  error?: string
}

export interface PipelineState {
  phases: PipelinePhase[]
  currentPhase: number
  startTime: number
  sessionId?: string
  errors: string[]
}

export interface WikiGenResult {
  success: boolean
  outputDir: string
  pagesGenerated: number
  duration: number
  errors: string[]
  buildOutput?: string
}
