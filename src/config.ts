/**
 * Persistent configuration manager for wiki-gen.
 * Stores user preferences in ~/.wiki-gen/config.json.
 *
 * Model resolution order (first wins):
 *   1. --model CLI flag
 *   2. WIKIGEN_MODEL environment variable
 *   3. ~/.wiki-gen/config.json → model
 *   4. OpenCode SDK default from ~/.config/opencode/opencode.json
 *
 * IMPORTANT: Only models configured in the machine's opencode.json are valid.
 * wiki-gen reads opencode.json to discover available provider/model pairs
 * and rejects anything not configured there.
 */

import path from "node:path"
import fs from "node:fs"
import os from "node:os"

const CONFIG_DIR = path.join(os.homedir(), ".wiki-gen")
const CONFIG_PATH = path.join(CONFIG_DIR, "config.json")

// Standard OpenCode config locations (platform-aware)
const OPENCODE_CONFIG_PATHS = [
  path.join(os.homedir(), ".config", "opencode", "opencode.json"),
  path.join(os.homedir(), ".opencode", "opencode.json"),
]

export interface WikiGenUserConfig {
  /** Default model in provider/model format (e.g. "anthropic/claude-3-5-sonnet") */
  model?: string
  /** Docs serve port */
  servePort?: number
  /** Other future settings */
  [key: string]: unknown
}

export interface AvailableModel {
  /** Full ID in provider/model format */
  id: string
  /** Human-readable name from opencode.json */
  name: string
  /** Provider ID */
  provider: string
  /** Model ID within the provider */
  modelId: string
}

// ── OpenCode config reader ──────────────────────────────────────────────

function findOpencodeConfig(): string | undefined {
  for (const p of OPENCODE_CONFIG_PATHS) {
    if (fs.existsSync(p)) return p
  }
  // Also check current working directory
  const localConf = path.join(process.cwd(), "opencode.json")
  if (fs.existsSync(localConf)) return localConf
  return undefined
}

/**
 * Parse the machine's opencode.json and extract all configured models
 * as provider/model pairs. Returns empty array if config is missing.
 */
export function getAvailableModels(): AvailableModel[] {
  const configPath = findOpencodeConfig()
  if (!configPath) return []

  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    const config = JSON.parse(raw)
    const providers = config?.provider
    if (!providers || typeof providers !== "object") return []

    const models: AvailableModel[] = []
    const disabledProviders = new Set<string>(
      Array.isArray(config.disabled_providers) ? config.disabled_providers : [],
    )

    for (const [providerKey, providerConfig] of Object.entries(providers)) {
      if (disabledProviders.has(providerKey)) continue
      const pConfig = providerConfig as Record<string, unknown>
      const pModels = pConfig.models as Record<string, { name?: string }> | undefined
      if (!pModels || typeof pModels !== "object") continue

      for (const [modelKey, modelConfig] of Object.entries(pModels)) {
        models.push({
          id: `${providerKey}/${modelKey}`,
          name: modelConfig?.name ?? modelKey,
          provider: providerKey,
          modelId: modelKey,
        })
      }
    }

    return models.sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

/**
 * Check if a model string (provider/model) is configured in opencode.json.
 */
export function isModelAvailable(model: string): boolean {
  const available = getAvailableModels()
  return available.some((m) => m.id === model)
}

/**
 * Validate a model string against opencode.json.
 * Throws a descriptive error if the model is not configured.
 */
export function validateModel(model: string): void {
  // Must be in provider/model format
  const parts = model.split("/")
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid model format: "${model}"\n` +
      `Expected format: provider/model (e.g. "anthropic/claude-3-5-sonnet")\n` +
      `Run 'wiki-gen config models' to see available models.`,
    )
  }

  if (!isModelAvailable(model)) {
    const available = getAvailableModels()
    const configPath = findOpencodeConfig()

    if (available.length === 0) {
      throw new Error(
        `Model not configured in OpenCode: "${model}"\n` +
        `No opencode.json found at any standard location.\n` +
        `Configure models in ~/.config/opencode/opencode.json first.`,
      )
    }

    // Find close matches (same provider)
    const provider = parts[0]
    const sameProvider = available.filter((m) => m.provider === provider)

    let hint = ""
    if (sameProvider.length > 0) {
      hint = `\nModels available under "${provider}" provider:\n` +
        sameProvider.map((m) => `  • ${m.id} (${m.name})`).join("\n")
    } else {
      const providers = [...new Set(available.map((m) => m.provider))]
      hint = `\nAvailable providers: ${providers.join(", ")}\n` +
        `Run 'wiki-gen config models' to see all available models.`
    }

    throw new Error(
      `Model not configured in OpenCode: "${model}"\n` +
      `This model was not found in ${configPath ?? "opencode.json"}.${hint}`,
    )
  }
}

/**
 * Print available models in a formatted list.
 */
export function printAvailableModels(): void {
  const models = getAvailableModels()
  const configPath = findOpencodeConfig()

  if (models.length === 0) {
    process.stderr.write("No models found.\n")
    process.stderr.write("Configure models in ~/.config/opencode/opencode.json\n")
    return
  }

  process.stderr.write(`\n  Available Models (from ${configPath})\n`)
  process.stderr.write("  " + "─".repeat(60) + "\n")

  // Group by provider
  const byProvider = new Map<string, AvailableModel[]>()
  for (const m of models) {
    const list = byProvider.get(m.provider) ?? []
    list.push(m)
    byProvider.set(m.provider, list)
  }

  for (const [provider, providerModels] of byProvider) {
    process.stderr.write(`\n  Provider: ${provider}\n`)
    for (const m of providerModels) {
      process.stderr.write(`    ${m.id.padEnd(45)} ${m.name}\n`)
    }
  }

  process.stderr.write("\n  " + "─".repeat(60) + "\n")
  process.stderr.write("  Set a model:   wiki-gen config set model <provider/model>\n")
  process.stderr.write("  Example:       wiki-gen config set model anthropic/claude-3-5-sonnet\n")
  process.stderr.write("  Override once: wiki-gen ./my-project --model anthropic/claude-3-5-sonnet\n")
  process.stderr.write("  Env variable:  WIKIGEN_MODEL=anthropic/claude-3-5-sonnet wiki-gen ./my-project\n\n")
}

// ── User config read/write ──────────────────────────────────────────────

export function readUserConfig(): WikiGenUserConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {}
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8")
    const parsed = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null) return {}
    return parsed as WikiGenUserConfig
  } catch {
    return {}
  }
}

export function writeUserConfig(config: WikiGenUserConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8")
}

/**
 * Set a single config value. Validates model against opencode.json.
 */
export function setConfigValue(key: string, value: string): void {
  // Validate model before persisting
  if (key === "model") {
    validateModel(value)
  }
  if (key === "servePort") {
    const port = Number(value)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid servePort: ${value}. Expected integer 1-65535.`)
    }
    const config = readUserConfig()
    ;(config as Record<string, unknown>)[key] = port
    writeUserConfig(config)
    return
  }
  const config = readUserConfig()
  ;(config as Record<string, unknown>)[key] = value
  writeUserConfig(config)
}

export function getConfigValue(key: string): string | undefined {
  const config = readUserConfig()
  const val = (config as Record<string, unknown>)[key]
  if (typeof val === "string") return val
  if (typeof val === "number") return String(val)
  return undefined
}

export function listConfig(): WikiGenUserConfig {
  return readUserConfig()
}

/**
 * Resolve the effective model, respecting the priority chain:
 *   CLI flag > WIKIGEN_MODEL env var > config file > undefined (let SDK decide)
 *
 * Validates the resolved model against opencode.json at every level.
 */
export function resolveModel(cliModel?: string): string | undefined {
  let resolved: string | undefined

  // 1. CLI flag (highest priority)
  if (cliModel) {
    resolved = cliModel
  }

  // 2. Environment variable
  if (!resolved) {
    const envModel = process.env.WIKIGEN_MODEL
    if (envModel) resolved = envModel
  }

  // 3. Config file
  if (!resolved) {
    const configModel = getConfigValue("model")
    if (configModel) resolved = configModel
  }

  // 4. Let OpenCode SDK use its own default
  if (!resolved) return undefined

  // Validate whatever we resolved
  validateModel(resolved)
  return resolved
}
