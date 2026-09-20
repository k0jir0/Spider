import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

const schema = z.object({
  provider: z.enum(["local", "ollama", "openai", "compatible"]),
  model: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string().min(1),
  workspace: z.string().min(1),
  dataDirectory: z.string().min(1),
  maxSteps: z.coerce.number().int().min(2).max(100),
  timeoutMs: z.coerce.number().int().min(1000).max(600_000),
  maxTokens: z.coerce.number().int().min(64).max(8192),
});

export type Config = z.infer<typeof schema>;
export interface ConfigOverrides {
  provider?: string;
  model?: string;
  workspace?: string;
}

export function readConfig(environment: NodeJS.ProcessEnv, overrides: ConfigOverrides = {}): Config {
  const provider = overrides.provider ?? environment.SPIDER_PROVIDER ?? "local";
  const defaults: Record<string, { model: string; baseUrl: string }> = {
    local: { model: "spider-local", baseUrl: "http://127.0.0.1:8089/v1" },
    ollama: { model: "qwen3:4b", baseUrl: "http://127.0.0.1:11434/v1" },
    openai: { model: "gpt-4.1-mini", baseUrl: "https://api.openai.com/v1" },
    compatible: { model: "", baseUrl: "" },
  };
  const defaultsForProvider = defaults[provider];
  if (!defaultsForProvider) throw new Error("SPIDER_PROVIDER must be local, ollama, openai, or compatible.");
  const apiKey = provider === "local" || provider === "ollama"
    ? "local-no-key"
    : environment.SPIDER_API_KEY || environment.OPENAI_API_KEY || (provider === "compatible" ? "local-no-key" : "");
  if (!apiKey) throw new Error("Set OPENAI_API_KEY in your environment or .env, or use --provider local.");
  const parsed = schema.safeParse({
    provider,
    model: overrides.model ?? environment.SPIDER_MODEL ?? defaultsForProvider.model,
    baseUrl: environment.SPIDER_BASE_URL ?? defaultsForProvider.baseUrl,
    apiKey,
    workspace: path.resolve(projectRoot, overrides.workspace ?? environment.SPIDER_WORKSPACE ?? "workspace"),
    dataDirectory: path.resolve(projectRoot, environment.SPIDER_DATA_DIR ?? ".spider"),
    maxSteps: environment.SPIDER_MAX_STEPS ?? 16,
    timeoutMs: environment.SPIDER_TIMEOUT_MS ?? 120_000,
    maxTokens: environment.SPIDER_MAX_TOKENS ?? 1024,
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const config = parsed.data;
  const url = new URL(config.baseUrl);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!["http:", "https:"].includes(url.protocol) || (url.protocol === "http:" && !loopback)) {
    throw new Error("Model endpoints must use HTTPS, except for local loopback HTTP services.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Model endpoint URLs cannot contain credentials, a query, or a fragment.");
  }
  if (provider === "local" && (!loopback || url.protocol !== "http:" || url.pathname.replace(/\/$/, "") !== "/v1")) {
    throw new Error("The managed local provider requires a loopback HTTP URL ending in /v1.");
  }
  config.baseUrl = config.baseUrl.replace(/\/$/, "");
  const relativeData = path.relative(config.workspace, config.dataDirectory);
  if (relativeData === "" || (!relativeData.startsWith(`..${path.sep}`) && relativeData !== ".." && !path.isAbsolute(relativeData))) {
    throw new Error("SPIDER_DATA_DIR must be outside the agent workspace.");
  }
  return config;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const envPath = path.join(projectRoot, ".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
  return readConfig(process.env, overrides);
}

export function backendIdentity(config: Config): string {
  return JSON.stringify([config.provider, config.baseUrl, config.model]);
}