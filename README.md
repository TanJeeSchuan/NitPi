# VERY ALPHA, SECURITY WOULD BE BAD, DO NOT USE IN PROD. YET!

# NitPi

A two-stage pull-request reviewer that runs in GitHub Actions. A primary reviewer reads the PR in a sandboxed checkout and writes a review. A second agent, the re-reviewer, gets that frozen review without the primary's conversation, checks every finding against the code, and owns the final list. Surviving findings go to GitHub as inline comments on one review with a maintained summary.

Both reviewers are [Pi Durable](https://github.com/earendil-works/pi) agents. Their state lives on a storage service on a homeserver, reached over Tailscale, so a killed Actions job resumes where it stopped instead of starting over or double-posting.

Status: v0. All eleven spec tickets are merged and the scenario suite passes. The end-to-end check on a real PR ([checklist](docs/actions-setup.md#7-manual-verification-checklist-on-a-real-pr)) hasn't been run yet.

## Commands

Comment on a pull request:

| Comment | Effect |
| --- | --- |
| `/review` | Review the current head. Continues the PR's shared review history, so earlier findings are leads to re-check. |
| `/review clean` | Review with no prior context. Earlier findings are shown to the re-reviewer only after its final review is frozen, and only to match comments. The finished report then joins the shared history. |
| `/review cancel` | Stop the active run. Nothing publishes and recovery won't restart it. |

Only writers and maintainers can run commands. A fork PR's head is reviewed only after a writer comments `/review` on that exact commit, and a new push needs a new approval.

Manual mode is the default. Automatic mode reviews on `opened`, `reopened`, `synchronize` and `ready_for_review`, each toggled separately, and can wait for named checks to finish first. Closing the PR, merging it, or converting it to a draft stops any active run.

A request that arrives during a run doesn't queue behind it. Each PR holds one pending request, and a newer head replaces it.

## What a run does

```
primary → freeze artifact → re-review → final frozen → match → publish
```

1. Each stage gets its own git worktree pinned at the reviewed head SHA, so the primary's scratch edits can't leak into the re-review.
2. The primary applies the review policy and writes a Markdown artifact with one finding per section. Each finding carries an inline anchor (`path | RIGHT | 42`, or a range).
3. The re-reviewer verifies, merges or drops findings, and may add issues it runs into while doing so. Every anchor is checked against the pinned base→head diff. Invalid ones go back to the re-reviewer with the reason until they all land on diff lines.
4. One more turn, which can only assign matches, maps current findings to earlier bot comments. The publisher then syncs the PR:
   - a finding at the same anchor updates its comment
   - a recurring finding reopens its resolved thread
   - a moved finding marks the old comment superseded and posts a new one
   - a finding the new review omits has its thread resolved
5. The run maintains a `nitpi / review` check run on the head commit: in progress, success, failure, incomplete on a stage deadline, skipped or action_required for refused triggers, and cancelled.

The publisher never edits human comments. It only acts on comment IDs the model supplied after checking that each one belongs to this PR and was written by the bot. Every GitHub write is logged in a durable ledger before it happens, with a marker in the body. After a crash, the publisher reconciles by searching GitHub for that marker instead of posting again.

If a push lands while a run is active, the run still finishes. It's recorded as stale against the head it reviewed and publishes nothing.

## Review policy

By default both stages apply a pinned copy of Cursor's [thermo-nuclear code quality review](src/review-host/skills/thermo-nuclear-code-quality-review.md) skill ([provenance](research/primary-review-policy-source.md)). Each stage can take a custom prompt in `append` or `replace` mode.

Repository guidance comes from `.nitpi/review-instructions.md` on the default branch, pinned to the revision checked out for the run. Instruction changes inside the PR under review have no effect. The file is required, and a run without it fails with a configuration error.

## Models

Each stage points at its own OpenAI-compatible endpoint: base URL, model ID, API key, and optional provider options. `src/pi-bridge/provider-bridge.ts` adapts AI SDK `streamText` to pi-ai's provider contract, and Pi runs the tool loop. The endpoint must support streaming and tool calls. There is no fallback model.

## Deployment

Three pieces:

- **The workflow** (`.github/workflows/tailscale-review.yml`). It runs from the default branch on `issue_comment`, `pull_request_target` and `check_run`. It fetches the PR head as git objects only and never executes PR code. Settings go in its `env` block as `NITPI_INPUT_*` variables. The job's own `GITHUB_TOKEN` stays `contents: read`, and a fine-grained PAT does the publishing.
- **Tailscale.** The runner joins the tailnet as an ephemeral node tagged `tag:ci-nitpi-reviewer`. The ACL lets that tag reach the storage port and nothing else.
- **The storage service** (`src/storage/service-main.ts`). It runs on the homeserver and keeps one SQLite file per (repository, PR), written with `synchronous=FULL`. It leases each partition to one process at a time. It also serves a read-only run viewer at `/view`: open `http://<storage host>:<port>/view#token=<storage token>` from any tailnet device. The page keeps the token in that tab's session storage and refreshes every two seconds. It reads SQLite without a lease, so it works while a review is running.

[docs/actions-setup.md](docs/actions-setup.md) has the full setup: every input, the secrets, the Tailscale OAuth client and ACL, a systemd unit for the storage service, and the manual verification checklist.

## Development

Requires Node 24.

```bash
npm ci
npm run typecheck
npm test
```

The scenario tests in `test/scenario/` run the real review host against a real storage service, plus three local fakes: a GitHub REST/GraphQL fake (`test/fixtures/fake-github.ts`), a scripted OpenAI-compatible SSE stub per stage (`test/fixtures/model-stub.ts`), and a git fixture. Restart scenarios close the host and reopen it on the same data directory, which is how they simulate an Actions re-run. Open hosts in tests through `test/helpers/host-on-storage.ts`.

## Layout

| Path | Contents |
| --- | --- |
| `actions/entry.mts` | Actions entry point. One invocation serves one delivered event. Exit codes: 0 settled, 1 run failed, 2 configuration error. |
| `src/review-host/` | Host wiring, the durable review task, trigger gate, config, instructions, artifact parsing, anchor validation, matching, run history |
| `src/github/` | REST client, publisher, publication ledger, retry |
| `src/pi-bridge/` | AI SDK to pi-ai provider bridge |
| `src/storage/` | Storage service, HTTP wire protocol, the client-side `Storage` adapter, and the run viewer (`viewer/`) |
| `CONTEXT.md` | Domain vocabulary: primary reviewer, re-reviewer, clean review, stale run, and so on |
| `research/` | Notes checked against primary sources: Actions trust boundaries, the GitHub review API, Pi Durable guarantees |
| `prototypes/` | Throwaway HTML simulation of the review conversation model |
