# MEMORY.md Full Deprecation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Context:** MEMORY.md is a vestigial file-based memory artifact from the pre-MongoDB era. MongoDB is the sole memory backend. This plan removes all seeding, injection, and references to MEMORY.md from the runtime.

**Goal:** Stop creating, reading, and injecting MEMORY.md so MongoDB is the unambiguous sole memory source. Existing user MEMORY.md files become inert (not deleted).

**Architecture:** Remove MEMORY.md constants, seeding logic, bootstrap injection, system-prompt references, safety guards, and doctor checks. The `memory/` subdirectory and session-memory hook exports remain (those are separate from MEMORY.md). Other bootstrap files (AGENTS.md, SOUL.md, TOOLS.md, HEARTBEAT.md) are unchanged.

**Tech Stack:** TypeScript ESM, Vitest

**Prerequisites:** None (all MongoDB infrastructure already in place)

---

## Relevant Codebase Files

### Production Files to Modify

- `src/agents/workspace.ts` (lines 36-37, 144-145, 181-183, 471-489, 528-531, 560-563, 589) -- MEMORY constants, bootstrap type, resolveMemoryBootstrapEntry, loadWorkspaceBootstrapFiles memory lookup, PRIVATE_MEMORY_BOOTSTRAP_FILES filter
- `src/wizard/onboarding-memory.ts` (lines 2, 380-434) -- MONGODB_MEMORY_SEED constant, customizeWorkspaceForMongoDB MEMORY.md write
- `src/agents/system-prompt.ts` (lines 55-58) -- buildMongoDBBridgeSection MEMORY.md lines
- `src/auto-reply/reply/memory-flush.ts` (lines 14-24, 126-131, 153-161) -- MEMORY_FLUSH_APPEND_ONLY_HINT, MEMORY_FLUSH_READ_ONLY_HINT, MEMORY_FLUSH_REQUIRED_HINTS, ensureMemoryFlushSafetyHints
- `src/memory/internal.ts` (lines 74-87, 119-186, 188-255) -- isMemoryPath, isLegacyMarkdownMemoryPath, listMemoryFiles MEMORY.md lookup, listLegacyMarkdownMemoryFiles
- `src/commands/doctor-workspace.ts` (lines 6-38) -- MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem
- `src/commands/doctor.ts` (lines 63, 370-372) -- shouldSuggestMemorySystem import and call
- `src/cli/memory-cli.ts` (line 13, 829) -- listLegacyMarkdownMemoryFiles import and usage
- `src/agents/tools/memory-tool.ts` (lines 106, 159, 413) -- description strings mentioning MEMORY.md as bridge note
- `src/config/schema.help.ts` (lines 776, 780) -- help text referencing MEMORY.md
- `src/commands/configure.wizard.ts` (line 465) -- "MEMORY.md" in workspace indicators
- `src/gateway/server-methods/agents.ts` (lines 13-14, 64, 308-345) -- MEMORY_FILE_NAMES constant, gateway file-listing API includes MEMORY.md lookup
- `src/agents/prompt-composition-scenarios.ts` (lines 561, 573, 594) -- test fixture scenario content referencing MEMORY.md

### Test Files to Update (13 total — verified by grep)

- `src/agents/workspace.test.ts` -- Tests for MEMORY.md bootstrap loading, PRIVATE_MEMORY filter
- `src/agents/system-prompt-mongodb.test.ts` -- Assertions checking for "MEMORY.md" in prompt
- `src/auto-reply/reply/memory-flush.test.ts` -- Assertion checking MEMORY.md in flush prompt
- `src/memory/internal.test.ts` -- Tests for isMemoryPath (EXISTS — earlier claim of "none" was wrong)
- `src/wizard/onboarding-memory.test.ts` -- Tests for customizeWorkspaceForMongoDB
- `src/wizard/setup.test.ts` -- May reference workspace customization
- `src/auto-reply/reply/reply-state.test.ts` -- 4 assertions: `.toContain("MEMORY.md")` on flush prompt/systemPrompt (lines 207-240)
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts` -- 4 assertions: `.toContain("MEMORY.md")` on flush calls (lines 1691-1821)
- `src/memory/mongodb-watcher.test.ts` -- Expects MEMORY.md in watchPaths array (line 199)
- `src/memory/runtime-write.e2e.test.ts` -- Creates MEMORY.md as test fixture, asserts path in results (lines 572-619)
- `src/agents/tools/memory-tool.citations.test.ts` -- Uses "MEMORY.md" as fixture path in citation test data (lines 31, 55-56, 113)
- `src/auto-reply/reply/agent-runner-memory.dedup.test.ts` -- Comment only (line 5) — NO CHANGE NEEDED
- `src/agents/pi-tools.read.host-edit-recovery.test.ts` -- Creates MEMORY.md as generic test file (line 50) — LIKELY NO CHANGE (file name is incidental)

### Doc Files to Update (content-only changes)

- `docs/reference/memory-config.md`
- `docs/concepts/memory.md`
- `docs/reference/heart-brain-boundary.md`
- `docs/concepts/agent-workspace.md`
- `docs/start/memongo-getting-started.md`
- `docs/reference/templates/AGENTS.md`

### Files NOT Modified (Out of Scope)

- `docs/zh-CN/**` -- Generated; will be rebuilt by i18n pipeline
- `src/hooks/bundled/session-memory/HOOK.md` -- Hook docs, not runtime
- `src/hooks/bundled/bootstrap-extra-files/HOOK.md` -- Hook docs, not runtime
- `src/memory/mongodb-manager.ts` -- **HAS RUNTIME CODE**: watchPaths Set at lines 2025-2026 includes MEMORY.md (moved to Phase 1 Task 1.5)
- `memory/` subdirectory handling -- Stays (session-memory hooks use `memory/*.md` files)

---

## Phase 1: Remove MEMORY.md Constants and Bootstrap Injection

> **Exit Criteria:** New workspaces no longer get MEMORY.md. Existing MEMORY.md files are no longer loaded as bootstrap files. Tests pass.
>
> **IMPORTANT: Tasks 1.1 and 1.4 both modify `src/agents/workspace.ts`. Apply ALL workspace.ts changes (from Tasks 1.1 + 1.4) as a single atomic edit to avoid intermediate build breakage. Do NOT build between these two tasks.**

### Task 1.1: Remove MEMORY.md constants from workspace.ts

**Files:**

- Modify: `src/agents/workspace.ts`

**Changes:**

1. Remove `DEFAULT_MEMORY_FILENAME` export (line 36)
2. Remove `DEFAULT_MEMORY_ALT_FILENAME` export (line 37)
3. Remove both from `WorkspaceBootstrapFileName` type union (lines 144-145)
4. Remove both from `VALID_BOOTSTRAP_NAMES` set (lines 181-182)
5. Remove `PRIVATE_MEMORY_BOOTSTRAP_FILES` set (lines 560-563)
6. Remove `resolveMemoryBootstrapEntry()` function (lines 471-489)
7. Remove the memory entry lookup and push in `loadWorkspaceBootstrapFiles()` (lines 528-531)
8. Remove the `PRIVATE_MEMORY_BOOTSTRAP_FILES` filter in `filterBootstrapFilesForSession()` (line 589)
9. In `ensureAgentWorkspace()`:
   - Line 365: Remove `path.join(dir, DEFAULT_MEMORY_FILENAME)` from the `userContentPaths` array inside `isBrandNewWorkspace`. Keep `path.join(dir, "memory")` and `path.join(dir, ".git")`.
   - Line 423: Remove `path.join(dir, DEFAULT_MEMORY_FILENAME)` from the `indicators` array inside `hasUserContent`. Keep `path.join(dir, "memory")` and `path.join(dir, ".git")`.
   - **Rationale:** MEMORY.md presence alone should NOT prevent a workspace from being treated as "brand new". Only the `memory/` directory (session exports) and `.git` (user project) are meaningful signals.

**Note:** Other files that import `DEFAULT_MEMORY_FILENAME` (like `onboarding-memory.ts`, `doctor-workspace.ts`) will be updated in subsequent tasks.

**Validation:**

```bash
pnpm build
```

Expected: Build passes (some test files may reference removed exports -- those are updated in Phase 2).

### Task 1.2: Remove MEMORY.md seeding from onboarding

**Files:**

- Modify: `src/wizard/onboarding-memory.ts`

**Changes:**

1. Remove `DEFAULT_MEMORY_FILENAME` import from workspace.js (line 2)
2. Remove `MONGODB_MEMORY_SEED` constant (lines 395-403)
3. In `customizeWorkspaceForMongoDB()`: remove the `memoryPath` variable and the entire "MEMORY.md: seed" block (lines 412, 424-433). Keep the AGENTS.md append block.
4. Update the `MONGODB_AGENTS_SECTION` constant: remove the line mentioning MEMORY.md (line 389: `- **MEMORY.md**: Keep as a human-authored bridge note only -- NOT agent-written runtime memory`). Replace with a line stating MongoDB is the sole memory store.

**Validation:**

```bash
pnpm test -- src/wizard/onboarding-memory.test.ts
```

### Task 1.3: Remove MEMORY.md from gateway file-listing API

**Files:**

- Modify: `src/gateway/server-methods/agents.ts`

**Changes:**

1. Remove `DEFAULT_MEMORY_FILENAME` and `DEFAULT_MEMORY_ALT_FILENAME` imports (lines 13-14).
2. Remove `MEMORY_FILE_NAMES` constant (line 64).
3. Remove `...MEMORY_FILE_NAMES` from the `ALLOWED_FILE_NAMES` set (line 66). The set should only contain `...BOOTSTRAP_FILE_NAMES`.
4. Remove the entire MEMORY.md file-listing block in the files-list handler (lines 308-345 approx). This block checks for MEMORY.md, falls back to memory.md, then pushes a missing entry. Remove it entirely -- the gateway file listing should only return bootstrap files.

**Note:** The gateway file-listing API is used by the web UI and potentially other clients. After this change, MEMORY.md will no longer appear in the file list. This is the desired behavior -- MongoDB is the sole memory source, not workspace files.

**Validation:**

```bash
pnpm build
```

### Task 1.4: Remove MEMORY.md from configure wizard workspace detection

**Files:**

- Modify: `src/commands/configure.wizard.ts`

**Changes:**

1. In the workspace indicators array (line 465), remove `"MEMORY.md"` from the list. Keep `"memory"` and `".git"`.

**Validation:**

```bash
pnpm build
```

### Task 1.5: Remove MEMORY.md from mongodb-manager.ts watchPaths

**Files:**

- Modify: `src/memory/mongodb-manager.ts`

**Changes:**

1. In the `watchPaths` Set constructor (lines 2024-2029), remove:
   - `path.join(this.workspaceDir, "MEMORY.md")` (line 2025)
   - `path.join(this.workspaceDir, "memory.md")` (line 2026)
2. Keep `path.join(this.workspaceDir, "memory")` (line 2027) — the `memory/` directory is still valid for session exports.
3. Keep `...this.extraMemoryPaths` (line 2028).

**Validation:**

```bash
pnpm test -- src/memory/mongodb-watcher.test.ts
```

---

## Phase 2: Remove System Prompt and Tool Description References

> **Exit Criteria:** System prompt no longer mentions MEMORY.md. Tool descriptions no longer reference MEMORY.md as bridge note. Tests pass.

### Task 2.1: Clean MEMORY.md from MongoDB bridge section

**Files:**

- Modify: `src/agents/system-prompt.ts`

**Changes:**

1. In `buildMongoDBBridgeSection()` (lines 55-58), remove the two lines:
   - `"- MEMORY.md is retrieval guidance only, not a runtime knowledge store"`
   - `"- Treat MEMORY.md and memory/*.md as human-authored bridge notes, not agent-written durable memory"`

**Validation:**

```bash
pnpm test -- src/agents/system-prompt-mongodb.test.ts
```

### Task 2.2: Clean MEMORY.md from tool descriptions

**Files:**

- Modify: `src/agents/tools/memory-tool.ts`

**Changes:**

1. In `createMemoryWriteTool()` description (line 413): remove the clause `treat MEMORY.md as a human-authored bridge note, not the runtime memory store`. Replace with: `do not write runtime memory to workspace files`.
2. In `createMemorySearchTool()` description (line 106): no MEMORY.md reference found in the current description -- confirm and skip.
3. In `createMemoryGetTool()` description (line 159): no MEMORY.md reference found -- confirm and skip.

**Validation:**

```bash
pnpm test -- src/agents/tools/memory-tool.citations.test.ts
```

### Task 2.3: Clean config schema help text

**Files:**

- Modify: `src/config/schema.help.ts`

**Changes:**

1. Line 776: Change `"Vector search over MEMORY.md and memory/*.md"` to `"MongoDB-backed vector search over runtime memory sources"`.
2. Line 780: Change `'"memory" reads MEMORY.md + memory files'` to `'"memory" reads workspace memory files'` (or remove the now-inaccurate file reference).

**Validation:**

```bash
pnpm build
```

---

## Phase 3: Remove Memory Flush Safety Guards

> **Exit Criteria:** Memory flush prompts no longer contain MEMORY.md-specific safety hints. The `ensureMemoryFlushSafetyHints()` function is simplified. Tests pass.

### Task 3.1: Simplify memory flush safety hints

**Files:**

- Modify: `src/auto-reply/reply/memory-flush.ts`

**Changes:**

1. Remove `MEMORY_FLUSH_APPEND_ONLY_HINT` constant (line 17). This guard existed solely to prevent the LLM from writing to MEMORY.md.
2. Simplify `MEMORY_FLUSH_READ_ONLY_HINT` (line 18-19): change from `"Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only"` to `"Treat workspace bootstrap files (SOUL.md, TOOLS.md, AGENTS.md) as read-only during this flush; never overwrite, replace, or edit them."` (MEMORY.md removed from the list).
3. Remove `MEMORY_FLUSH_APPEND_ONLY_HINT` from `MEMORY_FLUSH_REQUIRED_HINTS` array (line 20-24). Keep the target hint and the simplified read-only hint.
4. Update `DEFAULT_MEMORY_FLUSH_PROMPT` (lines 26-34): remove the `MEMORY_FLUSH_APPEND_ONLY_HINT` line. Remove `"do not overwrite or replace bridge note files."` (line 31) since the read-only hint already covers this.
5. Update `DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT` (lines 36-43): remove the `MEMORY_FLUSH_APPEND_ONLY_HINT` line.
6. The `ensureMemoryFlushSafetyHints()` function (lines 153-161) stays but operates on the reduced `MEMORY_FLUSH_REQUIRED_HINTS` array (now 2 items instead of 3).

**Validation:**

```bash
pnpm test -- src/auto-reply/reply/memory-flush.test.ts
```

---

## Phase 4: Remove Doctor Check and Legacy Internal Functions

> **Exit Criteria:** Doctor no longer suggests MEMORY.md setup. Legacy internal.ts functions cleaned. Memory CLI migrate-markdown still works (uses `memory/` directory files). Tests pass.

### Task 4.1: Remove doctor MEMORY.md suggestion

**Files:**

- Modify: `src/commands/doctor-workspace.ts`
- Modify: `src/commands/doctor.ts`

**Changes in `doctor-workspace.ts`:**

1. Remove `MEMORY_SYSTEM_PROMPT` constant (lines 6-13)
2. Remove `shouldSuggestMemorySystem()` function (lines 15-38)

**Changes in `doctor.ts`:**

1. Remove the import of `MEMORY_SYSTEM_PROMPT` and `shouldSuggestMemorySystem` from `./doctor-workspace.js` (line 63)
2. Remove the block at lines 370-372 that calls `shouldSuggestMemorySystem` and shows the note

**Validation:**

```bash
pnpm test -- src/commands/doctor-memory-search.test.ts
```

### Task 4.2: Clean internal.ts legacy functions

**Files:**

- Modify: `src/memory/internal.ts`

**Changes:**

1. `isMemoryPath()` (lines 74-83): Remove the check for `"MEMORY.md"` and `"memory.md"`. Keep only the `normalized.startsWith("memory/")` check. The function still serves `memory/*.md` subdirectory paths.
2. `listMemoryFiles()` (lines 119-186): Remove the `memoryFile` and `altMemoryFile` variables and their `addMarkdownFile()` calls (lines 125-126, 142-143). Keep the `memoryDir` walk and `extraPaths` handling.
3. `listLegacyMarkdownMemoryFiles()` (lines 188-255): Same treatment -- remove MEMORY.md and memory.md file lookups (lines 193-194, 210-211). Keep `memoryDir` walk and extra paths.

**Behavioral Note:** After this change, `listLegacyMarkdownMemoryFiles()` and `listMemoryFiles()` will no longer find root `MEMORY.md` or `memory.md` files. The `openclaw memory migrate-markdown` CLI command will only import files from the `memory/` subdirectory, NOT root MEMORY.md. This is the intended behavior — root MEMORY.md was never meant to be migrated (it's a human note, not agent memory).

**Validation:**

```bash
pnpm test -- src/memory/internal.test.ts
pnpm test -- src/cli/memory-cli.ts  # migrate-markdown still works for memory/ directory files
```

---

## Phase 5: Update Tests

> **Exit Criteria:** All modified test files pass. No test references MEMORY.md as injected bootstrap content. Full test suite green (modulo pre-existing baseline).

### Task 5.1: Update workspace.test.ts

**Files:**

- Modify: `src/agents/workspace.test.ts`

**Changes:**

1. Remove imports of `DEFAULT_MEMORY_FILENAME` and `DEFAULT_MEMORY_ALT_FILENAME`.
2. Update the `"includes MEMORY.md when present"` test -- remove or convert to a test that confirms MEMORY.md is NOT loaded.
3. Update the `"includes memory.md when MEMORY.md is absent"` test -- remove or convert to confirm memory.md is NOT loaded.
4. Update the `PRIVATE_MEMORY_BOOTSTRAP_FILES` filter test -- remove since the filter no longer exists.
5. Update the mock bootstrap file lists that include `MEMORY.md` entries (line 257).
6. In the legacy detection test that writes MEMORY.md (line 130), change the assertion: the file should still exist (we don't delete it) but `ensureAgentWorkspace` should no longer use it as a detection signal. Update `isBrandNewWorkspace` detection test accordingly -- MEMORY.md presence should NOT trigger legacy detection by itself (only `memory/` directory or `.git` should).

**Validation:**

```bash
pnpm test -- src/agents/workspace.test.ts
```

### Task 5.2: Update system-prompt-mongodb.test.ts

**Files:**

- Modify: `src/agents/system-prompt-mongodb.test.ts`

**Changes:**

1. Line ~15: Change `expect(prompt).toContain("MEMORY.md")` to `expect(prompt).not.toContain("MEMORY.md")`.
2. Line ~110: Change `expect(prompt).toContain("MEMORY.md is retrieval guidance only")` to `expect(prompt).not.toContain("MEMORY.md")`.

**Validation:**

```bash
pnpm test -- src/agents/system-prompt-mongodb.test.ts
```

### Task 5.3: Update memory-flush.test.ts

**Files:**

- Modify: `src/auto-reply/reply/memory-flush.test.ts`

**Changes:**

1. Line ~60: Change `expect(DEFAULT_MEMORY_FLUSH_PROMPT).toContain("MEMORY.md")` to `expect(DEFAULT_MEMORY_FLUSH_PROMPT).not.toContain("MEMORY.md")`.
2. Keep the assertion about "read-only" since the simplified hint still includes read-only guidance.
3. Remove the assertion about "human-authored bridge notes" if that exact phrase was removed from the prompt.

**Validation:**

```bash
pnpm test -- src/auto-reply/reply/memory-flush.test.ts
```

### Task 5.4: Update prompt-composition-scenarios.ts (production fixture file, not a test)

**Files:**

- Modify: `src/agents/prompt-composition-scenarios.ts` (production file that exports test fixture data)

**Changes:**

1. Lines 561, 573, 594: These are test fixture scenario strings that embed "MEMORY.md" in simulated AGENTS.md content and flush prompts. Update to remove MEMORY.md references from the fixture content. The AGENTS.md fixture at line 561 should change `"Read AGENTS.md and MEMORY.md before responding."` to `"Read AGENTS.md before responding."`. The flush prompt fixture at line 573 should be updated to match the new `MEMORY_FLUSH_READ_ONLY_HINT` (without MEMORY.md in the list). The embedded AGENTS.md at line 594 should be updated similarly.

**Validation:**

```bash
pnpm test -- src/agents/prompt-composition-scenarios.ts
```

(This file is imported by test files; run the consuming tests.)

### Task 5.5: Update onboarding-memory.test.ts

**Files:**

- Modify: `src/wizard/onboarding-memory.test.ts`

**Changes:**

1. Remove any tests that assert MEMORY.md file creation by `customizeWorkspaceForMongoDB`.
2. Keep tests for AGENTS.md MongoDB section append (that stays).

**Validation:**

```bash
pnpm test -- src/wizard/onboarding-memory.test.ts
```

### Task 5.6: Update setup.test.ts (if needed)

**Files:**

- Modify: `src/wizard/setup.test.ts`

**Changes:**

1. If any assertions reference MEMORY.md creation during workspace setup, update them.

**Validation:**

```bash
pnpm test -- src/wizard/setup.test.ts
```

### Task 5.7: Update reply-state.test.ts (HIGH — 4 assertions)

**Files:**

- Modify: `src/auto-reply/reply/reply-state.test.ts`

**Changes:**

1. Lines 207, 209, 238, 240: Change `expect(settings?.prompt).toContain("MEMORY.md")` and `expect(settings?.systemPrompt).toContain("MEMORY.md")` to `.not.toContain("MEMORY.md")`.

**Validation:**

```bash
pnpm test -- src/auto-reply/reply/reply-state.test.ts
```

### Task 5.8: Update agent-runner.runreplyagent.e2e.test.ts (HIGH — 4 assertions)

**Files:**

- Modify: `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`

**Changes:**

1. Lines 1691, 1696, 1819, 1821: Change `expect(flushCall?.prompt).toContain("MEMORY.md")` and `expect(flushCall?.extraSystemPrompt).toContain("MEMORY.md")` to `.not.toContain("MEMORY.md")`.

**Validation:**

```bash
pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts
```

### Task 5.9: Update mongodb-watcher.test.ts (HIGH — watchPaths assertion)

**Files:**

- Modify: `src/memory/mongodb-watcher.test.ts`

**Changes:**

1. Line 199: Remove `"/workspace/MEMORY.md"` and `"/workspace/memory.md"` from the `expect.arrayContaining([...])` assertion. Keep `"/workspace/memory"`.

**Validation:**

```bash
pnpm test -- src/memory/mongodb-watcher.test.ts
```

### Task 5.10: Update runtime-write.e2e.test.ts (MEDIUM — fixture paths)

**Files:**

- Modify: `src/memory/runtime-write.e2e.test.ts`

**Changes:**

1. Lines 572, 577: Remove `path.join(workspace, "MEMORY.md")` from test fixtures that create MEMORY.md files for the watcher.
2. Lines 618-619: Remove `expect(results.some((result) => result.path === "MEMORY.md")).toBe(true)` assertions.

**Validation:**

```bash
pnpm test -- src/memory/runtime-write.e2e.test.ts
```

### Task 5.11: Review memory-tool.citations.test.ts (LOW — fixture data)

**Files:**

- Modify: `src/agents/tools/memory-tool.citations.test.ts`

**Changes:**

1. Lines 31, 55-56, 113: These use `"MEMORY.md"` as a fixture path in citation test data. This is test fixture data (mocking what MongoDB search returns), NOT runtime behavior. **Consider keeping as-is** — the citation paths are valid historical data. OR replace with another file path like `"memory/2026-03-01.md"` for consistency.

**Validation:**

```bash
pnpm test -- src/agents/tools/memory-tool.citations.test.ts
```

### Task 5.12: Verify no-change files

**Files that contain MEMORY.md but need NO changes:**

- `src/auto-reply/reply/agent-runner-memory.dedup.test.ts` — Comment only (line 5), no assertion
- `src/agents/pi-tools.read.host-edit-recovery.test.ts` — Generic test file creation (line 50), filename incidental

**Validation:** Run both to confirm they still pass:

```bash
pnpm test -- src/auto-reply/reply/agent-runner-memory.dedup.test.ts
pnpm test -- src/agents/pi-tools.read.host-edit-recovery.test.ts
```

---

## Phase 6: Update Documentation

> **Exit Criteria:** Docs no longer describe MEMORY.md as part of the memory system. MongoDB is presented as the sole memory store.

### Task 6.1: Update core memory docs

**Files:**

- Modify: `docs/reference/memory-config.md`
- Modify: `docs/concepts/memory.md`
- Modify: `docs/reference/heart-brain-boundary.md`
- Modify: `docs/concepts/agent-workspace.md`

**Changes:**

1. Remove references to MEMORY.md as a memory source.
2. Clarify that MongoDB is the sole runtime memory backend.
3. Keep mentions of `memory/` subdirectory if they refer to session-memory hook logs.
4. In agent-workspace.md, remove MEMORY.md from the list of workspace bootstrap files.

### Task 6.2: Update getting-started and templates

**Files:**

- Modify: `docs/start/memongo-getting-started.md`
- Modify: `docs/reference/templates/AGENTS.md`

**Changes:**

1. Remove instructions to create or edit MEMORY.md.
2. Update AGENTS.md template to remove MEMORY.md references.

**Validation:**

```bash
pnpm build  # Ensure docs compile
```

---

## Phase 7: Final Validation

> **Exit Criteria:** Full test suite passes. Build passes. No MEMORY.md references in production code (docs/test files may retain historical context).

### Task 7.1: Full regression run

**Steps:**

1. Run full test suite:

```bash
pnpm test
```

Expected: All tests pass (modulo pre-existing baseline failures).

2. Run build:

```bash
pnpm build
```

Expected: Exit 0.

3. Run lint/format:

```bash
pnpm check
```

Expected: Clean (modulo pre-existing).

4. Verify no stale MEMORY.md references in production code:

```bash
grep -r "MEMORY\.md" src/ --include="*.ts" -l | grep -v test | grep -v ".test." | grep -v "prompt-composition-scenarios"
```

Expected: Zero matches (or only in non-actionable comments).

---

## Risks

| Risk                                                   | P   | I   | Score | Mitigation                                                                                            |
| ------------------------------------------------------ | --- | --- | ----- | ----------------------------------------------------------------------------------------------------- |
| Breaking import in downstream consumer                 | 2   | 3   | 6     | `DEFAULT_MEMORY_FILENAME` was exported but unlikely consumed externally; Memongo is the only consumer |
| Existing MEMORY.md in user workspaces causes confusion | 2   | 2   | 4     | File becomes inert; `migrate-markdown` CLI command still available to import content to MongoDB       |
| Test assertions on MEMORY.md in prompt composition     | 3   | 2   | 6     | Phase 5 systematically updates all test assertions                                                    |
| `memory/` subdirectory files stop being indexed        | 1   | 4   | 4     | Explicitly preserved in internal.ts; only MEMORY.md root file removed                                 |

---

## Success Criteria

- [ ] `pnpm build` passes
- [ ] `pnpm test` passes (modulo pre-existing baseline)
- [ ] `pnpm check` clean (modulo pre-existing)
- [ ] Zero production .ts files reference MEMORY.md as an active runtime artifact
- [ ] New workspaces get no MEMORY.md file
- [ ] Existing MEMORY.md files remain on disk (not deleted)
- [ ] `memory/` subdirectory session-memory still works
- [ ] `openclaw memory migrate-markdown` still imports `memory/*.md` files
- [ ] System prompt contains zero MEMORY.md mentions
- [ ] Doctor does not suggest MEMORY.md setup
