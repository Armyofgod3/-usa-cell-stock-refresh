import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/mobile-sentrix-import.yml", import.meta.url),
  "utf8",
);

test("six-hour schedule is polling-only until the persisted Admin permission is enabled", () => {
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.match(workflow, /^  schedule:/m);
  assert.match(workflow, /cron: "17 \*\/6 \* \* \*"/);
  assert.doesNotMatch(workflow, /workflow_run:|repository_dispatch:|push:/);
  assert.match(workflow, /run_worker:[\s\S]*?default: false/);
  assert.match(workflow, /run_scheduled_refresh:[\s\S]*?default: false/);
  assert.match(workflow, /github\.event_name == 'schedule'/);
  assert.match(workflow, /inputs\.run_worker == true/);
  assert.match(workflow, /inputs\.run_scheduled_refresh == true/);
  assert.match(workflow, /inputs\.run_worker != inputs\.run_scheduled_refresh/);
  assert.match(workflow, /github\.event\.repository\.default_branch/);
  assert.match(workflow, /--scheduled-refresh/);
});

test("workflow has bounded, serialized, read-only execution", () => {
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /group: mobilesentrix-full-catalog/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /execute-worker:[\s\S]*?timeout-minutes: 150/);
  assert.match(workflow, /validate-caller:[\s\S]*?timeout-minutes: 4/);
  assert.match(workflow, /environment:\s*\n\s*name: mobilesentrix-production/);
  assert.match(workflow, /inputs\.run_worker == true/);
  assert.match(workflow, /needs: validate-caller/);
  assert.match(workflow, /node-version: "22"/);
});

test("only approved endpoint URLs and the dedicated HMAC are passed to the worker", () => {
  const vars = [...workflow.matchAll(/\$\{\{\s*vars\.([A-Z0-9_]+)\s*\}\}/g)].map(match => match[1]);
  const secrets = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)].map(match => match[1]);
  assert.deepEqual(vars, ["USA_CELL_WORKER_API_URL", "USA_CELL_SCHEDULED_REFRESH_API_URL"]);
  assert.deepEqual(secrets, [
    "MOBILESENTRIX_WORKER_TRIGGER_SECRET",
    "MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET",
  ]);
  const manual = workflow.split("- name: Advance manually approved import")[1]
    .split("- name: Advance due retained refresh")[0];
  const scheduled = workflow.split("- name: Advance due retained refresh")[1];
  assert.match(manual, /MOBILESENTRIX_WORKER_TRIGGER_SECRET/);
  assert.doesNotMatch(manual, /MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET/);
  assert.match(scheduled, /MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET/);
  assert.doesNotMatch(scheduled, /MOBILESENTRIX_WORKER_TRIGGER_SECRET/);
});

test("all third-party actions are pinned to full commit SHAs", () => {
  const actions = [...workflow.matchAll(/^\s*uses:\s*[^@\s]+@([^\s]+)\s*$/gm)].map(match => match[1]);
  assert.ok(actions.length > 0);
  for (const ref of actions) assert.match(ref, /^[0-9a-f]{40}$/);
});
