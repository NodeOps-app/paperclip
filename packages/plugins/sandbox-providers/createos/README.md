# `@paperclipai/plugin-createos`

CreateOS sandbox provider for Paperclip. This package lives alongside Daytona
and E2B, outside the root pnpm workspace, and uses CreateOS's public HTTP API.
No CreateOS SDK dependency is required; the `tar` library handles local archives. The package has not been published as
part of this change; use a local-path install for development. Its release
manifest entry has `publishFromCi: false` until a maintainer bootstraps the first
npm publish and enables CI publishing.

## Build and install locally

Requires Node 24.11+, pnpm, and an installed Paperclip checkout.

```sh
cd packages/plugins/sandbox-providers/createos
pnpm install --ignore-workspace --no-lockfile
pnpm typecheck
pnpm test
pnpm build
```

From the Paperclip checkout, with your instance running:

```sh
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin install /absolute/path/to/paperclip/packages/plugins/sandbox-providers/createos
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin list
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin inspect paperclip.createos-sandbox-provider
```

Rebuild after source changes; local plugin output watching reloads the worker.
If the running worker still uses the previous build, explicitly reload it when
no sandbox commands are active:

```sh
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin disable paperclip.createos-sandbox-provider
node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts plugin enable paperclip.createos-sandbox-provider
```

The plugin uses the same package entrypoints and publish manifest helper as
other sandbox providers. Plugin workers are trusted code on the Paperclip host.

## Configure an environment

Configure the provider under **Instance Settings → Environments**. The plugin
has no custom UI. Required fields:

- `apiUrl`: defaults to `https://api.sb.createos.sh`. A trailing `/v1`
  is accepted and normalized. HTTPS is required except on loopback for testing.
- `shape`: choose from the dropdown of published CreateOS shapes. The bundled
  choices match `https://api.sb.createos.sh/v1/shapes` as of 2026-09-08.
- `apiKey`: your CreateOS key. Paperclip saves pasted keys as company secrets;
  a resolved environment key takes precedence over the optional host fallback
  `CREATEOS_API_KEY` for `https://api.sb.createos.sh` only. Custom API endpoints,
  including loopback fixtures, require an explicit environment key. The host
  forwards this fallback only to the trusted
  CreateOS package installed from the repository or bundled plugin catalog
  (or from the first-party npm scope after publication). Other local plugin
  paths must use an environment-configured key.

Optional fields:

- `rootfs`: a rootfs catalog entry or a ready template ID/name; omission uses
  the provider default. The image must include `/bin/bash`, ordinary Unix
  utilities including `tar`, `base64`, and GNU `realpath` (`-m` support), and the selected adapter's runtime
  dependencies (such as Node and Git). The generic runtime provisions/stages
  agent assets; this plugin does not build an agent image.
- `rootfsByAdapter`: optional adapter-to-rootfs map. For each newly acquired
  lease, `rootfsByAdapter[adapterType]` overrides `rootfs`; changing the
  effective image expires a reusable lease before any provider API call.
- `egressAllowlist`: base list of allowed FQDNs and CIDRs. Paperclip merges it
  with the run's `networkEgress.allowFqdns` and `allowCidrs`. Missing, empty,
  `null`, and `["*"]` use CreateOS allow-all semantics; a non-empty restrictive
  list is deny-by-default. A wildcard is removed when restrictive entries are
  also present. There is no synthetic deny-all rule.
- `region`: must match the API endpoint. Omission uses the provider default.
- `timeoutMs`: operation/default command deadline, 300000 ms by default. This
  is **not** a sandbox TTL.
- `reuseLease`: default false. False deletes on release. True leaves the sandbox
  warm after release and later reuses the same sandbox, preserving workspace data.
- `autoPauseAfterSeconds`: for reusable leases, the CreateOS-native inactivity
  window before the warm sandbox pauses. Defaults to 600 seconds; valid values
  are 60–86400. Paperclip resumes an auto-paused sandbox on the next run. This
  is an idle-cost control, not a guaranteed sandbox expiry.

The probe creates a sandbox, prepares its workspace, executes a managed
command, and deletes the sandbox. It therefore uses real provider resources.

## Implemented behavior

- Company/environment-bound lease metadata and a random workspace marker
  checked before a resumed lease is trusted. API keys are not lease metadata.
- Provider-native idle pause for reusable leases. Paperclip leaves a released
  sandbox warm, then accepts either `running` or auto-paused state on the next
  resume. Transient errors are surfaced; only missing/terminal sandboxes or a
  mismatched workspace expire a resume.
- Creation-time egress policy and live egress replacement before a reusable
  sandbox resumes. The base policy, effective per-run policy, adapter, and
  effective rootfs are recorded without credentials in lease metadata.
- Managed pipe processes with explicit working directory, quoted arguments,
  per-command environment, staged stdin, and separate stdout/stderr.
  Per-command variables are applied by the command wrapper; CreateOS's API-level
  environment overrides only accept keys declared at sandbox creation.
- Incremental output via replayable NDJSON, bounded reconnect attempts, UTF-8
  decoding across frame boundaries, and explicit errors for missing output.
  Returned stdout/stderr each retain at most 4 Mi characters of tail output;
  `metadata.outputTruncated` reports truncation. Live log chunks are still
  delivered as they arrive.
- API requests to each endpoint are spaced by at least 300 ms across this
  worker's leases, keeping callback polling below the provider's 300/minute
  IP limit. Other workers or applications sharing the same IP can still
  exhaust that shared limit.
- Command timeout and active lease-release/shutdown cancellation explicitly
  terminate the process tree. Disconnecting the stream alone is not cancellation.
  Unknown process-creation outcomes and failed process cleanup prevent reuse
  in the current worker; the operator/host must destroy the affected lease.
  No automatic retry of process creation or command execution occurs.
- Workspace realization at `/paperclip-workspace` and native binary file sync,
  including directory archives, file modes, exclusions, symlink containment,
  atomic file downloads, and ordered post-upload commands. This keeps bulk data
  out of CreateOS's 1 MiB managed-process output journal. Ordinary command
  output still uses that journal and fails explicitly if unread data is evicted.
  Outbound archives are validated before extraction and limited to 10 GiB of
  declared file data; absolute/traversing paths and escaping links are rejected.
- Concurrent inbound/outbound sync. Every call owns random sandbox scratch
  paths and independent host temporary directories; teardown waits for all
  active calls.
- Interactive setup-token login PTYs for Claude, Codex, and Grok. The command
  is selected from a closed key set, the host-controlled session home is
  revalidated, and asdf-backed executables are resolved before switching to
  that isolated home, with their runtime bin directory placed first on PATH.
  The CreateOS PTY starts at 120 columns by 30 rows. The
  current Paperclip login hook has no resize method, so live PTY resize is not
  advertised or emulated.
- Persistent duplex command channels over CreateOS pipe processes. Binary
  input is decoded from the plugin wire format, serialized and split into
  provider-safe 256 KiB writes; stdout is forwarded as raw bytes. Stop and
  release send SIGTERM and require a whole-tree deletion receipt.

## Capability boundaries

Temporary login leases, snapshot capture, dynamic login PTY resize, and
provider WebSocket ingress are not advertised. Login PTYs and duplex command
channels require a lease acquired or resumed by the current worker; after a
worker restart they fail closed until the host restores that lease.
Paperclip's Claude setup-token flow additionally requires a provider-attested
absolute lease expiry. CreateOS has no hard TTL, and provider-native idle pause
does not satisfy that guarantee, so this plugin continues to reject
`requestedExpiresAt`; therefore that bounded setup-token flow remains
unavailable. The PTY hooks are
usable by login/session flows that do not request a guaranteed expiry.
Acquisition with `requestedExpiresAt` fails before provisioning a resource.

The host has an outbound-WSS native runner path for providers without ingress.
Using it additionally requires a reachable Paperclip runner endpoint and the
host's qualified runner/provider artifacts. This plugin's local tests do not
constitute an end-to-end native runner qualification.

Sandbox create has no idempotency key in the inspected API. If its response is
lost before an ID arrives, the plugin cannot identify that resource for cleanup;
inspect the provider account before retrying an ambiguous creation. A plugin
crash also loses its in-memory command tracking; durable lease recovery remains
host-owned. This version does not claim a provider-side expiration guarantee.

## Opt-in live smoke

Default tests use mocked HTTP responses and do not contact CreateOS. To test a
chosen endpoint, export `CREATEOS_API_URL`, `CREATEOS_API_KEY`, `CREATEOS_SHAPE`,
and optionally `CREATEOS_ROOTFS`, then run:

```sh
CREATEOS_LIVE_TEST=1 pnpm test
```

The live test creates a sandbox, overlaps native sync-in and sync-out while
round-tripping a 5 MiB binary file, checks stdin/env/output, optional
`CREATEOS_EGRESS_ALLOWLIST` configuration, a duplex echo/stop/close cycle, and
a 120×30 PTY `stty size` result, writes a file, releases and resumes the warm
sandbox, verifies the file, and deletes it in `finally`.
It does not print credentials. Cleanup errors fail the test.

## Optional managed-image inclusion

The bundled catalog key is `createos`. Include the `createos` directory in the
Docker `CLOUD_BUNDLED_PLUGINS` build argument, then include `createos` in the
managed configuration's `plugins.autoInstall` list. Adding the catalog entry
does not auto-install the plugin or change the default image contents.
