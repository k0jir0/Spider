#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import { Command } from "commander";
import { loadConfig, type Config, type ConfigOverrides } from "./config.js";
import { checkModel, ensureLocalModel } from "./local-model.js";
import { messageText, runTask, type RunResult } from "./runner.js";
import { SessionStore, validateSessionId } from "./store.js";
import type { ToolEvent } from "./tools.js";

const program = new Command()
  .name("spider")
  .description("Local-first AI agent with bounded workspace tools and persistent sessions")
  .version("0.1.0")
  .option("--provider <name>", "local, ollama, openai, or compatible")
  .option("--model <name>", "model identifier")
  .option("--workspace <path>", "directory the agent may access")
  .option("--json", "emit machine-readable results on stdout");

type GlobalOptions = ConfigOverrides & { json?: boolean };
type TaskOptions = { session?: string; allowWrite?: boolean };
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
const status = (text: string) => process.stderr.write(`${clean(text)}\n`);
const progress = (event: ToolEvent) => {
  if (event.phase === "start") status(`[tool] ${event.tool}`);
  if (event.phase === "end" && !event.ok) status(`[tool] ${event.tool} returned an error`);
};

function show(result: RunResult): void {
  if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(result));
  else {
    console.log(clean(result.answer));
    status(`Session: ${result.session} | Run: ${result.runId} | Tools: ${result.toolCalls} | ${(result.durationMs / 1000).toFixed(1)}s`);
  }
}

async function withAgent(action: (config: Config, store: SessionStore, signal: AbortSignal) => Promise<void>) {
  const config = loadConfig(program.opts<GlobalOptions>());
  const store = new SessionStore(config.dataDirectory);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  let model: Awaited<ReturnType<typeof ensureLocalModel>> | undefined;
  try {
    model = await ensureLocalModel(config, status, controller.signal);
    await mkdir(config.workspace, { recursive: true });
    await action(config, store, controller.signal);
  } finally {
    await model?.stop();
    store.close();
    process.off("SIGINT", interrupt);
  }
}

function taskOptions(command: Command) {
  return command.option("--session <id>", "continue a named session")
    .option("--allow-write", "allow creating new workspace files, never overwrites");
}

taskOptions(program.command("run <task>").description("Complete one task, then exit"))
  .action(async (task: string, options: TaskOptions) => withAgent(async (config, store, signal) => {
    show(await runTask(config, store, {
      prompt: task, session: options.session ?? randomUUID(), allowWrite: options.allowWrite, signal, onEvent: progress,
    }));
  }));

taskOptions(program.command("demo").description("Run a real model against the bundled sample invoice"))
  .action(async (options: TaskOptions) => withAgent(async (config, store, signal) => {
    const output = `output/invoice-${randomUUID().slice(0, 8)}.txt`;
    const prompt = [
      "Read demo/invoice.json using read_file.",
      "Use calculate to multiply the quantity by unit_price.",
      "Report the customer and total with the exact currency code from the file, not just a dollar symbol.",
      options.allowWrite
        ? `Use write_file to create ${output} with three labeled lines: Customer, Total, and Currency. Fill each with the actual observed customer, calculated total, and exact currency code. Report the saved path.`
        : "",
    ].join(" ");
    show(await runTask(config, store, {
      prompt, session: options.session ?? `demo-${randomUUID().slice(0, 8)}`,
      allowWrite: options.allowWrite, signal, onEvent: progress,
    }));
  }));

taskOptions(program.command("chat").description("Interactive conversation with persistent tool history"))
  .action(async (options: TaskOptions) => {
    if (!process.stdin.isTTY || program.opts<GlobalOptions>().json) {
      throw new Error('Chat requires an interactive terminal without --json. Use run "your task" for automation.');
    }
    await withAgent(async (config, store, signal) => {
      let session = validateSessionId(options.session ?? "default");
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      let closed = false;
      terminal.on("close", () => { closed = true; });
      terminal.on("SIGINT", () => process.emit("SIGINT"));
      status(`Spider | ${config.provider}/${config.model} | session ${session}`);
      status("/exit quits, /new starts a fresh session, /session NAME switches sessions.");
      try {
        while (!closed && !signal.aborted) {
          let prompt: string;
          try { prompt = (await terminal.question("you> ", { signal })).trim(); } catch { break; }
          if (!prompt) continue;
          if (prompt === "/exit" || prompt === "/quit") break;
          if (prompt === "/new") { session = randomUUID(); status(`Session: ${session}`); continue; }
          if (prompt.startsWith("/session ")) {
            try { session = validateSessionId(prompt.slice(9).trim()); status(`Session: ${session}`); }
            catch (error) { status(error instanceof Error ? error.message : String(error)); }
            continue;
          }
          try {
            show(await runTask(config, store, {
              prompt, session, allowWrite: options.allowWrite, signal, onEvent: progress,
            }));
          } catch (error) {
            status(error instanceof Error ? error.message : String(error));
          }
        }
      } finally { terminal.close(); }
    });
  });

program.command("doctor").description("Check configuration, storage, and the selected model service")
  .action(async () => withAgent(async (config, store, signal) => {
    await checkModel(config, signal);
    const result = {
      ok: true, node: process.version, provider: config.provider, model: config.model,
      endpoint: config.baseUrl, workspace: config.workspace, dataDirectory: config.dataDirectory,
      savedSessions: store.sessions().length,
    };
    if (program.opts<GlobalOptions>().json) console.log(JSON.stringify(result));
    else {
      console.log(`Ready: ${result.provider}/${result.model}\nEndpoint: ${result.endpoint}\nWorkspace: ${result.workspace}\nStorage: ${result.dataDirectory}`);
    }
  }));

async function inspectStore(action: (store: SessionStore) => unknown): Promise<void> {
  const store = new SessionStore(loadConfig(program.opts<GlobalOptions>()).dataDirectory);
  try { console.log(clean(JSON.stringify(action(store), null, program.opts<GlobalOptions>().json ? undefined : 2))); }
  finally { store.close(); }
}

program.command("sessions").description("List saved sessions without starting a model")
  .action(() => inspectStore((store) => store.sessions()));
program.command("history <session>").description("Read saved conversation and tool results")
  .action((session: string) => inspectStore((store) => store.history(session).map((message) => ({
    role: message.getType(), text: messageText(message),
    ...(message.getType() === "ai" && "tool_calls" in message ? { toolCalls: message.tool_calls } : {}),
  }))));
program.command("runs").description("List recent completed and failed runs")
  .option("--session <id>", "filter by session")
  .action((options: TaskOptions) => inspectStore((store) => store.runs(options.session)));
program.command("trace <run>").description("Inspect the tool audit trail for a run")
  .action((run: string) => inspectStore((store) => store.events(run)));

try {
  if (process.argv.length === 2) {
    if (process.stdin.isTTY) await program.parseAsync(["node", "spider", "chat"]);
    else program.outputHelp();
  } else await program.parseAsync();
} catch (error) {
  status(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}