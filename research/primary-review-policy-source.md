# Primary review policy source

The selected initial primary review policy is Cursor's `thermo-nuclear-code-quality-review` skill. I resolved `refs/heads/main` in `cursor/plugins` to commit `c47b12849e43f18d5c374c7069c744cc55b0ea00` with `git ls-remote` on 2026-10-02. The extracted skill body from the live `main` URL matched the body fetched at that immutable commit.

- Immutable source: [SKILL.md at c47b12849e43f18d5c374c7069c744cc55b0ea00](https://github.com/cursor/plugins/blob/c47b12849e43f18d5c374c7069c744cc55b0ea00/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
- Moving source checked: [SKILL.md on main](https://github.com/cursor/plugins/blob/main/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md)
- Repository commit: [c47b12849e43f18d5c374c7069c744cc55b0ea00](https://github.com/cursor/plugins/commit/c47b12849e43f18d5c374c7069c744cc55b0ea00)

The skill directs an unusually strict maintainability review. It asks reviewers to pursue structural simplification and missed "code judo" opportunities, scrutinize spaghetti growth and boundary or abstraction problems, and treat a PR that takes a file from under 1,000 lines to over 1,000 lines as a strong smell. It prioritizes structural regressions and missed simplifications ahead of minor nits. It names several conditions as presumptive blockers, including that file-size crossing and unnecessary complexity or branching.

Those blocker terms describe the review policy's bar for actionable review feedback. The skill does not specify a GitHub Actions check, status conclusion, or branch-protection behavior. No automatic check failure follows from this source alone.

This note records provenance for the selected policy; it does not resolve broader review scope or security-boundary questions. The active environment instruction permits a pulled repository and PR with agentic shell tools in a general sandbox. The separate Pi runtime research reports no built-in security sandbox. This source check adds no sandbox evaluation.
