# Verification

Verified on Windows x64 on 2026-09-19, using the actual project-local runtime.

| Gate | Observed result |
| --- | --- |
| `setup.cmd --skip-model` | Locked dependency installation and TypeScript build completed; npm reported zero vulnerabilities |
| `spider.cmd --help` | Listed all CLI commands through the Windows launcher |
| `doctor --json` | Started local inference, verified the selected model, and opened SQLite storage |
| Offline regression suite | 22 tests passed, zero failed or skipped |
| Real-model smoke check | Passed ordered tool execution, correct file contents, cross-process recall, and owned-server cleanup |

## Live Model Evidence

- Node.js: `v22.23.2`.
- llama.cpp: `b10964`, official Windows x64 CPU build.
- Model: `Qwen/Qwen3-1.7B-GGUF`, `Qwen3-1.7B-Q8_0.gguf`.
- Model revision: `90862c4b9d2787eaed51d12237eafdfe7c5f6077`.
- Successful run: `7c2883bd-e31d-4f7f-a456-6aa11c3c9697`.
- Tool trace: read the invoice, multiply `[37, 19]`, reread the invoice, then create the report. The calculation returned `703`; there were no tool errors.
- File contents: `Customer: Local Workshop`, `Total: 703`, `Currency: CAD`.
- Task duration: approximately 41 seconds, excluding model startup.
- A separate CLI process reopened the session and recalled `Local Workshop` and `703` without tools, in approximately 19 seconds excluding startup.
- The model process started by the CLI was confirmed stopped afterward.

The detailed machine-readable report is generated at `.spider/verification.json`. Smoke-test files and sessions are isolated in a temporary directory and removed after the report is saved. Run `npm run smoke` to repeat the check; timings and model decisions can vary.

## Coverage And Limits

Offline tests cover the model/tool protocol, numerical operations, read/write limits, traversal and junction rejection, write opt-in and no-overwrite behavior, configuration validation, durable session storage, concurrent session leases, provider failures, graph limits, timeout/cancellation, whole-turn context trimming, and CLI JSON output.

The test suite uses a scripted HTTP model for deterministic cases; the live smoke check uses actual model weights and no cloud API. An earlier 0.6B candidate failed correctness and was replaced, as recorded in [RESEARCH.md](RESEARCH.md).

OpenAI, Ollama, and arbitrary compatible external services were not live-tested because no credentials or external service were configured. Interactive Ctrl+C is wired to the same tested cancellation mechanism, but terminal keypress automation was not performed. The application is not an OS-level sandbox, and a successful finite smoke test does not guarantee arbitrary model answers are correct.