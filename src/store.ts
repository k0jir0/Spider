import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
} from "@langchain/core/messages";
import type { ToolEvent } from "./tools.js";

export function validateSessionId(session: string): string {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(session)) {
    throw new Error("Session IDs must be 1-64 letters, digits, underscores, or hyphens.");
  }
  return session;
}

export class SessionStore {
  private readonly database: DatabaseSync;

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.database = new DatabaseSync(path.join(directory, "spider.sqlite"));
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, backend TEXT NOT NULL, updated_at TEXT NOT NULL, messages TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, backend TEXT NOT NULL,
        prompt TEXT NOT NULL, started_at TEXT NOT NULL, deadline INTEGER NOT NULL,
        finished_at TEXT, status TEXT NOT NULL, error TEXT, usage TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, status);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, event TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id);
    `);
  }

  private transaction<Result>(action: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  beginRun(session: string, backend: string, prompt: string, timeoutMs: number): string {
    validateSessionId(session);
    return this.transaction(() => {
      const stored = this.database.prepare("SELECT backend FROM sessions WHERE id = ?").get(session);
      if (stored && stored.backend !== backend) {
        throw new Error("This session belongs to a different model or provider. Choose a new --session.");
      }
      const now = Date.now();
      const running = this.database.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' AND deadline > ?")
        .get(session, now);
      if (running) throw new Error("This session already has a running request. Use a different --session.");
      this.database.prepare("UPDATE runs SET status = 'failed', error = 'Run lease expired', finished_at = ? WHERE session_id = ? AND status = 'running'")
        .run(new Date(now).toISOString(), session);
      const runId = randomUUID();
      this.database.prepare("INSERT INTO runs (id, session_id, backend, prompt, started_at, deadline, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
        .run(runId, session, backend, prompt, new Date(now).toISOString(), now + timeoutMs + 30_000);
      return runId;
    });
  }

  history(session: string): BaseMessage[] {
    validateSessionId(session);
    const row = this.database.prepare("SELECT messages FROM sessions WHERE id = ?").get(session);
    return row ? mapStoredMessagesToChatMessages(JSON.parse(String(row.messages)) as StoredMessage[]) : [];
  }

  appendEvent(runId: string, event: ToolEvent): void {
    this.database.prepare("INSERT INTO events (run_id, at, event) VALUES (?, ?, ?)")
      .run(runId, new Date().toISOString(), JSON.stringify(event));
  }

  completeRun(runId: string, messages: BaseMessage[], usage: { inputTokens: number; outputTokens: number }): void {
    this.transaction(() => {
      const row = this.database.prepare("SELECT session_id, backend, status FROM runs WHERE id = ?").get(runId);
      if (!row || row.status !== "running") throw new Error("The run is no longer active.");
      const now = new Date().toISOString();
      this.database.prepare(`INSERT INTO sessions (id, backend, updated_at, messages) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, messages = excluded.messages`)
        .run(String(row.session_id), String(row.backend), now, JSON.stringify(mapChatMessagesToStoredMessages(messages)));
      this.database.prepare("UPDATE runs SET status = 'completed', finished_at = ?, usage = ? WHERE id = ?")
        .run(now, JSON.stringify(usage), runId);
    });
  }

  failRun(runId: string, error: string): void {
    this.database.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ? AND status = 'running'")
      .run(new Date().toISOString(), error.slice(0, 2000), runId);
  }

  sessions() {
    return this.database.prepare("SELECT id, backend, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 50").all();
  }

  runs(session?: string) {
    if (session) validateSessionId(session);
    return session
      ? this.database.prepare("SELECT id, session_id, status, started_at, error, usage FROM runs WHERE session_id = ? ORDER BY started_at DESC LIMIT 50").all(session)
      : this.database.prepare("SELECT id, session_id, status, started_at, error, usage FROM runs ORDER BY started_at DESC LIMIT 50").all();
  }

  events(runId: string) {
    return this.database.prepare("SELECT at, event FROM events WHERE run_id = ? ORDER BY id").all(runId)
      .map((row) => ({ at: String(row.at), ...JSON.parse(String(row.event)) as ToolEvent }));
  }

  close(): void { this.database.close(); }
}