---
title: "feat(createos): add provider safety and channel capabilities"
status: ready_for_review
owner: Bhautik
repository: NodeOps-app/paperclip
issue: https://github.com/NodeOps-app/paperclip/issues/2
related_issues:
  - https://github.com/NodeOps-app/paperclip/issues/3
branch: feat/createos-provider-capabilities
pull_requests:
  - https://github.com/NodeOps-app/paperclip/pull/6
dependencies:
  - "CreateOS live endpoint, API key, shape, adapter-ready rootfs, and Claude test login for the opt-in smoke"
  - "GitHub CI, Greptile, and maintainer review"
last_synced: 2026-09-28
---

# Outcome

CreateOS environments can restrict outbound traffic, select an adapter-compatible rootfs, host interactive adapter login PTYs, and carry the native duplex command stream without weakening lease reuse or cleanup guarantees.

## Context and evidence

- The CreateOS provider landed in upstream commit `a8d32e5e6` (`feat(sandbox-providers): add CreateOS sandbox provider (#13434)`). Its current create body contains `shape`, optional `rootfs` and `region`, and `ingress_enabled: false`; it sends no `egress` policy.
- `PluginEnvironmentAcquireLeaseParams` already carries `adapterType` and `executionWorkspaceSettings`. The Kubernetes provider parses `executionWorkspaceSettings.networkEgress`; CreateOS currently ignores both fields.
- A reusable CreateOS lease is invalidated only when `shape`, `rootfs`, or `region` changes. This cannot distinguish two adapters that resolve to different images.
- The CreateOS API contract accepts `egress` on create and `PUT /v1/sandboxes/{id}/egress` later. A missing list, `null`, `[]`, and `["*"]` all mean allow-all. Any other non-empty list is deny-by-default. There is no explicit deny-all representation.
- `file-sync.ts` has no shared per-transfer state: remote scratch paths use UUIDs, host temporary directories are per call, and plugin shutdown/release already tracks every active call. This supports concurrent inbound and outbound sync once regression and live tests prove it.
- Issue #3 uses the existing plugin SDK hooks. CreateOS's managed-process API already supplies PTY/pipe creation, replayable output, input, signals, stdin close, wait, and tree deletion. `execute.ts` already implements most of the replay/gap/410 handling, but it is coupled to one-shot execution.
- The current CreateOS worker does not cache a provider lease lookup usable by login or duplex hooks. Those hooks receive company, environment, and provider lease IDs but no environment config, so acquisition/resume must register an in-memory, ownership-checked lease connection and release/destroy/shutdown must remove it.
- The plugin contract has no login-PTY resize hook. Issue #3's dynamic resize criterion cannot be implemented without a contract change; this PR will use the Daytona-compatible initial size of 120 columns by 30 rows and prove it with `stty size`, but will not add a new SDK/server verb.
- This work is one provider-only PR. It does not change database, shared API, server, or UI contracts. Local `master` was fast-forwarded to `origin/master` at `0f14d2612` before planning.

## Decisions

- Add `egressAllowlist: string[]` and `rootfsByAdapter: Record<string, string>` to both runtime parsing and the manifest schema. Runtime parsing remains authoritative; the form schema is not the security boundary.
- Normalize allowlists by trimming, rejecting empty/control-character entries, preserving CreateOS rule syntax, removing duplicates, and removing `"*"` when any restrictive rule is present. An empty configured list and omission both retain CreateOS allow-all behavior; do not invent an unroutable deny-all sentinel.
- Parse the task grant with the Kubernetes convention: read `networkEgress.allowFqdns` and `networkEgress.allowCidrs`, trim/deduplicate them, then union them with `egressAllowlist`. Send the effective non-empty list in the create request and store it in lease metadata. Reapply that exact list with `PUT /egress` before resuming the VM so restored provider state cannot silently reopen traffic. If the configured base allowlist has changed, expire the reusable lease and acquire a new one.
- Resolve the rootfs once per acquisition as `rootfsByAdapter[params.adapterType] ?? rootfs`. Store the effective adapter type and resolved rootfs in lease metadata. On resume, recompute them from current config and expire the lease before any API call when either differs. Unknown or absent adapters use the existing `rootfs` fallback.
- Add `concurrentSyncOperations: true` only after a unit test overlaps sync-in and sync-out on one lease and the live smoke completes the same overlap with exact byte checks and cleanup.
- Extract a narrow managed-process stream primitive from `execute.ts`: create once, follow NDJSON from a sequence cursor, reconnect only transport failures, reject gaps/invalid frames/missing terminal status, and translate HTTP 410 or `output_offset_expired` into one stable eviction error. Keep ordinary execute behavior unchanged.
- Register active CreateOS lease connections in worker memory during acquire and resume. Resolve login/duplex opens only when provider lease, company, and environment match. A worker restart or unknown lease fails closed; no API key enters lease metadata, output, or an error.
- Implement login PTY with a closed `claude | codex | grok` command map and the exact `/tmp/paperclip-adapter-login/<uuid>` home check used by Daytona. Create the home, start a 120x30 PTY, forward only `stream: "pty"`, buffer output until notification binding exists, batch burst input below CreateOS's 256 KiB request limit, report exit once, and make stop/close idempotent while confirming tree termination.
- Implement duplex channels as pipe-mode managed processes, not an undocumented shell WebSocket. Shell-quote every command argument, carry raw process bytes through the SDK's base64 wire helpers, bind writes/stops to the exact host-route/worker-session pair, batch input through the request pacer, and distinguish process exit from transport loss.
- Advertise `supportsLoginPty: true` and `duplexCommandStream: true` only when all four hook lifecycles exist and their unit/live tests pass. Rely on the existing server capability resolver; make no server contract change.
- Preserve current fail-closed behavior: acquisition failures destroy the sandbox; egress-application or workspace-setup failures cannot return a lease; resume failures do not destroy a lease unless absence/terminal state is confirmed; provider bodies and API keys never enter errors or metadata.
- Configure CreateOS-native idle auto-pause for reusable leases with a 600-second default and a validated 60–86400 second override. Normal release leaves a safely drained sandbox warm instead of pausing it immediately; resume accepts running or provider-paused state. Keep `requestedExpiresAt` rejected because idle pause is not a guaranteed expiry.

## Scope

- [x] Update `packages/plugins/sandbox-providers/createos/src/config.ts` with runtime parsing, normalization helpers, adapter-rootfs resolution, and validation for the two new settings.
- [x] Update `src/manifest.ts` with matching JSON Schema fields and operator-facing descriptions; bump the plugin version because the public configuration and capability declaration change.
- [x] Extend `src/client.ts` so create accepts the resolved rootfs and effective egress, and add a bounded `PUT /sandboxes/{id}/egress` helper that uses the existing redacted error path.
- [x] Update `src/plugin.ts` to consume `adapterType` and task-scoped egress, persist only non-secret normalized lease identity, expire incompatible reusable leases, and reapply stored egress before transition to running.
- [x] Refactor `src/execute.ts` only enough to share managed-process creation, replayable output following, terminal validation, eviction handling, and process-tree cleanup with persistent sessions.
- [x] Add focused CreateOS login-PTY and duplex session support. Wire all eight hooks and the ownership-checked in-memory lease registry through `src/plugin.ts`; drain sessions before lease release/destroy and during shutdown.
- [x] Extend `src/plugin.test.ts` and `src/file-sync.test.ts` for validation, create payloads, merge/deduplication, open-egress omission, resume reapplication and ordering, config/image mismatch expiry, error cleanup, overlapping sync calls, manifest capability resolution, route/session isolation, batching, reconnects, 410, exit-once, and idempotent stop/close.
- [x] Extend `src/plugin.live.test.ts` with concurrent transfer, exact-byte, fixed-size PTY, duplex echo/stop/close, reuse, and final-destroy coverage. Live egress allow/deny and orphan inspection still require credentials and endpoints.
- [ ] Run a Paperclip setup-token login against the CreateOS environment and record redacted end-to-end evidence without retaining the login code or credential.
- [x] Update `README.md` with field examples, merge precedence, allow-all/no-deny-all semantics, adapter fallback behavior, reuse invalidation, concurrent-sync support, PTY/duplex boundaries, fixed initial terminal size, journal-eviction behavior, and live-test variables.
- [x] Prepare one PR from `feat/createos-provider-capabilities`; use every section of `.github/PULL_REQUEST_TEMPLATE.md`, link `Closes: NodeOps-app/paperclip#2` after native auto-pause live proof and `Refs: NodeOps-app/paperclip#3` because dynamic resize is not in the current contract, name the security impact, record the model, and do not merge.

## Acceptance

- [ ] With no new fields, the create payload and lifecycle remain backward-compatible and egress stays open.
- [ ] With a base allowlist plus task FQDN/CIDR grants, create receives their normalized union; a configured allowed endpoint succeeds and an unlisted endpoint fails in the live sandbox.
- [ ] Resume applies the stored egress policy before the sandbox becomes available to Paperclip; a mock ordering assertion and post-resume live denial prove it.
- [ ] Empty strings, control characters, invalid container types, and invalid `rootfsByAdapter` keys/values fail validation before a provider request.
- [x] Reusable create requests carry the configured native auto-pause window, normal release leaves the sandbox warm, and resume handles both running and provider-paused state; `requestedExpiresAt` still fails before provisioning because idle pause is not a guaranteed expiry.
- [ ] `codex_local` and `claude_local` can resolve different rootfs values. Changing adapter or its resolved rootfs expires a reusable lease without contacting the old sandbox.
- [ ] Concurrent sync-in and sync-out use independent scratch state, preserve exact bytes, wait for cleanup on release, and justify `concurrentSyncOperations: true`.
- [ ] Login open accepts only the three fixed command keys and the exact server-controlled home shape; delayed input reaches the PTY, split UTF-8 remains intact, `stty size` reports the fixed 30 rows by 120 columns, exit is sent once, and stop/close leave no process tree.
- [ ] Duplex open safely executes an argument vector; exact-pair writes round-trip arbitrary bytes, foreign/malformed writes do nothing, 410/gaps/missing exit fail closed, stop kills the tree, and route-only close handles a lost open reply.
- [ ] Worker shutdown and lease release/destroy stop and drain all bound PTY/duplex sessions before pausing or deleting the sandbox. Unknown or cross-company lease IDs make no CreateOS request.
- [ ] The manifest advertises `supportsLoginPty`, `duplexCommandStream`, and—after its separate proof—`concurrentSyncOperations`; the existing runtime resolver reports the declared capabilities because the required worker verbs are present.
- [ ] A live CreateOS setup-token login succeeds end to end, and the smoke test confirms PTY, duplex, eviction/error handling where practical, orphan-free cleanup, and final sandbox deletion.
- [ ] Failures while applying policy or preparing the workspace attempt deletion and surface unconfirmed cleanup; errors and lease metadata contain no API key or provider response body.
- [ ] README, manifest defaults, runtime validation, tests, and package version agree.

## Verification

- `git status --short --branch`
- `git fetch origin master`
- `git switch -c feat/createos-provider-capabilities origin/master`
- `cd packages/plugins/sandbox-providers/createos && pnpm install --ignore-workspace --no-lockfile`
- `cd packages/plugins/sandbox-providers/createos && pnpm typecheck`
- `cd packages/plugins/sandbox-providers/createos && pnpm test`
- `cd packages/plugins/sandbox-providers/createos && pnpm build`
- `CREATEOS_LIVE_TEST=1 CREATEOS_API_URL="$CREATEOS_API_URL" CREATEOS_API_KEY="$CREATEOS_API_KEY" CREATEOS_SHAPE="$CREATEOS_SHAPE" CREATEOS_ROOTFS="$CREATEOS_ROOTFS" CREATEOS_EGRESS_ALLOWED_URL="$CREATEOS_EGRESS_ALLOWED_URL" CREATEOS_EGRESS_BLOCKED_URL="$CREATEOS_EGRESS_BLOCKED_URL" pnpm --dir packages/plugins/sandbox-providers/createos test`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`
- `gh pr checks --watch`
- `gh pr view --comments`

## Dependencies and handoffs

- Bhautik supplies or selects the billable CreateOS live-test account, region-compatible shape, adapter-ready rootfs values, and stable allowed/blocked HTTPS endpoints. The live test must redact credentials and delete its sandbox in `finally`.
- Bhautik supplies the test adapter login account and performs any browser/device confirmation needed for the end-to-end setup-token proof. Never put the setup token, device code, API key, or auth output in test logs or the plan.
- CreateOS API behavior is sufficient for this PR, but explicit deny-all is not representable. If Paperclip needs deny-all, open a CreateOS API follow-up instead of encoding a fake destination here.
- Dynamic terminal resize is not representable by the current login-PTY plugin contract. Keep the fixed 120x30 initial size in this branch; track dynamic resize separately if the product requires it.
- Maintainers own CI, Greptile, and final review. Address every review comment and keep the issue open until the PR is merged and the live evidence is recorded.

## Dispatch

- Base: `origin/master` at or after `0f14d2612`.
- Branch: `feat/createos-provider-capabilities`. Issues #2 and #3 share this branch and one PR.
- Owner: one implementation agent, because all edits share the provider config/lifecycle contract.
- Handoff: include unit/build output, redacted live-smoke results, sandbox cleanup confirmation, PR URL, and any suite not run with its reason.

## Progress

- 2026-09-28: Read issue #2, merged CreateOS provider code/tests/docs, the plugin SDK lease contract, Kubernetes task-scoped egress behavior, and Daytona lease identity/capability precedent.
- 2026-09-28: Fast-forwarded local `master` from `297d8741f` to `origin/master` at `0f14d2612` and removed auto-pause from the planned implementation at Bhautik's direction.
- 2026-09-28: Read issue #3 and folded login PTY plus duplex hooks into the same planned branch. Recorded the missing dynamic-resize contract instead of creating a second branch or expanding the SDK/server contract.
- 2026-09-28: Plan marked `next`; the remaining dependencies are execution credentials and review systems, not design decisions.
- 2026-09-28: Implemented the provider/config/process/session changes on `feat/createos-provider-capabilities`; provider typecheck, 59 unit tests, provider build, and workspace-wide typecheck pass. Live credentials are not present.
- 2026-09-28: Confirmed the host's Claude setup-token path requires a provider-attested absolute expiry. CreateOS idle auto-pause is not a hard TTL, so `requestedExpiresAt` remains rejected; the PTY hooks work for unbounded login/session flows but the bounded setup-token acceptance item remains intentionally open.
- 2026-09-28: Bhautik superseded the earlier auto-pause exclusion. Added CreateOS-native idle pause as the reusable-lease warm window while preserving the guaranteed-expiry rejection.
- 2026-09-28: Verified both lifecycle modes against CreateOS. A disposable sandbox omitted `auto_pause_after_seconds`, executed successfully, and was explicitly deleted. A reusable sandbox reported a 60-second window, auto-paused, resumed as the same sandbox, retained its workspace marker, and was deleted. The focused plugin lifecycle suite passed all 47 tests.
- 2026-09-28: Repeated the reusable lifecycle after the CreateOS paused-sandbox egress `503` fix. Paperclip reapplied egress, resumed the same auto-paused sandbox, executed a command, and preserved its workspace marker.
- 2026-09-28: Opened PR #6. It closes issue #2, references issue #3, and leaves issue #4 out of scope.

## Result and retro

Implementation is ready for review. Issue #2 is implemented and live-proven except for the optional external allow/deny endpoint check. Issue #3's login PTY and duplex hooks are implemented and tested, while dynamic PTY resize and the hard-expiry setup-token flow remain explicitly out of scope. After merge, record the PR, final CI checks, cleanup result, and whether review found a reusable provider-safety rule.
