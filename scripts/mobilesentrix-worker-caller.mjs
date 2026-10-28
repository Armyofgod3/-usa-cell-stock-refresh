import { createHmac, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const WORKER_TICK_PATH = "/api/internal/mobilesentrix/full-catalog/tick";
export const SCHEDULED_REFRESH_TICK_PATH = "/api/internal/mobilesentrix/retained-refresh/scheduled-tick";
export const MAX_TICKS_PER_INVOCATION = 1_500;
// Retained export/option for compatibility; this is a tick limit, not a product/page guarantee.
export const MAX_PAGES_PER_INVOCATION = MAX_TICKS_PER_INVOCATION;
export const MIN_REQUEST_START_INTERVAL_MS = 5_000;
export const MAX_INVOCATION_BUDGET_MS = 140 * 60_000;
export const MAX_SINGLE_REQUEST_MS = 35_000;
const REQUEST_EXIT_BUFFER_MS = 1_000;
const knownStates = new Set(["idle", "dry_run", "running", "paused", "stopped", "needs_review", "blocked", "completed", "refresh_completed", "failed"]);

let invocationActive = false;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function validateEndpoint(endpointUrl, expectedPath, allowInsecureLoopbackForTests) {
  let endpoint;
  try {
    endpoint = new URL(endpointUrl);
  } catch {
    throw new Error("USA_CELL_WORKER_API_URL must be a valid URL");
  }
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "https:" && !(allowInsecureLoopbackForTests && endpoint.protocol === "http:" && loopback)) {
    throw new Error("Worker API URL must use HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.pathname !== expectedPath || endpoint.search || endpoint.hash) {
    throw new Error("Worker API URL must be the exact signed tick endpoint for the selected mode, without credentials or query parameters");
  }
  return endpoint;
}

export function signWorkerTick(secret, timestamp, nonce = randomUUID(), path = WORKER_TICK_PATH) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Worker signing secret must be at least 32 bytes");
  }
  if (!/^\d{10}$/.test(String(timestamp))) throw new Error("Worker timestamp must be Unix seconds");
  if (![WORKER_TICK_PATH, SCHEDULED_REFRESH_TICK_PATH].includes(path)) {
    throw new Error("Worker signing path is not allowed");
  }
  const canonical = `USA-CELL-MOBILE-SENTRIX-WORKER-V1\n${timestamp}\n${nonce}\nPOST\n${path}`;
  const signature = createHmac("sha256", secret).update(canonical).digest("hex");
  return {
    "x-usacell-timestamp": String(timestamp),
    "x-usacell-nonce": nonce,
    "x-usacell-signature": signature,
  };
}

export function getWorkerTriggerSecret(env, scheduledRefresh = false) {
  return env?.[scheduledRefresh
    ? "MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET"
    : "MOBILESENTRIX_WORKER_TRIGGER_SECRET"];
}

export function summarizeWorkerProgressForLogs(progress) {
  return {
    ...(Number.isInteger(progress?.requestNumber) ? { requestNumber: progress.requestNumber } : {}),
    ...(Number.isInteger(progress?.pagesAdvanced) ? { pagesAdvanced: progress.pagesAdvanced } : {}),
    state: typeof progress?.state === "string" ? progress.state : "unknown",
  };
}

function validateTickResponse(payload) {
  if (!payload || typeof payload !== "object" || typeof payload.advanced !== "boolean"
      || !payload.progress || typeof payload.progress !== "object") {
    throw new Error("Worker API returned an invalid response");
  }
  const { runId, state, pagesCompleted, pauseReason, progressPercent } = payload.progress;
  if (!(runId === null || (Number.isSafeInteger(runId) && runId > 0))
      || typeof state !== "string" || !knownStates.has(state)
      || !Number.isSafeInteger(pagesCompleted) || pagesCompleted < 0
      || !(pauseReason === null || typeof pauseReason === "string")
      || !Number.isFinite(progressPercent)) {
    throw new Error("Worker API returned invalid progress data");
  }
  return payload;
}

export async function runWorkerInvocation({
  endpointUrl,
  secret,
  fetchImpl = fetch,
  wallNow = () => Date.now(),
  monotonicNow = () => performance.now(),
  sleep = defaultSleep,
  log = () => {},
  maxPages = MAX_PAGES_PER_INVOCATION,
  budgetMs = MAX_INVOCATION_BUDGET_MS,
  allowInsecureLoopbackForTests = false,
  scheduledRefresh = false,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const endpointPath = scheduledRefresh ? SCHEDULED_REFRESH_TICK_PATH : WORKER_TICK_PATH;
  const endpoint = validateEndpoint(endpointUrl, endpointPath, allowInsecureLoopbackForTests);
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    const secretName = scheduledRefresh
      ? "MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET"
      : "MOBILESENTRIX_WORKER_TRIGGER_SECRET";
    throw new Error(`${secretName} must be at least 32 bytes`);
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_PAGES_PER_INVOCATION) {
    throw new Error(`maxPages must be between 1 and ${MAX_PAGES_PER_INVOCATION}`);
  }
  if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > MAX_INVOCATION_BUDGET_MS) {
    throw new Error(`budgetMs must be between 1 and ${MAX_INVOCATION_BUDGET_MS}`);
  }
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");
  if (invocationActive) throw new Error("A worker invocation is already active in this process");
  invocationActive = true;

  const deadline = monotonicNow() + budgetMs;
  let lastRequestStartedAt = null;
  let activeRunId = null;
  let pagesAdvanced = 0;
  let latestProgress = null;

  try {
    for (let requestNumber = 0; requestNumber < maxPages; requestNumber++) {
      if (lastRequestStartedAt !== null) {
        const waitMs = MIN_REQUEST_START_INTERVAL_MS - (monotonicNow() - lastRequestStartedAt);
        if (waitMs > 0) {
          if (monotonicNow() + waitMs >= deadline) {
            return { pagesAdvanced, stopReason: "time-budget", progress: latestProgress };
          }
          await sleep(waitMs);
        }
      }

      const remainingMs = deadline - monotonicNow();
      if (remainingMs <= MAX_SINGLE_REQUEST_MS + REQUEST_EXIT_BUFFER_MS) {
        return { pagesAdvanced, stopReason: "time-budget", progress: latestProgress };
      }

      const requestStartedAt = monotonicNow();
      lastRequestStartedAt = requestStartedAt;
      const timestamp = String(Math.floor(wallNow() / 1000));
      const headers = signWorkerTick(secret, timestamp, randomUUID(), endpointPath);
      const controller = new AbortController();
      const requestTimeoutMs = Math.min(MAX_SINGLE_REQUEST_MS, deadline - monotonicNow() - REQUEST_EXIT_BUFFER_MS);
      const abortTimer = setTimeoutImpl(() => controller.abort(), requestTimeoutMs);

      let response, payload;
      try {
        // Include body decoding in the request timeout, not just response headers.
        await Promise.race([
          (async () => {
            try {
              response = await fetchImpl(endpoint, {
                method: "POST", headers, redirect: "error", signal: controller.signal,
              });
            } catch {
              throw new Error("Worker API request failed; stopping without retry");
            }
            if (!response?.ok) throw new Error(`Worker API returned HTTP ${response?.status ?? "unknown"}; stopping without retry`);
            try { payload = validateTickResponse(await response.json()); }
            catch { throw new Error("Worker API returned invalid JSON or progress; stopping without retry"); }
          })(),
          new Promise((_, reject) => controller.signal.addEventListener("abort", () =>
            reject(new Error("Worker API request timed out; stopping without retry")), { once: true })),
        ]);
      } catch (error) {
        if (controller.signal.aborted) throw new Error("Worker API request timed out; stopping without retry");
        throw error;
      } finally {
        clearTimeoutImpl(abortTimer);
      }

      latestProgress = payload.progress;
      log({
        requestNumber: requestNumber + 1,
        pagesAdvanced: pagesAdvanced + Number(payload.advanced),
        state: latestProgress.state,
        runId: latestProgress.runId,
        // Whitelist the stop code, never arbitrary server strings or supplier values.
        holdCode: /^[A-Z0-9_]{1,80}$/.test(latestProgress.pauseReason ?? "") ? latestProgress.pauseReason : null,
        pagesCompleted: latestProgress.pagesCompleted,
        progressPercent: latestProgress.progressPercent,
      });

      if (latestProgress.runId === null || latestProgress.state === "idle") {
        return { pagesAdvanced, stopReason: "no-approved-active-run", progress: latestProgress };
      }
      if (activeRunId !== null && latestProgress.runId !== activeRunId) {
        return { pagesAdvanced, stopReason: "run-changed", progress: latestProgress };
      }
      activeRunId ??= latestProgress.runId;
      if (latestProgress.state !== "running") {
        if (payload.advanced) pagesAdvanced++;
        return { pagesAdvanced, stopReason: `terminal-state:${latestProgress.state}`, progress: latestProgress };
      }
      if (latestProgress.pauseReason && latestProgress.pauseReason !== "CATALOG_CHANGED_RECONCILING") {
        const safeCode = /^[A-Z0-9_]{1,80}$/.test(latestProgress.pauseReason) ? latestProgress.pauseReason : "UNRECOGNIZED_HOLD";
        return { pagesAdvanced, stopReason: `checkpoint-hold:${safeCode}`, progress: latestProgress };
      }
      if (!payload.advanced) return { pagesAdvanced, stopReason: "not-advanced-or-lease-held", progress: latestProgress };
      pagesAdvanced++;
    }

    return { pagesAdvanced, stopReason: "tick-limit", progress: latestProgress };
  } finally {
    invocationActive = false;
  }
}

async function main() {
  try {
    const scheduledRefresh = process.argv.includes("--scheduled-refresh");
    const result = await runWorkerInvocation({
      endpointUrl: scheduledRefresh
        ? process.env.USA_CELL_SCHEDULED_REFRESH_API_URL
        : process.env.USA_CELL_WORKER_API_URL,
      secret: getWorkerTriggerSecret(process.env, scheduledRefresh),
      scheduledRefresh,
      log: progress => console.info("[MobileSentrix worker]", JSON.stringify(summarizeWorkerProgressForLogs(progress))),
    });
    console.info(`[MobileSentrix worker] Stopped: ${result.stopReason}; pages advanced: ${result.pagesAdvanced}`);
    if (result.stopReason.startsWith("terminal-state:") || result.stopReason === "no-approved-active-run") {
      console.warn("[MobileSentrix worker] No more requests will be sent. This workflow is manual-only; review the checkpoint before another launch.");
      if (["needs_review", "blocked", "failed"].includes(result.progress?.state)) process.exitCode = 2;
    }
    if (result.stopReason.startsWith("checkpoint-hold:")) {
      console.error("[MobileSentrix worker] Import checkpoint is held. No more requests will be sent; review the run before another manual launch.");
      process.exitCode = 2;
    }
    if (["tick-limit", "time-budget", "run-changed", "not-advanced-or-lease-held"].includes(result.stopReason)) {
      console.warn("[MobileSentrix worker] Safety boundary reached; checkpoint retained. No automatic relaunch.");
      process.exitCode = 2;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected worker error";
    console.error(`[MobileSentrix worker] Failed closed: ${message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
