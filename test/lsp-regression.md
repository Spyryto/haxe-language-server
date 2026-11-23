# LSP regression and latency smoke test

The `test/lsp-smoke.js` integration test launches the **compiled** Haxe Language Server and a real Haxe compiler. It communicates with the server over LSP (JSON-RPC with Content-Length framing), without VS Code or a mocked compiler.

## Running locally

From the repository root, with Node.js and Haxe on `PATH`:

```sh
npm ci
npx lix run vshaxe-build -t language-server
node test/lsp-smoke.js
```

The `CI` and `CI - Vanilla` workflows also run this test.

## Reproductions

1. The test creates a valid `Main.hx` on disk and opens it over LSP.
2. It changes the **unsaved buffer** to reference an unknown `MissingType`. A diagnostic must appear without writing the file to disk.
3. It restores the valid unsaved buffer. The diagnostic must disappear.
4. It opens `Dep.hx`, changes `Main.hx` to call `Dep.second()`, and checks that the missing-field diagnostic appears.
5. It adds `second()` to the **unsaved** `Dep.hx`. The error in `Main.hx` must clear (the all-open-files mode).
6. It restores `Main.hx` and runs five compiler-backed completion requests. The disk copy of `Main.hx` must remain unchanged throughout.

Before the live-diagnostics change, step 2 will time out because diagnostics were only triggered on save, open, or editor activation. Before the all-open-files clearing fix, step 5 can leave a stale diagnostic in the referring file.

## Metrics

The test prints end-to-end elapsed time from an LSP text change until the corresponding diagnostic is published, plus the median completion latency across five sequential requests. When method timing notifications are available, it also prints median Haxe display round-trip time (queue wait plus compiler processing).

These values are **measurements taken at runtime**, not benchmarks inferred from source code. Record the host OS, Haxe version, Node.js version, build flags, and project size when comparing them. The test deliberately uses a tiny project to prioritize correctness; results should not be extrapolated to a large macro-heavy workspace.

The live-diagnostics debounce currently has a fixed 400 ms delay, so end-to-end diagnostic latency should normally be at least that long. On a busy workspace the compiler and its serial queue can add substantial latency.

## Interpreting failures

- If no completion request succeeds during startup, inspect the language server output and Haxe executable/discovery configuration.
- If `MissingType` never appears, confirm that the compiler receives the unsaved `contents` field.
- If errors never clear, inspect request invalidation and multi-file diagnostic cleanup.
- If the compiler itself reports `Type not found` for a valid on-disk build, isolate the HXML/classpaths and Haxe compiler cache before changing the LSP layer.

On a fork, GitHub Actions may need to be explicitly enabled from the repository's **Actions** tab before any CI runs appear.