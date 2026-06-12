import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

const NAME = "opencode-auto-models"
const TIMEOUT_MS = 10_000
const LOG_PATH = join(homedir(), ".config", "opencode", `${NAME}.log`)
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json")
const MODELS_DEV_URL = "https://models.dev/models.json"

interface ModelsMap {
  [id: string]: ModelConfig
}

interface ModelConfig {
  id?: string
  name?: string
  family?: string
  release_date?: string
  attachment?: boolean
  reasoning?: boolean
  temperature?: boolean
  tool_call?: boolean
  limit?: { context: number; output: number; input?: number }
  modalities?: { input?: string[]; output?: string[] }
  cost?: {
    input: number
    output: number
    cache_read?: number
    cache_write?: number
  }
  status?: "alpha" | "beta" | "deprecated" | "active"
}

interface ProviderConf {
  id: string
  name: string
  baseURL: string
  apiKey?: string
}

interface PluginOpts {
  providers?: ProviderConf[]
}

interface AuthEntry {
  type: string
  key?: string
}

function log(level: "INFO" | "WARN" | "ERROR", msg: string, ...rest: unknown[]) {
  const dir = dirname(LOG_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const line = `[${new Date().toISOString()}] [${level}] [${NAME}] ${msg}${rest.length ? " " + rest.map((x) => JSON.stringify(x)).join(" ") : ""}`
  try {
    appendFileSync(LOG_PATH, line + "\n")
  } catch {}
  if (level === "ERROR") console.error(line)
  else if (level === "WARN") console.warn(line)
}

function readAuthKeys(path = AUTH_PATH): Record<string, string> {
  try {
    if (!existsSync(path)) return {}
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, AuthEntry>
    const keys: Record<string, string> = {}
    for (const [id, entry] of Object.entries(data)) {
      if (entry?.type === "api" && entry.key) keys[id] = entry.key
    }
    if (Object.keys(keys).length) log("INFO", `found ${Object.keys(keys).length} API keys in ${path} (${Object.keys(keys).join(", ")})`)
    return keys
  } catch (e) {
    log("WARN", `failed to read auth file ${path}: ${e instanceof Error ? e.message : e}`)
    return {}
  }
}

async function fetchJson(url: string, headers: Record<string, string> = {}) {
  const ac = new AbortController()
  const tid = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { headers, signal: ac.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(tid)
  }
}

async function getModelsDevIndex() {
  try {
    const data = await fetchJson(MODELS_DEV_URL) as Record<string, ModelConfig>
    log("INFO", `loaded ${Object.keys(data).length} models from models.dev`)
    return data
  } catch (e) {
    log("WARN", `failed to load models.dev metadata: ${e instanceof Error ? e.message : e}`)
    return {}
  }
}

function normalizeModelID(id: string) {
  return id.toLowerCase().replace(/^models\//, "")
}

function findModelsDevMeta(id: string, index: Record<string, ModelConfig>) {
  if (index[id]) return index[id]
  const normalized = normalizeModelID(id)
  for (const [key, value] of Object.entries(index)) {
    if (normalizeModelID(key) === normalized || normalizeModelID(value.id || "") === normalized) return value
  }
  return undefined
}

function num(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function bool(value: unknown) {
  return typeof value === "boolean" ? value : undefined
}

function buildModelConfig(raw: Record<string, unknown>, modelsDev?: ModelConfig): ModelConfig {
  const id = String(raw.id)
  const supported = Array.isArray(raw.supported_parameters) ? raw.supported_parameters.map(String) : []
  const architecture = typeof raw.architecture === "object" && raw.architecture ? raw.architecture as Record<string, unknown> : {}
  const pricing = typeof raw.pricing === "object" && raw.pricing ? raw.pricing as Record<string, unknown> : {}
  const inputModalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities.map(String) : undefined
  const outputModalities = Array.isArray(architecture.output_modalities) ? architecture.output_modalities.map(String) : undefined
  const context = num(raw.context_length) ?? num(raw.max_context_length) ?? num(raw.context_window) ?? modelsDev?.limit?.context
  const output = num(raw.max_output_tokens) ?? num(raw.max_completion_tokens) ?? modelsDev?.limit?.output ?? 4096
  const inputCost = num(pricing.prompt) ?? num(pricing.input) ?? modelsDev?.cost?.input
  const outputCost = num(pricing.completion) ?? num(pricing.output) ?? modelsDev?.cost?.output
  const reasoning = bool(raw.reasoning) ?? bool(raw.supports_reasoning) ?? (supported.includes("reasoning") || modelsDev?.reasoning)
  const toolCall = bool(raw.tool_call) ?? bool(raw.supports_tool_calls) ?? (supported.includes("tools") || supported.includes("tool_choice") || modelsDev?.tool_call) ?? true
  const temperature = bool(raw.temperature) ?? (supported.includes("temperature") || modelsDev?.temperature)

  const model: ModelConfig = {
    ...modelsDev,
    id,
    name: modelsDev?.name || String(raw.name || id),
    reasoning,
    tool_call: toolCall,
    temperature,
    attachment: bool(raw.attachment) ?? modelsDev?.attachment,
    status: modelsDev?.status || "active",
  }

  if (context) model.limit = { context, output }
  else if (modelsDev?.limit) model.limit = modelsDev.limit
  if (inputModalities || outputModalities || modelsDev?.modalities) {
    model.modalities = {
      input: inputModalities || modelsDev?.modalities?.input || ["text"],
      output: outputModalities || modelsDev?.modalities?.output || ["text"],
    }
  }
  if (inputCost !== undefined && outputCost !== undefined) model.cost = { input: inputCost, output: outputCost }
  return model
}

async function getModels(baseURL: string, apiKey: string | undefined, modelsDev: Record<string, ModelConfig>): Promise<ModelsMap> {
  const norm = baseURL.replace(/\/+$/, "")
  const url = norm.endsWith("/models") ? norm : `${norm}/models`
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const body = await fetchJson(url, headers) as { data?: Record<string, unknown>[] }
  if (!Array.isArray(body?.data)) throw new Error("missing data array")

  const out: ModelsMap = {}
  for (const raw of body.data) {
    if (!raw?.id) continue
    const id = String(raw.id)
    out[id] = buildModelConfig(raw, findModelsDevMeta(id, modelsDev))
  }
  return out
}

function buildCfg(p: ProviderConf, models: ModelsMap) {
  const c: Record<string, unknown> = {
    npm: "@ai-sdk/openai-compatible",
    name: p.name,
    options: { baseURL: p.baseURL },
    models,
  }
  if (p.apiKey) (c.options as Record<string, string>).apiKey = p.apiKey
  return c
}

const plugin: Plugin = async (_ctx, raw) => {
  const rawOptions = raw as unknown as PluginOpts | undefined
  const authKeys = readAuthKeys()
  const providers: ProviderConf[] = []

  if (rawOptions && typeof rawOptions === "object" && Array.isArray(rawOptions.providers)) {
    for (const p of rawOptions.providers) {
      if (p && typeof p.id === "string" && typeof p.name === "string" && typeof p.baseURL === "string") {
        providers.push({ id: p.id, name: p.name, baseURL: p.baseURL, apiKey: p.apiKey || authKeys[p.id] })
      } else log("WARN", "skipping invalid provider entry", p)
    }
  }

  log("INFO", `configured providers: ${providers.map((p) => p.id).join(", ") || "(none)"}`)

  const modelsDev = await getModelsDevIndex()
  const ok = new Map<string, ModelsMap>()

  await Promise.allSettled(providers.map(async (p) => {
    try {
      const models = await getModels(p.baseURL, p.apiKey, modelsDev)
      const ids = Object.keys(models)
      if (!ids.length) log("WARN", `${p.id}: returned empty model list`)
      else {
        ok.set(p.id, models)
        const enriched = ids.filter((id) => Boolean(models[id].limit || models[id].modalities || models[id].reasoning !== undefined)).length
        log("INFO", `${p.id}: discovered ${ids.length} models (${enriched} with metadata)`)
      }
    } catch (e) {
      log("ERROR", `${p.id}: ${e instanceof Error ? e.message : e}`)
    }
  }))

  if (!ok.size && providers.length) log("WARN", "all providers failed - no models discovered")

  return {
    config: async (cfg: Record<string, unknown>) => {
      for (const p of providers) {
        const models = ok.get(p.id)
        if (!models) continue
        cfg.provider ??= {}
        ;(cfg.provider as Record<string, unknown>)[p.id] = buildCfg(p, models)
        log("INFO", `injected provider "${p.id}" with ${Object.keys(models).length} models`)
      }
    },

    tool: {
      discover_models: tool({
        description: "Discover models from an OpenAI-compatible API endpoint. Returns model list and ready-to-use config snippet.",
        args: {
          providerId: tool.schema.string().describe("Provider identifier, e.g. my-ollama"),
          providerName: tool.schema.string().describe("Display name, e.g. My Ollama"),
          baseURL: tool.schema.string().describe("API base URL, e.g. http://localhost:11434/v1"),
          apiKey: tool.schema.string().optional().describe("API key if required"),
        },
        async execute(args) {
          const models = await getModels(args.baseURL, args.apiKey, await getModelsDevIndex())
          return `Discovered ${Object.keys(models).length} models:\n${Object.entries(models).map(([id, meta]) => `- ${id}${meta.limit?.context ? ` (${meta.limit.context} ctx)` : ""}`).join("\n")}`
        },
      }),
    },
  }
}

export default plugin
