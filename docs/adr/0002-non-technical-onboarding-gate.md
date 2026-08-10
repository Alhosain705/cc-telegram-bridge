# ADR 0002: Gate onboarding through a non-technical user journey

- Status: Accepted
- Date: 2026-08-10
- Owner: Abu Yusuf

## Context

The public `v0.1.3` release and both release assets existed and were anonymously downloadable, but the repository README told users to download the Windows package without giving them a direct link. GitHub's prominent **Code → Download ZIP** action downloaded source code instead. Repository and release audits proved asset identity, checksums, tests, text integrity, and rendering, yet still missed the broken first-time-user path because they did not perform the onboarding task from the public repository entry point. The prepared fresh-user test also started from a private Nextcloud/Exchange copy and bypassed public distribution.

The product targets ordinary, non-technical users. A technically available capability is not delivered when those users cannot find or understand the next action.

## Decision

Every onboarding, installation, release, and recovery path is gated by a task-based walkthrough from the same public entry point a first-time user receives.

1. The next required action must be visible, plain-language, and directly clickable where clicking is possible.
2. Documentation must never say "download the package" without linking the exact supported package and its verification file.
3. Source archives and ready-to-use packages must be explicitly distinguished wherever GitHub presents both.
4. Private or local fallback copies may continue a blocked test only after the public-path failure is recorded; they never count as proof that distribution works.
5. Release review must include desktop and mobile checks for every published language, plus a real anonymous traversal from repository entry to the intended package.
6. Stable automated contract tests must protect critical public links and warnings from accidental removal.

## Consequences

- Release readiness now measures whether the target user can complete the task, not only whether files, endpoints, and hashes exist.
- README and release metadata require maintenance when package names or versions change.
- Fresh-user test kits must start at the public repository and treat internal delivery as fallback only.
- Reviewers must report `NOT READY` when the technical artifact exists but the intended user cannot reach it clearly.

## Rejected alternatives

- **Rely on GitHub's Releases sidebar:** rejected because it is secondary, varies by viewport, and requires GitHub familiarity.
- **Tell users to use Code → Download ZIP:** rejected because it delivers source code rather than the packaged Windows product.
- **Treat anonymous asset download probes as sufficient:** rejected because they prove backend availability, not discoverability or comprehension.
