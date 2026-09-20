import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { projectRoot, readConfig } from "../src/config.js";
import { recentHistory, runTask } from "../src/runner.js";
import { SessionStore } from "../src/store.js";

async function fixture(context: TestContext, behavior: "normal" | "loop" | "failure" | "timeout" = "normal") {
  const root = await mkdtemp(path.join(tmpdir(), "spider-runner-"));
  const requests: { parallel_tool_calls: boolean; messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    const bodyChunks: Buffer[] = [];
    for await (const chunk of request) bodyChunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(bodyChunks).toString()) as typeof requests[number];
    requests.push(body);
    response.setHeader("content-type", "application/json");
    if (behavior === "timeout") return;
    if (behavior === "failure") {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: { message: "Test provider unavailable", type: "server_error" } }));
      return;
    }
    const last = body.messages.at(-1);
    const finish = last?.role === "tool" && behavior !== "loop";
    response.end(JSON.stringify({
      id: `request-${requests.length}`, object: "chat.completion", created: 1, model: "fixture",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      choices: [{
        index: 0, finish_reason: finish ? "stop" : "tool_calls",
        message: finish ? { role: "assistant", content: "The checked total is 703 CAD." } : {
          role: "assistant", content: null,
          tool_calls: [{
            id: `call-${requests.length}`, type: "function",
            function: { name: "calculate", arguments: '{"operation":"multiply","numbers":[37,19]}' },
          }],
        },
      }],
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const environment = {
    SPIDER_PROVIDER: "compatible", SPIDER_MODEL: "fixture", SPIDER_API_KEY: "test-only",
    SPIDER_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    SPIDER_WORKSPACE: path.join(root, "workspace"), SPIDER_DATA_DIR: path.join(root, "data"),
    SPIDER_MAX_STEPS: "6", SPIDER_TIMEOUT_MS: behavior === "timeout" ? "1000" : "10000",
  };
  const config = readConfig(environment);
  const store = new SessionStore(config.dataDirectory);
  context.after(async () => {
    store.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  return { config, store, requests, environment };
}

test("runner records real tool results, usage, and complete conversation history", async (context) => {
  const { config, store, requests } = await fixture(context);
  const first = await runTask(config, store, { prompt: "Calculate the total.", session: "test" });
  assert.equal(first.toolCalls, 1);
  assert.equal(first.toolErrors, 0);
  assert.deepEqual(first.usage, { inputTokens: 20, outputTokens: 10 });
  assert.equal(store.history("test").length, 4);
  assert.equal(JSON.parse(store.events(first.runId)[1]!.output!).result, 703);
  assert.ok(requests.every((request) => request.parallel_tool_calls === false));
  await runTask(config, store, { prompt: "Calculate it again.", session: "test" });
  assert.equal(store.history("test").length, 8);
  assert.equal(requests[2]?.messages.filter((message) => message.role === "user").length, 2);
});

for (const behavior of ["loop", "failure", "timeout"] as const) {
  test(`runner stops on ${behavior} and records failure without saving partial history`, async (context) => {
    const { config, store } = await fixture(context, behavior);
    await assert.rejects(runTask(config, store, { prompt: "Do the task.", session: "failed" }));
    assert.equal(store.runs("failed")[0]?.status, "failed");
    assert.equal(store.history("failed").length, 0);
  });
}

test("an already-cancelled request does not call the model", async (context) => {
  const { config, store, requests } = await fixture(context);
  await assert.rejects(runTask(config, store, {
    prompt: "Do the task.", session: "cancelled", signal: AbortSignal.abort(),
  }), /cancelled or timed out/);
  assert.equal(requests.length, 0);
  assert.equal(store.runs("cancelled")[0]?.status, "failed");
});

test("CLI JSON output is parseable and sessions survive a separate process", async (context) => {
  const { store, environment } = await fixture(context);
  const result = await promisify(execFile)(process.execPath, [
    path.join(projectRoot, "dist/src/cli.js"), "run", "Calculate the total.", "--session", "cli-test", "--json",
  ], { env: { ...process.env, ...environment }, timeout: 20_000 });
  const output = JSON.parse(result.stdout) as { answer: string; toolCalls: number };
  assert.match(output.answer, /703/);
  assert.equal(output.toolCalls, 1);
  assert.equal(store.history("cli-test").length, 4);
});

test("history trimming keeps whole turns and their tool call/result pairs", () => {
  const messages = Array.from({ length: 6 }, (_, index) => [
    new HumanMessage(`turn ${index}`),
    new AIMessage({ content: "", tool_calls: [{ id: String(index), name: "calculate", args: {} }] }),
    new ToolMessage({ content: "42", tool_call_id: String(index) }),
    new AIMessage("42"),
  ]).flat();
  const recent = recentHistory(messages);
  assert.equal(recent.length, 16);
  assert.equal(recent[0]?.content, "turn 2");
  assert.equal(recent[0]?.getType(), "human");
});