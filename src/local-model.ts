import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { access, mkdir, readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { projectRoot, type Config } from "./config.js";

const manifestSchema = z.object({ binary: z.string(), modelFile: z.string(), model: z.string() });

export async function checkModel(config: Config, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${config.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Model service returned HTTP ${response.status}. Check its URL and credentials.`);
  const body = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(await response.json());
  if (!body.data.some((model) => model.id === config.model)) {
    throw new Error(`Model '${config.model}' is not available at this endpoint. Download it or set SPIDER_MODEL.`);
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

export async function ensureLocalModel(
  config: Config,
  onStatus: (message: string) => void = () => {},
  signal?: AbortSignal,
): Promise<{ stop: () => Promise<void>; started: boolean }> {
  if (config.provider !== "local") return { stop: async () => {}, started: false };
  const endpoint = new URL(config.baseUrl);
  let existing: Response | undefined;
  try { existing = await fetch(`${endpoint.origin}/health`, { signal: AbortSignal.timeout(1000) }); } catch {}
  if (existing) {
    if (!existing.ok) throw new Error("The local model port is occupied or the server is not ready. Choose another SPIDER_BASE_URL port.");
    await checkModel(config, signal);
    return { stop: async () => {}, started: false };
  }
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The managed runtime supports Windows x64. Use Ollama or an OpenAI-compatible service on this platform.");
  }
  const runtimeRoot = path.join(projectRoot, ".runtime");
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse((await readFile(path.join(runtimeRoot, "local-model.json"), "utf8")).trim()));
  } catch {
    throw new Error("Local model is not installed. Run scripts/setup-local.ps1, or select another --provider.");
  }
  if (manifest.model !== config.model) {
    throw new Error(`The installed local model is '${manifest.model}'. Use that name or select another --provider.`);
  }
  const runtimePath = (relative: string) => {
    const resolved = path.resolve(runtimeRoot, relative);
    const within = path.relative(runtimeRoot, resolved);
    if (!within || within.startsWith("..") || path.isAbsolute(within)) throw new Error("Invalid local runtime manifest path.");
    return resolved;
  };
  const binary = runtimePath(manifest.binary);
  const modelFile = runtimePath(manifest.modelFile);
  await Promise.all([access(binary), access(modelFile), mkdir(config.dataDirectory, { recursive: true })]);
  const logPath = path.join(config.dataDirectory, "llama-server.log");
  const log = openSync(logPath, "a");
  onStatus(`Starting ${path.basename(modelFile)} on CPU...`);
  const child = spawn(binary, [
    "--model", modelFile,
    "--host", endpoint.hostname === "localhost" ? "127.0.0.1" : endpoint.hostname.replace(/[\[\]]/g, ""),
    "--port", endpoint.port || "80",
    "--alias", config.model,
    "--ctx-size", "8192",
    "--parallel", "1",
    "--threads", String(Math.max(1, Math.min(8, availableParallelism() - 1))),
    "--gpu-layers", "0",
    "--jinja",
    "--chat-template-kwargs", JSON.stringify({ enable_thinking: false }),
  ], { stdio: ["ignore", log, log], windowsHide: true });
  closeSync(log);
  let launchError: Error | undefined;
  child.on("error", (error) => { launchError = error; });
  try {
    const startupSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
      : AbortSignal.timeout(60_000);
    for (;;) {
      startupSignal.throwIfAborted();
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw new Error(`Local model exited (${child.exitCode}). See ${logPath}.`);
      let ready = false;
      try {
        ready = (await fetch(`${endpoint.origin}/health`, {
          signal: AbortSignal.any([startupSignal, AbortSignal.timeout(1000)]),
        })).ok;
      } catch {}
      if (ready) break;
      await delay(200, undefined, { signal: startupSignal });
    }
    await checkModel(config, startupSignal);
    return { stop: () => stopChild(child), started: true };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}