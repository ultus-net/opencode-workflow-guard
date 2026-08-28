# Title Settle Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Workflow Guard's title-settle behavior enabled by default while preserving `titleSettleWorkaround: false` as an explicit opt-out.

**Architecture:** Treat the missing setting consistently as enabled at both consumers: the continuation server hook and TUI project-option reader. Keep the existing bounded title-settle implementation unchanged; only its effective default changes.

**Tech Stack:** TypeScript, OpenCode TUI plugin API, Node test harness, jsonc-parser.

---

### Task 1: Lock Down Default And Opt-Out Semantics

**Files:**
- Modify: `test/test.mts:1140-1155,2835-2860`

- [ ] **Step 1: Change the TUI regression to expect title settling on without configuration**

Before selecting the title-settle option, assert the missing setting reads as enabled. Then select its option callback and assert the persisted effective value becomes false:

```ts
registeredTuiCommands.find((command) => command.name === "workflow-guard.project-options")?.run?.();
check("title settle workaround project option defaults on", readProjectOption(tuiCommandOptionsDir, "titleSettleWorkaround") === true);
tuiDialogSelectProps?.options?.find((option: any) => option.value === "titleSettleWorkaround")?.onSelect?.(fakeTuiApi.ui.dialog);
check("tui project-options command can disable title settle workaround", readProjectOption(tuiCommandOptionsDir, "titleSettleWorkaround") === false);
```

- [ ] **Step 2: Change continuation regressions to cover default-on and explicit opt-out**

Use the existing title-settle continuation fixture around line 2844. Remove the requirement to write `{ titleSettleWorkaround: true }` for the positive case, and add a sibling case/fixture with `{ titleSettleWorkaround: false }` proving continuation does not wait for title settling when explicitly disabled. Preserve the existing assertions that title generation remains native and the wait remains bounded.

- [ ] **Step 3: Run the unit harness to verify the new expectations fail**

Run: `npm test`

Expected: the new default-on assertions fail against current production code while unrelated checks remain green.

### Task 2: Implement Enabled-Unless-False Semantics

**Files:**
- Modify: `src/workflow-guard-ui.ts:36-43`
- Modify: `src/workflow-guard.ts:672`

- [ ] **Step 1: Make the TUI reader default title settling to enabled**

Update `readProjectOption` so both project memory and title settling are enabled unless explicitly false, while the other opt-in settings remain enabled only by explicit true:

```ts
const enabledByDefault = option === "projectMemory" || option === "titleSettleWorkaround";
if (!existsSync(path)) return enabledByDefault;
// parse existing config as before
return enabledByDefault ? config?.[option] !== false : config?.[option] === true;
```

- [ ] **Step 2: Make continuation use the same effective default**

Change the title-settle gate in `src/workflow-guard.ts` from:

```ts
const settleTitle = getProjectConfig(effectiveRoot).titleSettleWorkaround === true;
```

to:

```ts
const settleTitle = getProjectConfig(effectiveRoot).titleSettleWorkaround !== false;
```

- [ ] **Step 3: Run the unit harness**

Run: `npm test`

Expected: all checks pass, including default-enabled and explicit-false regressions.

### Task 3: Document The New Default

**Files:**
- Modify: `docs/installation.md:103`
- Modify: `docs/policies.md:86`
- Modify: `.changeset/fix-project-option-toggles.md`

- [ ] **Step 1: Update installation guidance**

Replace the statement that title settling is off by default with text stating that it is on by default because Workflow Guard's automatic continuation can race OpenCode title generation, and that projects may opt out with `titleSettleWorkaround: false`.

- [ ] **Step 2: Update policy documentation**

Describe title settling as the default continuation behavior rather than opt-in behavior. Retain the guarantees that the wait is bounded and does not rewrite titles or provider/model parameters.

- [ ] **Step 3: Expand the existing patch changeset**

Make `.changeset/fix-project-option-toggles.md` mention both user-visible changes: functioning TUI toggles and title settling enabled by default with explicit opt-out.

### Task 4: Verify The Final Tree

**Files:**
- Verify only

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 2: Run the full unit/adversarial harness**

Run: `npm test`

Expected: all checks pass with 0 failures.

- [ ] **Step 3: Run packaged installation verification**

Run: `npm run test:install`

Expected: all non-model-driven installation/runtime checks pass with 0 failures.

- [ ] **Step 4: Check the diff**

Run: `git diff --check`

Expected: exit 0 with no whitespace errors.
