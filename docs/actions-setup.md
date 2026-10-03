# Setting up the reviewer on a repository (ticket 11)

This note configures the trusted main-branch workflow (`.github/workflows/tailscale-review.yml`)
and the two machines it needs: a GitHub-hosted runner that joins your tailnet,
and the homeserver that runs the storage service.

Trust model, in one paragraph: `issue_comment` and `pull_request_target` runs
always use the default branch's copy of the workflow, and the workflow checks
out the default branch explicitly, so a pull request cannot change the rules
that gate it. The reviewed head is fetched only as git objects; its code is
never executed by the workflow itself. The trigger gate inside the review host
decides who may start, queue, cancel or stop reviews; fork heads additionally
need a writer's per-commit `/review` approval. Keep the repository settings
that send secrets to fork `pull_request` workflows disabled — the reviewer's
job holds model API keys, and the per-head fork approval is the only control
in front of them (accepted v0 topology: no separate publisher job).

## 1. Workflow inputs

The settings live in the workflow file's `env` block (the trusted
main-branch file is the only configuration surface; there is no separate
config file, dashboard or command platform — spec Configuration decision).
Edit them in the same commit that adds the workflow. Names and meaning:

| Input (`NITPI_INPUT_*`) | Meaning | Default |
| --- | --- | --- |
| `MODE` | `manual` (default) or `automatic` | `manual` |
| `AUTOMATIC_PRESET` | `true` enables all four events with no check wait (overrides the rest) | `false` |
| `EVENT_OPENED` / `EVENT_REOPENED` / `EVENT_SYNCHRONIZE` / `EVENT_READY_FOR_REVIEW` | The four event toggles for automatic mode | `true` |
| `WAIT_FOR_CHECKS` | Comma-separated check names an automatic review waits for | *(none)* |
| `REFUSAL_CHECK_BEHAVIOR` | `as-refused` (skipped/action_required per the gate), `action_required`, or `none` | `as-refused` |
| `PRIMARY_BASE_URL` / `RE_REVIEW_BASE_URL` | Per-stage OpenAI-compatible base URL | *(required)* |
| `PRIMARY_MODEL_ID` / `RE_REVIEW_MODEL_ID` | Per-stage model ID | *(required)* |
| `PRIMARY_PROVIDER_OPTIONS` / `RE_REVIEW_PROVIDER_OPTIONS` | Per-stage provider options as a JSON object | *(none)* |
| `PRIMARY_CUSTOM_PROMPT` / `RE_REVIEW_CUSTOM_PROMPT` | Per-stage custom prompt text (ticket 10) | *(none)* |
| `PRIMARY_CUSTOM_PROMPT_MODE` / `RE_REVIEW_CUSTOM_PROMPT_MODE` | `append` (after the built-in policy) or `replace` | `append` |
| `PRIMARY_DEADLINE_MS` / `RE_REVIEW_DEADLINE_MS` | Per-stage reviewer deadlines | `900000` |
| `STORAGE_BASE_URL` | The storage service's URL on the tailnet | *(required)* |
| `REVIEW_INSTRUCTIONS_REVISION` | Pinned revision the instructions were captured at (the workflow fills it from its own checkout) | *(filled)* |

`replace` with an empty prompt is a configuration error (a stage without a
review policy is not reviewable) and fails the run before any model call.
An endpoint lacking streaming or tool calls fails with an explicit
configuration error; there is no fallback model.

The workflow also carries one non-`NITPI_INPUT_` setting in its `env` block:
`NITPI_TAILSCALE_TAG` (default `tag:ci-nitpi-reviewer`), the tag the runner
advertises when joining the tailnet. It must match the tag assigned to the
Tailscale OAuth client (section 3).

## 2. GitHub secrets

| Secret | Used by | Required scope |
| --- | --- | --- |
| `NITPI_PRIMARY_API_KEY` | the primary reviewer's endpoint | the key for that provider |
| `NITPI_RE_REVIEW_API_KEY` | the re-reviewer's endpoint | the key for that provider |
| `NITPI_STORAGE_AUTH_KEY` | the review host → storage service | the storage bearer token |
| `NITPI_GITHUB_TOKEN` | the publisher (reviews, inline comments, thread resolve/unresolve) and the check runs | **fine-grained PAT**: repository access to the target repo with *Pull requests: Read and write* and *Checks: Read and write* |
| `NITPI_TAILSCALE_OAUTH_SECRET` | `tailscale up` on the runner | a Tailscale OAuth client's secret (next section) |

The job's own `GITHUB_TOKEN` stays `contents: read` — publication and check
runs run under the PAT, so the default token never gains write scopes even
though `pull_request_target` would grant them.

## 3. Tailscale: ephemeral tagged node and ACL

Create the OAuth client: admin console → **Settings → OAuth clients** (or
**Trust credentials**) → generate a client with the **`auth_keys` scope** and
the tag **`tag:ci-nitpi-reviewer`** assigned. Store the secret as
`NITPI_TAILSCALE_OAUTH_SECRET` (the client ID is not needed by the runner).
OAuth-registered nodes are **ephemeral by default**, so the runner's node
drops from the tailnet when the job ends — the workflow passes
`--auth-key=<secret> --advertise-tags=<tag>` to `tailscale up` per
[tailscale kb/1215](https://tailscale.com/kb/1215/oauth-clients).

The tailnet ACL must let that tag reach ONLY the storage endpoint. In the
admin console's access-controls policy, grant exactly:

```jsonc
{
  "tagOwners": {
    "tag:ci-nitpi-reviewer": ["autogroup:admin"],
  },
  "grants": [
    {
      "src": ["tag:ci-nitpi-reviewer"],
      "dst": ["<homeserver-tailscale-host-or-ip>:51733"],
      "ip":  ["tcp"],
    },
  ],
}
```

(`grants` is the current policy format; on older policies the same shape is
an `acls` rule with `src: ["tag:ci-nitpi-reviewer"]` and
`dst: ["<host>:51733"]`.) With that grant, a compromised or prompt-injected
runner can reach the storage service and nothing else on the tailnet.

## 4. The homeserver storage service

One process per homeserver keeps every PR's state in per-partition SQLite
files. Requirements: Node.js 24+ (any LTS the repo's tooling supports) and a
checkout of this repository.

```bash
# on the homeserver
git clone <this repository> nitpi && cd nitpi
npm ci

export NITPI_STORAGE_DATA_DIR=/srv/nitpi-storage
export NITPI_STORAGE_AUTH_TOKEN="$(openssl rand -hex 32)"   # same value as NITPI_STORAGE_AUTH_KEY
export NITPI_STORAGE_PORT=51733
# Bind the tailnet interface only, so only tailnet peers can connect at all
# (the ACL above is the second boundary; this is the first):
export NITPI_STORAGE_HOST=<homeserver-tailscale-ip>
npx tsx src/storage/service-main.ts
```

Check it: `curl http://127.0.0.1:51733/v1/health` → `{"ok":true}`. Then set
the workflow's `NITPI_STORAGE_BASE_URL` input to the service's tailnet URL
(e.g. `http://nostromo:51733` — MagicDNS name or tailnet IP) and put the
token in `NITPI_STORAGE_AUTH_KEY`.

Run it under a service manager; a systemd unit is the usual shape:

```ini
[Unit]
Description=nitpi storage service (Pi Durable PR-review state)
After=network-online.target

[Service]
WorkingDirectory=/srv/nitpi
EnvironmentFile=/etc/nitpi-storage.env
ExecStart=/usr/bin/npx tsx src/storage/service-main.ts
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Notes: the service acknowledges a commit only after SQLite's durable write
(`synchronous=FULL`), each partition is one SQLite file per (repository, PR),
and one process owns a partition at a time (a second opener is refused while
the lease is live; heartbeats renew it, so one long-lived service process is
correct). The Actions runner reaches the service over the tailnet; if
storage is unreachable the run stops with an execution failure and a later
delivery resumes it — nothing runs locally and nothing publishes from
uncommitted state.

## 5. Check-outcome mechanism (recorded decision)

The spec's semantic check outcomes map onto **Check Runs** — one check named
`nitpi / review` at the reviewed head commit, maintained by the review task:
in progress (head + stage) while running; success after a complete review is
published regardless of findings; failure with a reason on reviewer error;
incomplete (neutral) on a stage deadline; skipped/action_required for gate
refusals with the explanation; cancelled on `/review cancel` and stop events.
Commit statuses and bare job status are not used. Rationale: check runs
carry per-commit status the PR's branch protection can read, keep the
explanations in one place, and the publisher already owns the surface.

## 6. Repository instructions

The reviewers read repository review guidance from the default branch at a
pinned revision: put the guidance in `.nitpi/review-instructions.md` on the
default branch (any non-empty content; the workflow passes the file through
`NITPI_REVIEW_INSTRUCTIONS_FILE` and pins its revision per run). Without the
file the run fails fast with a configuration error — create it as part of
setup.

## 7. Manual verification checklist (on a real PR)

These checks sit outside the scenario test seam and are verified by hand on
your own pull request after the workflow is merged to the default branch:

- [ ] **`/review` posts a review** — a writer comments `/review` on a PR; the
  job runs, one review with the maintained summary appears, findings are
  advisory inline comments, and the `nitpi / review` check goes green.
- [ ] **`/review clean` posts and is imported into history** — comment
  `/review clean`; the review contains no conclusions from earlier reviews;
  after it completes, a follow-up `/review` builds on the clean report
  (shared history), and the clean report itself appears in the history once.
- [ ] **`/review cancel` stops a run** — start a review, comment
  `/review cancel`; the job stops, the check shows cancelled with a reason,
  nothing publishes, and a later `/review` starts a fresh run.
- [ ] **A job killed mid-review resumes on "Re-run jobs" without repeating
  the primary** — start a review, kill the job from the Actions UI while it
  runs, then "Re-run jobs"; the same attempt continues (its earlier stages
  are not repeated), publication still happens once, and no duplicate
  comments appear.
- [ ] **A non-writer's command is refused** — a user without write access
  comments `/review`; the check shows skipped/action_required with the
  explanation and no review runs.

Also verify once: a fork PR's head is not reviewed until a writer comments
`/review` on it (per-commit approval), and a later push from the fork needs
a fresh approval.
