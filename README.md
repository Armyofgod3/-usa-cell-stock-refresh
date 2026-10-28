# Retained-catalog worker

This repository contains a small GitHub Actions caller for an already-deployed
application. The application owns approval, durable run state, page
checkpoints, leases, and the supplier integration. This worker only sends
bounded, signed HTTP ticks; it does not contain the application or catalog.

## Included files

- `.github/workflows/mobile-sentrix-import.yml` — scheduled and manual entry
  points, with a test-only job and a separately protected production job.
- `scripts/mobilesentrix-worker-caller.mjs` — sequential HMAC caller with
  request deadlines and bounded execution.
- `tests/` — offline caller and workflow safety tests.

## Security setup

Use a dedicated public repository only if exposing its source and workflow
metadata is acceptable. GitHub Actions logs are visible to repository
visitors. The caller logs only request ordinal, pages advanced during that
invocation, and the coarse run state; it does not log run IDs, row counts,
SKUs, response bodies, credentials, or customer information.

Configure the `mobilesentrix-production` GitHub Environment to:

1. Allow deployments from the repository's default branch only.
2. Keep environment secrets unavailable to pull requests and other untrusted
   workflows. This workflow intentionally has no pull-request trigger.
3. Protect the default branch so workflow changes require trusted code review.

Do not add a required-reviewer gate to this environment if unattended refreshes
are expected: GitHub pauses every job that references it until a reviewer
approves that run. The persisted Admin schedule and the server-side retained
refresh authorization are the one-time operator gate.

Set these environment variables in GitHub:

- `USA_CELL_WORKER_API_URL` — the deployed application's exact signed manual
  worker endpoint.
- `USA_CELL_SCHEDULED_REFRESH_API_URL` — its exact signed retained-refresh
  endpoint.

Create two different, random secrets of at least 32 bytes, each only in the
protected GitHub Environment:

- `MOBILESENTRIX_WORKER_TRIGGER_SECRET` — manual approved-import endpoint.
- `MOBILESENTRIX_SCHEDULED_REFRESH_TRIGGER_SECRET` — retained-refresh
  endpoint. The application rejects this key if it matches the manual key.

The deployed application must have matching secrets configured through its
secret manager. Never put values in this repository, workflow variables,
README, test fixtures, or command-line arguments.

## How it runs

The workflow polls every six hours at minute 17. GitHub can delay scheduled
events under load, and scheduled workflows in public repositories may be
disabled after 60 days without repository activity. Check the Actions page
regularly; if GitHub disables this workflow, re-enable it in the workflow's
Actions menu before relying on it again.

Polling alone does not authorize a refresh. The application's persisted Admin
schedule must be enabled and due. When it is disabled or not due, the endpoint
returns without starting supplier work. The application creates or resumes one
retained refresh, protects it with database coordination and worker leases,
and stores committed page checkpoints. GitHub's concurrency group is an
additional safeguard, not the cross-repository lock.

The scheduled caller continues through bounded signed ticks until the server
reports a terminal state or a safety limit is reached. A timeout is not
automatically retried as if it were uncommitted; the durable server checkpoint
is read on the next signed tick. Held, incomplete, or review-required work
remains held for an operator. This workflow does not approve a run, mark a
snapshot complete, publish catalog changes, enable purchasing, or send orders.

For manual dispatch, select exactly one input:

- `run_worker` for a separately approved manual import/recovery.
- `run_scheduled_refresh` for one invocation of the already-authorized
  retained-refresh schedule.

Do not select both. Keep the original manual worker available if needed, but
run only one scheduled poller at a time. Retire the schedule trigger in any
older worker repository before enabling this one; preserve its manual dispatch
if it is still required.

## Cost and operational limits

GitHub documents standard GitHub-hosted runner usage as free for public
repositories. Private repositories instead consume the account's included
minutes and may be billed beyond that allowance. Public source and Actions
metadata are the tradeoff; decide whether that is acceptable before making a
repository public. Estimate usage from the application's observed run time and
the configured poll cadence, then verify actual usage on GitHub's billing page.

The GitHub runner does not remove Replit costs: requests still use the
published application's compute and production database. Replit Autoscale
can scale to zero between requests, so an in-process timer is not the
scheduler. Replit Scheduled Deployments are another supported option, but
they are billed for each run; a long-running refresh would consume deployment
compute for its duration. A Reserved VM has a fixed monthly cost. Confirm
current account pricing and eligibility before choosing either alternative.

The application can enqueue sanitized operational alerts, but an outbox entry
is not proof of email delivery. Delivery is retried by a later successful
worker request. There is no independent external watchdog in this repository:
if GitHub stops scheduling entirely, no tick reaches the application to report
that outage. Check the workflow's latest run and the application's Admin
schedule status.

## Validation

The validation job uses only synthetic fixtures and has no production secrets.
Run it with:

```sh
node --test tests/mobilesentrix-worker-caller.test.mjs tests/workflow-safety.test.mjs
```
