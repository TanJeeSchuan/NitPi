# Pull-request review

Language for the two-stage pull-request reviewer.

## Language

**Primary reviewer**:
The first reviewer, which applies the selected review policy to the pull request before findings receive a second-stage audit.

**Review policy**:
The judgment standard a stage applies: by default, the pinned thermo-nuclear skill. A stage's custom prompt is appended to it or replaces it. Repository instructions and the fixed review protocol apply either way.

**Custom prompt**:
Operator-supplied instructions for one stage, configured in the trusted main-branch workflow, in append or replace mode.
_Avoid_: PR-supplied prompt

**Re-reviewer**:
The single second-stage agent given the entire frozen primary review, plus repository and PR context, to verify all findings under its own resolved review policy without the primary conversation. It owns the final finding set, resolves duplicates and contradictions, and verifies incidental additions.
For normal reviews, it receives earlier published findings and comment IDs for matching. For clean reviews, it receives them only after its independent final review is frozen, for matching without changing substantive findings.

**Incidental finding**:
A new issue encountered while verifying primary findings, rather than through a separate search for missed issues.

**Repository instructions**:
Review guidance taken from the repository's main branch, rather than instruction changes in the pull request.
_Avoid_: PR-head policy

**Review sandbox**:
The disposable execution environment where either reviewer browses the pulled repository and uses shell commands.

**Review artifact**:
The canonical free-form text or Markdown review passed between reviewers.
_Avoid_: Canonical JSON review, rendered-only review

**Section**:
Exactly one finding in the review artifact.
_Avoid_: File section, diff chunk, concern section

**Finding**:
One alleged issue with an explanation. A published finding has a valid inline anchor.
_Avoid_: Unanchored summary finding

**Evidence**:
Source material supporting a finding, including unchanged code when the pull request introduces the problem.
_Avoid_: Comment location

**Inline anchor**:
A location in the pull-request diff where the finding can receive a GitHub review comment.
_Avoid_: Evidence location

**Prior review context**:
Earlier review conversations, artifacts, findings and discussion revealing those findings. Normal reviews treat conclusions as leads and verify them against current code.

**Clean review**:
A substantive review without prior review context. It may use unrelated human clarification. Its independent final review is frozen before the same re-reviewer receives earlier comments for publication matching.
Only its generated report is contributed to the ongoing PR conversation.

**Shared PR history**:
The ongoing durable conversation for one pull request, which normal reviews continue.
_Avoid_: GitHub comment history, operational log

**Pending request**:
The one request a pull request holds while a review is active; it keeps only the newest eligible requested head and its mode, and starts after eligibility is re-checked when the active run ends.
_Avoid_: retry queue, backlog of requests

**Stale run**:
A run that finished after the pull request's head moved on or the pull request stopped being open. It is kept in history attributed to the head it reviewed and publishes nothing.
_Avoid_: outdated review, lost review

**Cancelled run**:
A run whose pending work was stopped by `/review cancel` or by the pull request closing, merging, or becoming a draft. The cancellation is fenced on the run document: it publishes nothing, is never a completed result, and recovery never restarts it. Losing the Actions job is not a cancellation — such a run stays resumable.
_Avoid_: aborted review, killed run
