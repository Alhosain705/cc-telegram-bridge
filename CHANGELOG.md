# Changelog
> Newest first. All dates/times in Riyadh time (AST, UTC+3). Built from `git log` (commits `75bf251`→`e438720`) and `TRUTH.md §6` (project source of truth, kept on Google Drive — not duplicated here).

---

## [0.1.3-independent-review-T-165-remediation] — 07Aug2026 06:14 AST
**By:** Codex Mini
**What:** Closed T-165 RB-1 by distinguishing short public routes from local-looking POSIX paths in URL query and fragment values, including one- and two-layer percent encoding. Also kept unspaced ampersands inside path names, removed the private-key label length ceiling, accepted hyphenated PEM labels, matched exact end labels, and prevented adjacent Bearer credentials from exposing the second payload. Updated the shipped security contract and its privacy-first ambiguity limits.
**Why:** T-165 proved that `/home`, `/Users`, `/media`, `/srv`, and `/run` paths with user/private segments could pass through URLs into Telegram and logs. Its appendix also identified reproducible hardening gaps in path boundaries, PEM labels, double encoding, and adjacent Bearer values.
**Decision:** Preserve one-segment public routes such as `/home/dashboard` and `/users/42`, but redact ambiguous roots once two additional path segments provide strong local-path evidence. Decode URL values at most twice. Treat malformed or truncated private-key begins as secret through end-of-capture, while accepting unbounded printable labels and requiring the matching end label. Keep privacy-first over-redaction where prose and a space-bearing Windows path are textually indistinguishable.
**Evidence:** `npm run check` passed; `npm test` = 110 passed, 0 failed; all eight RB-1 probes and 105 generated root/key/encoding combinations are covered; focused 64 KiB–2 MiB scaling remained linear or near-linear across PEM labels, double decoding, Bearer values, and ambiguous POSIX URLs; two x64 builds were byte-identical; package verification matched 33/33 product files; packaged Node 24.18.0 executed successfully; zero unexpected credential matches. Verification-only package SHA-256: `23194b7b8a8724f5a16385f08786342b0853ceaa6256421713910ce93a3364c7`.
**Release gate:** No push, publication, deployment, service restart, or live Telegram action was performed. Independent SSH-based reproduction from the reviewer host and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-independent-review-T-163-remediation] — 07Aug2026 05:09 AST
**By:** Codex Mini
**What:** Replaced the remaining unbounded redaction boundary heuristics with bounded, linear-by-construction checks; preserved wrapper punctuation and single-ampersand command tails; redacted each absolute path in multi-command lines; widened private-key labels and fail-closed redaction for truncated keys; distinguished common public web routes from high-confidence local paths; and covered raw plus percent-encoded drive/UNC paths inside URLs.
**Why:** T-163 proved a second quadratic underscore-closer path, silent truncation after `)`, `]`, and `}`, loss of a second command after `&`, and private-key coverage gaps. Its informational probes also exposed common public-route distortion and encoded/local URL gaps.
**Decision:** Path parsing may inspect only bounded local context when deciding Markdown and shell boundaries. A single `&` ends a path only before a known shell command or another absolute path; matched prose/Markdown wrappers remain outside the redacted span. Complete or truncated valid private-key markers fail closed. URL redaction preserves ordinary web routes while redacting explicit file parameters, high-confidence system roots, and raw or percent-encoded local path forms.
**Evidence:** `npm run check` passed; `npm test` = 110 passed, 0 failed; the adversarial underscore case scaled from 3.26 ms at 64 KiB to 11.39 ms at 512 KiB; every T-163 N-1..N-5 reproduction passes; two independent x64 builds were byte-identical; package verification matched 33/33 product files byte-for-byte; packaged Node 24.18.0 executed successfully; zero unexpected credential matches. Verification-only package SHA-256: `adfea62bd52168cf2660acd96021ccb828695ac3f6e6c8aa1c78cf6c8c55ad94`.
**Release gate:** No push, publication, deployment, service restart, or live Telegram action was performed. One final bounded independent-review round and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-independent-review-T-160-remediation] — 07Aug2026 00:50 AST
**By:** Codex Mini
**What:** Closed all seven T-160 findings in one batch: replaced the quadratic private-key regular expression with a bounded-label, linear marker scanner; preserved public query, OAuth, API-filter, CI, and SPA-fragment URLs while redacting known local roots and file/editor URL values; detected drive paths anywhere inside a URL path component; kept spaced ampersands, underscores, and unmatched closers inside legitimate Windows path names; precomputed path-separator lookahead to keep ampersand disambiguation linear; and expanded the scaling gate to three sizes across paths and every credential rule.
**Why:** The reviewed candidate could still freeze the single-threaded bridge for about 21 seconds on a 2 MiB unclosed private-key-marker stream, distort common public URLs, and expose path tails such as `Research & Development`, `draft_ v2`, and `weird)name`. Its timing gate covered only one credential rule with a narrow threshold.
**Decision:** Treat complete private-key marker pairs with a single-pass scanner and leave unmatched markers untouched without rescanning the suffix. Within URLs, preserve public routes and parameters but redact explicit drive/UNC/file/editor values and well-known local POSIX roots. Prefer privacy-preserving over-redaction for ambiguous single-ampersand command tails, while always preserving the unambiguous `&&` separator.
**Evidence:** `npm run check` passed; `npm test` = 109 passed, 0 failed; the 1 MiB unmatched private-key case fell from the reviewed 5–11 seconds to about 13 ms; all T-160 URL/path repros pass; two independent x64 builds were byte-identical; package verification matched 33/33 product files byte-for-byte; packaged Node 24.18.0 executed successfully; zero unexpected credential matches. Verification-only package SHA-256: `8b37b262b7be0ae66266273bca72c8af567f85a0c90a422a98aa4451e2a94178`.
**Release gate:** No push, publication, deployment, service restart, or live Telegram action was performed. One bounded independent-review round and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-independent-review-T-158-remediation] — 06Aug2026 22:57 AST
**By:** Codex Mini
**What:** Closed all five actionable T-158 findings in one batch: bounded Telegram bot-token identifiers to remove quadratic backtracking; balanced parentheses, brackets, and braces while scanning paths; treated ampersands as shell separators only in separator context; redacted local paths embedded in `file://`, VS Code, query, and fragment URL components; covered underscore Markdown wrappers; and replaced the single-size wall-clock guard with doubled-input scaling assertions for both path and credential layers.
**Why:** The reviewed candidate could freeze the single-threaded bridge on long digit runs, disclose the tail of common Windows paths such as `Program Files (x86)` and `R&D`, expose local paths carried inside URLs, and miss underscore-wrapped Markdown paths. Its prior performance test could not distinguish linear from quadratic growth.
**Decision:** Preserve public URL structure and recognized bridge commands, but redact absolute local-path components inside URLs. Balance closing punctuation that was opened inside a path, while retaining Markdown/shell terminators outside the path. Keep malformed Telegram update IDs terminal and fail closed; T-158 again classified that behavior as informational and deliberate.
**Evidence:** `npm run check` passed; `npm test` = 109 passed, 0 failed; the T-158 repro set changed from six confirmed leaks/slowdowns to complete redaction with 8K/16K/32K digit scans at linear cost; two independent x64 builds were byte-identical; package verification matched 33/33 product files byte-for-byte; packaged Node 24.18.0 executed successfully; zero unexpected credential matches. Verification-only package SHA-256: `3488def82fc0d8d078ca57d53412fbbe16ef82ce67984e32d5a676de1a68cdf5`.
**Release gate:** No push, publication, deployment, service restart, or live Telegram action was performed. A fresh independent review and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-independent-review-T-156-remediation] — 06Aug2026 21:44 AST
**By:** Codex Mini
**What:** Closed every actionable finding from independent review T-156: redacted absolute paths beside Markdown and prose punctuation; preserved Telegram slash commands and URLs; stopped path capture at a single `&`; corrected secret replacement so match offsets cannot leak into output; restored safe-mode coverage with complete approval-broker contexts; and moved deterministic ZIP creation into a directly exercised helper module.
**Why:** The reviewed candidate could expose punctuation-wrapped paths, redact bridge commands, consume a single command separator, prefix redaction markers with match offsets, weaken safe-mode test coverage, and prove reproducibility only through static source assertions. The first URL-preservation implementation also exposed a quadratic scan on very long non-URL text; the full R-05 regression isolated it and the bounded RFC-style scheme match restored linear behavior.
**Decision:** Keep malformed Telegram update IDs terminal and fail closed; T-156 classified that restart behavior as deliberate and did not recommend changing it. Preserve recognized bridge commands and syntactically valid `scheme://` URLs while redacting nearby absolute paths.
**Evidence:** `npm run check` passed; `npm test` = 107 passed, 0 failed; two independent x64 builds were byte-identical; package verification matched 33/33 product files byte-for-byte; the packaged Node runtime reported 24.18.0; only the intentional non-secret example token literal matched the product credential scan. Verification-only package SHA-256: `8f1aa1e413bd784e5a673a63dd42c8018846dd5ee5380f96b0407b50d01dd6e6`.
**Release gate:** No publish, push, deployment, or live Telegram action was performed. A fresh independent review and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-independent-review-remediation] — 06Aug2026 19:01 AST
**By:** Codex Mini
**What:** Closed every actionable finding from independent review T-153: replaced the path regular expression with a linear multi-line-safe redactor; covered drive, UNC, and generic POSIX paths plus raw Telegram tokens; validated Telegram update IDs before handling or persistence; made failed error notices non-fatal while keeping durable confirmation failures explicitly fatal; accepted safe dotted tool names up to 128 characters without permitting control characters; made safe runs require a complete approval-broker context; added direct regression and performance tests; and made release ZIP ordering and timestamps deterministic.
**Why:** The prior candidate passed its suite but could expose a path followed by a newline, stall on adversarial whitespace, corrupt its offset with a nonnumeric update ID, silently launch a safe task without the strict approval MCP context, reject legitimate dotted tool names, and emit different package hashes from identical source.
**Decision:** Invalid update IDs and missing safe-mode approval contexts fail closed before executing user work. A durable state write failure remains terminal to avoid acknowledging an update only in memory. Error-notice delivery failure is logged and does not interrupt durable update confirmation. Release ZIP entries use ordinal order and the fixed ZIP epoch.
**Evidence:** `npm run check` passed; `npm test` = 104 passed, 0 failed; the reproducibility gate produced byte-identical local x64 rebuilds; package verification matched 33/33 product files byte-for-byte with zero non-fixture secret matches. The final verification-only digest is recorded in the external handoff so the archive does not contain a self-referential hash.
**Release gate:** No publish, push, deployment, or live Telegram action was performed. Fresh independent review and the disposable-bot live Telegram test remain required before release.

---

## [0.1.3-prelaunch-hardening] — 06Aug2026 08:13 AST
**By:** Codex Mini
**What:** Closed the independent review's five launch findings: approval path redaction now preserves the actionable command tail and target basename; tool names are validated and flattened; failed Telegram updates always advance the durable offset while expired callback acknowledgements are non-fatal; overlong approval requests are denied before delivery instead of being approvable with a hidden tail; and safe sessions now pass `--strict-mcp-config`.
**Why:** The 0.1.3 review candidate passed its original suite but could still show incomplete or forged approval context, loop forever on one poisoned update, and inherit unrelated MCP servers.
**Decision:** Fail closed when the complete approval summary cannot fit the safe display bound. Keep durable update confirmation before restart actions on success and in a final guard on failure. Do not publish or deploy this candidate until a fresh independent review and the disposable-bot live Telegram test pass.
**Evidence:** `npm test` = 97 passed, 0 failed; syntax checks passed; local x64 package verification matched 33/33 product files with zero product secret matches. Verification-only package SHA-256: `df85d946d65fb95a4877c981f52963c20a758a1fc9c26edfcdc86462c7aa0291`.
**Bugs caught:** The first poison-update fix confirmed the update only after the restart callback; the full suite caught this ordering regression, and the final implementation confirms successful restart updates before the callback while retaining the failure-path guard.

---

## [0.1.3] — 05Aug2026
**By:** cc-telegram-bridge team
**What:** Added owner-only one-time Telegram approval buttons backed by Claude Code's structured permission prompt tool; all denial, timeout, replay, identity mismatch, task stop, and bridge shutdown paths fail closed. Added clickable help actions, version-aware model labels, persisted effort selection, immediate and recurring typing, one minute-based progress message, explicit status/diagnostics, and copy-safe mixed Arabic/LTR formatting.
**Why:** Close the remaining pre-launch trust and usability gaps for an Arabic-first, non-technical audience without weakening the existing owner-only, durable-outbox, state-recovery, DPAPI, or supervisor guarantees.
**Decision:** Safe mode uses the exact live structured Claude permission request and never accepts typed approval. Unrestricted mode keeps the explicit dangerous bypass and remains limited to dedicated devices. Approval arguments stay in memory only.
**Evidence:** Isolated allow/deny/broker-loss proof on Claude Code 2.1.220; commits `a25ea32`, `ea8d1e0`, and `4e506ee`; automated release gates and the 0.1.3 candidate archive are recorded in the independent-review delivery report.
**Known limits:** Live Telegram visual validation remains intentionally deferred to the separate independent-review card. Live answer streaming and online model discovery remain out of scope.

---

## [0.1.2] — 31Jul2026
**By:** cc-telegram-bridge team
**What:** Added `MANUAL.html` (illustrated Arabic guide, later redesigned with an editorial "midnight-desk" visual treatment) shipped with the package; added `/model`, `/restart`, and `/diagnose` commands with a model-picker section in the manual; hardened restart recovery and diagnostics (`fix(commands)`); made disk markers the only child-intent signal for the supervisor (see `docs/adr/0001-marker-only-supervisor-intent.md` — replaces the unreliable PowerShell 5.1 `Process.ExitCode`).
**Why:** Close the gap between shipped documentation and actual command surface; remove a flaky supervisor-intent signal ahead of public release.
**Decision:** Disk markers are now the sole source of truth for "does the child intend to exit" — no more relying on process exit codes on PowerShell 5.1.
**Evidence:** `dist/cc-telegram-bridge-0.1.2-win-x64.zip` (+ sha256); commits `494c3a6`, `52a42de`, `3f9d459`, `65b3d6e`, `02a6614`, `e438720`.
**Bugs caught:** Process.ExitCode proved unreliable as a supervisor-intent signal on PowerShell 5.1 — root cause of a prior restart-recovery bug class, fixed by the marker-only redesign.

---

## [0.1.1] — 28-29Jul2026
**By:** cc-telegram-bridge team
**What:** Closed independent review findings across four review rounds: initial findings, second-review N-01..N-09, third-review integration findings, fourth-review release blockers. Corrected outbox capacity description in docs and recorded a known limit.
**Why:** Pre-release hardening driven by independent review before wider distribution.
**Decision:** All four review rounds' blocking findings resolved before proceeding to 0.1.2 feature work.
**Evidence:** `dist/cc-telegram-bridge-0.1.1-win-x64.zip` (+ sha256); commits `bde58b9`, `0888eaf`, `17c7cb3`, `a981619`, `df82957`.

---

## [0.1.0] — 26-27Jul2026
**By:** cc-telegram-bridge team
**What:** Initial build of the secure Telegram bridge core; repository text-file normalization; copyright holder and package author set; Windows launcher and portable release build.
**Why:** First public-facing release build of the Claude Code Telegram bridge.
**Decision:** —
**Evidence:** `dist/cc-telegram-bridge-0.1.0-win-x64.zip`; commits `75bf251`, `e31367c`, `078ed95`, `98595fa`.
