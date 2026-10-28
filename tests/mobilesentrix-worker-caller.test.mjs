import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  MAX_INVOCATION_BUDGET_MS,
  MAX_PAGES_PER_INVOCATION,
  MAX_SINGLE_REQUEST_MS,
  MIN_REQUEST_START_INTERVAL_MS,
  SCHEDULED_REFRESH_TICK_PATH,
  WORKER_TICK_PATH,
  getWorkerTriggerSecret,
  summarizeWorkerProgressForLogs,
  runWorkerInvocation,
} from "../scripts/mobilesentrix-worker-caller.mjs";

const secret = "synthetic-only-worker-trigger-secret-32";

// Synthetic-only progress payloads; no supplier or production catalog data.
function progress(state = "running", pagesCompleted = 0, pauseReason = null) {
  return {
    runId: state === "idle" ? null : 42,
    state,
    pagesCompleted,
    totalPages: 1_500,
    pauseReason,
    progressPercent: Math.round(pagesCompleted / 1_500 * 100),
  };
}

test("public caller separates schedule credentials and redacts catalog/run detail from logs", () => {
  const env = {
    MOBILESENTRIX_WORKER_TRIGGER_SECRET: "synthetic-manual-key-that-is-long-enough",
    MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET: "synthetic-scheduled-key-that-is-long-enough",
  };
  assert.equal(getWorkerTriggerSecret(env), env.MOBILESENTRIX_WORKER_TRIGGER_SECRET);
  assert.equal(getWorkerTriggerSecret(env, true), env.MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET);
  assert.deepEqual(summarizeWorkerProgressForLogs({
    requestNumber: 2, pagesAdvanced: 1, state: "running", runId: 999,
    totalRecords: 6_000, nextPage: 3, pauseReason: "synthetic-detail",
  }), { requestNumber: 2, pagesAdvanced: 1, state: "running" });
});

test("scheduled caller fails closed rather than falling back to the manual key", async () => {
  await assert.rejects(runWorkerInvocation({
    endpointUrl: `https://example.test${SCHEDULED_REFRESH_TICK_PATH}`,
    scheduledRefresh: true,
  }), /MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET must be at least 32 bytes/);
});

test("caller makes at most 1500 sequential signed ticks five seconds apart", async () => {
  let wallClock = Date.now();
  let monotonicClock = 0;
  let pagesCompleted = 0;
  const starts = [];
  const requests = [];
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    wallNow: () => wallClock,
    monotonicNow: () => monotonicClock,
    sleep: async ms => {
      wallClock += ms;
      monotonicClock += ms;
    },
    fetchImpl: async (_url, options) => {
      starts.push(monotonicClock);
      requests.push(options);
      pagesCompleted++;
      return Response.json({ advanced: true, progress: progress("running", pagesCompleted) });
    },
  });

  assert.equal(MAX_PAGES_PER_INVOCATION, 1500);
  assert.equal(MAX_INVOCATION_BUDGET_MS, 140 * 60_000);
  assert.equal(MIN_REQUEST_START_INTERVAL_MS, 5_000);
  assert.equal(requests.length, 1500);
  assert.equal(result.pagesAdvanced, 1500);
  assert.equal(result.stopReason, "tick-limit");
  assert.ok(starts.every((start, i) => i === 0 || start - starts[i - 1] >= 5_000));
  assert.ok(requests.every(request => request.method === "POST" && request.body === undefined));
  assert.equal(new Set(requests.map(request => request.headers["x-usacell-nonce"])).size, 1500);

  const first = requests[0].headers;
  const canonical = `USA-CELL-MOBILE-SENTRIX-WORKER-V1\n${first["x-usacell-timestamp"]}\n${first["x-usacell-nonce"]}\nPOST\n${WORKER_TICK_PATH}`;
  assert.equal(
    first["x-usacell-signature"],
    createHmac("sha256", secret).update(canonical).digest("hex"),
  );
});

test("scheduled mode signs only its dedicated retained-refresh endpoint", async () => {
  let captured;
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${SCHEDULED_REFRESH_TICK_PATH}`,
    secret,
    scheduledRefresh: true,
    maxPages: 1,
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options };
      return Response.json({ advanced: false, progress: progress("idle", 0) });
    },
  });
  assert.equal(new URL(captured.url).pathname, SCHEDULED_REFRESH_TICK_PATH);
  const headers = captured.options.headers;
  const canonical = `USA-CELL-MOBILE-SENTRIX-WORKER-V1\n${headers["x-usacell-timestamp"]}\n${headers["x-usacell-nonce"]}\nPOST\n${SCHEDULED_REFRESH_TICK_PATH}`;
  assert.equal(headers["x-usacell-signature"], createHmac("sha256", secret).update(canonical).digest("hex"));
  assert.equal(result.stopReason, "no-approved-active-run");
  await assert.rejects(() => runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret, scheduledRefresh: true,
    fetchImpl: async () => Response.json({ advanced: false, progress: progress("idle", 0) }),
  }), /selected mode/);
});

test("caller stops on completed, paused, failed, and review-required states", async () => {
  for (const state of ["completed", "paused", "failed", "needs_review", "blocked", "stopped"]) {
    let requests = 0;
    const result = await runWorkerInvocation({
      endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
      secret,
      fetchImpl: async () => {
        requests++;
        return Response.json({ advanced: false, progress: progress(state, 12) });
      },
    });
    assert.equal(requests, 1, `${state} should stop immediately`);
    assert.equal(result.stopReason, `terminal-state:${state}`);
  }
});

test("caller accepts refresh_completed as a successful terminal state", async () => {
  let requests = 0;
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    fetchImpl: async () => {
      requests++;
      return Response.json({ advanced: true, progress: progress("refresh_completed", 1_500) });
    },
  });
  assert.equal(requests, 1, "a completed refresh must not cause another signed tick");
  assert.equal(result.pagesAdvanced, 1);
  assert.equal(result.stopReason, "terminal-state:refresh_completed");
  assert.equal(result.progress.state, "refresh_completed");
});

test("one launch collects 384 synthetic pages and stops at the review checkpoint", async () => {
  let clock = 0, calls = 0;
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret,
    wallNow: () => 1792600000000 + clock, monotonicNow: () => clock,
    sleep: async ms => { clock += ms; },
    fetchImpl: async () => {
      calls++;
      return Response.json({ advanced: true,
        progress: progress(calls === 384 ? "needs_review" : "running", calls,
          calls === 384 ? "QUARANTINED_PAGE_GAPS" : null) });
    },
  });
  assert.equal(calls, 384);
  assert.equal(result.stopReason, "terminal-state:needs_review");
  assert.equal(result.progress.pagesCompleted, 384);
  assert.equal(result.progress.pauseReason, "QUARANTINED_PAGE_GAPS");
  assert.ok(clock > 4 * 60_000);
});

test("idle, run changes, malformed bodies, lease holds and unsafe inputs stop without a loop", async () => {
  for (const state of ["idle", "running"]) {
    let requests = 0;
    const result = await runWorkerInvocation({
      endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret,
      fetchImpl: async () => { requests++; return Response.json({ advanced: false, progress: progress(state) }); },
    });
    assert.equal(requests, 1);
    assert.equal(result.stopReason, state === "idle" ? "no-approved-active-run" : "not-advanced-or-lease-held");
  }
  let requests = 0, clock = 0;
  const changed = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret,
    monotonicNow: () => clock, sleep: async ms => { clock += ms; },
    fetchImpl: async () => { requests++; return Response.json({
      advanced: true, progress: { ...progress(), runId: requests === 1 ? 42 : 43 },
    }); },
  });
  assert.equal(changed.stopReason, "run-changed");
  assert.equal(requests, 2);
  for (const value of ["not-json", JSON.stringify({ advanced: true, progress: { ...progress(), state: "surprise" } })]) {
    await assert.rejects(() => runWorkerInvocation({
      endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret,
      fetchImpl: async () => new Response(value),
    }), /invalid JSON or progress/);
  }
  await assert.rejects(() => runWorkerInvocation({ endpointUrl: `http://example.test${WORKER_TICK_PATH}`, secret }), /HTTPS/);
  await assert.rejects(() => runWorkerInvocation({ endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret: "short" }), /32 bytes/);
  await assert.rejects(() => runWorkerInvocation({ endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret, maxPages: 1501 }), /maxPages/);
  await assert.rejects(() => runWorkerInvocation({ endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret, budgetMs: MAX_INVOCATION_BUDGET_MS + 1 }), /budgetMs/);
});

test("logs and stop codes exclude arbitrary supplier strings", async () => {
  const logs = [];
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`, secret, log: entry => logs.push(entry),
    fetchImpl: async () => Response.json({ advanced: true,
      progress: { ...progress("running", 2, "sensitive supplier message"), raw: "secret body" } }),
  });
  assert.equal(result.stopReason, "checkpoint-hold:UNRECOGNIZED_HOLD");
  assert.doesNotMatch(JSON.stringify(logs), /sensitive|secret|signature|nonce/);
});

test("caller respects the hard execution budget and does not retry failed requests", async () => {
  let monotonicClock = 0;
  let requests = 0;
  const budgetResult = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    monotonicNow: () => monotonicClock,
    fetchImpl: async () => {
      requests++;
      monotonicClock = MAX_INVOCATION_BUDGET_MS - MIN_REQUEST_START_INTERVAL_MS;
      return Response.json({ advanced: true, progress: progress("running", 1) });
    },
  });
  assert.equal(budgetResult.stopReason, "time-budget");
  assert.equal(requests, 1);

  requests = 0;
  await assert.rejects(() => runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    fetchImpl: async () => {
      requests++;
      return Response.json({ error: "synthetic" }, { status: 503 });
    },
  }), /HTTP 503/);
  assert.equal(requests, 1);
});

test("35-second request boundary accepts the measured 30.153-second response", async () => {
  assert.equal(MAX_SINGLE_REQUEST_MS, 35_000);
  let monotonicClock = 0;
  let scheduledTimeoutMs = null;
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    maxPages: 1,
    budgetMs: 45_000,
    monotonicNow: () => monotonicClock,
    setTimeoutImpl: (_callback, ms) => {
      scheduledTimeoutMs = ms;
      return 1;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async () => {
      monotonicClock = 30_153;
      return Response.json({ advanced: true, progress: progress("running", 57) });
    },
  });

  assert.equal(scheduledTimeoutMs, 35_000);
  assert.equal(result.pagesAdvanced, 1);
  assert.equal(result.progress.pagesCompleted, 57);
  assert.equal(result.stopReason, "tick-limit");
});

test("the extended request boundary still aborts once and never retries", async () => {
  let abortRequest;
  let requests = 0;
  let scheduledTimeoutMs = null;
  const pending = runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    maxPages: 1,
    budgetMs: 45_000,
    setTimeoutImpl: (callback, ms) => {
      scheduledTimeoutMs = ms;
      abortRequest = callback;
      return 1;
    },
    clearTimeoutImpl: () => {},
    fetchImpl: async (_url, options) => {
      requests++;
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true });
      });
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  abortRequest();

  await assert.rejects(() => pending, /request timed out; stopping without retry/);
  assert.equal(scheduledTimeoutMs, 35_000);
  assert.equal(requests, 1);
});

test("non-reconciliation checkpoint holds stop without another request", async () => {
  let requests = 0;
  const result = await runWorkerInvocation({
    endpointUrl: `https://example.test${WORKER_TICK_PATH}`,
    secret,
    fetchImpl: async () => {
      requests++;
      return Response.json({
        advanced: false,
        progress: progress("running", 12, "HTTP_429"),
      });
    },
  });
  assert.equal(result.stopReason, "checkpoint-hold:HTTP_429");
  assert.equal(requests, 1);
});
