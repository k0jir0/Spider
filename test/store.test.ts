import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { SessionStore, validateSessionId } from "../src/store.js";

test("sessions, usage, and tool audit events survive reopening the database", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "spider-store-"));
  let store = new SessionStore(directory);
  try {
    const runId = store.beginRun("example", "local-model", "hello", 1000);
    store.appendEvent(runId, { tool: "calculate", phase: "end", ok: true, output: "42" });
    store.completeRun(runId, [new HumanMessage("hello"), new AIMessage("42")], { inputTokens: 10, outputTokens: 2 });
    store.close();
    store = new SessionStore(directory);
    assert.equal(store.history("example").at(-1)?.content, "42");
    assert.equal(store.history("another").length, 0);
    assert.equal(store.events(runId)[0]?.output, "42");
    assert.equal(store.runs("example")[0]?.status, "completed");
    assert.equal(store.sessions().length, 1);
    assert.throws(() => store.beginRun("example", "cloud-model", "hello", 1000), /different model or provider/);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("simultaneous runs are refused and failures do not replace successful history", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "spider-lock-"));
  const first = new SessionStore(directory);
  const second = new SessionStore(directory);
  try {
    const initial = first.beginRun("example", "local", "first", 1000);
    assert.throws(() => second.beginRun("example", "local", "second", 1000), /already has a running/);
    first.completeRun(initial, [new HumanMessage("first"), new AIMessage("saved")], { inputTokens: 0, outputTokens: 0 });
    const failed = second.beginRun("example", "local", "failed", 1000);
    second.failRun(failed, "test failure");
    assert.equal(first.history("example").at(-1)?.content, "saved");
    assert.ok(first.runs("example").some((run) => run.status === "failed"));
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid session identifiers are rejected", () => {
  for (const session of ["", "../escape", "bad session", "a".repeat(65)]) {
    assert.throws(() => validateSessionId(session), /Session IDs/);
  }
});