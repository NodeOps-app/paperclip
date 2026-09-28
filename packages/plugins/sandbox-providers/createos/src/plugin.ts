import { randomUUID, createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { decodeChannelBytes, definePlugin } from "@paperclipai/plugin-sdk";
import type {
  PluginContext, PluginEnvironmentAcquireLeaseParams, PluginEnvironmentDriverBaseParams,
  PluginEnvironmentExecuteParams, PluginEnvironmentLease, PluginEnvironmentReleaseLeaseParams,
} from "@paperclipai/plugin-sdk";
import { CreateosApiError, CreateosClient, object } from "./client.js";
import { parseConfig, resolveApiKey, resolveEgressAllowlist, resolveRootfs, type CreateosConfig } from "./config.js";
import { CreateosCleanupError, execute, shellQuote } from "./execute.js";
import { syncFiles } from "./file-sync.js";
import { openManagedProcess, type ManagedProcessSession } from "./process-session.js";

const CWD = "/paperclip-workspace";
// The host excludes .paperclip-runtime from workspace export, so the lease
// marker never becomes a user repository file.
const MARKER = `${CWD}/.paperclip-runtime/.paperclip-createos-lease`;

function loginScript(command: readonly string[], environment: string[]): string {
  const executable = shellQuote(command[0]);
  const args = command.slice(1).map(shellQuote);
  return [
    `login_command="$(command -v ${executable})" || exit 127`,
    `login_path="$PATH"`,
    // Resolve asdf while the sandbox's normal HOME is still active. The
    // isolated login HOME intentionally has no asdf installation metadata.
    // Prepending the resolved bin directory also lets /usr/bin/env shebangs
    // find the matching runtime without falling back through the asdf shim.
    `case "$login_command" in */.asdf/shims/*) login_command="$(asdf which ${executable})" || exit 127; login_path="\${login_command%/*}:$login_path" ;; esac`,
    `[ -x "$login_command" ] || exit 126`,
    `exec env ${environment.join(" ")} PATH="$login_path" "$login_command"${args.length > 0 ? ` ${args.join(" ")}` : ""}`,
  ].join("; ");
}

function metadataMatches(params: PluginEnvironmentDriverBaseParams, metadata?: Record<string, unknown>): boolean {
  return metadata?.provider === "createos" && metadata.companyId === params.companyId &&
    metadata.environmentId === params.environmentId && metadata.apiUrl === parseConfig(params.config).apiUrl;
}

async function acquire(params: PluginEnvironmentAcquireLeaseParams): Promise<PluginEnvironmentLease> {
  // An idle timeout or a host-local timer cannot supply a provider expiry.
  if (params.requestedExpiresAt) throw new Error("CreateOS does not yet support leases with a guaranteed expiration deadline.");
  const config = parseConfig(params.config);
  const client = new CreateosClient(config);
  const signal = AbortSignal.timeout(config.timeoutMs);
  const effectiveRootfs = resolveRootfs(config, params.adapterType);
  const effectiveEgress = resolveEgressAllowlist(config, params.executionWorkspaceSettings);
  // Login leases deliberately carry no issue or execution workspace. They are
  // always disposable even when the environment enables reuse.
  const effectiveAutoPause = config.reuseLease && (params.issueId || params.executionWorkspaceId)
    ? config.autoPauseAfterSeconds
    : null;
  const sandbox = await client.createSandbox(signal, {
    rootfs: effectiveRootfs,
    egress: effectiveEgress,
    autoPauseAfterSeconds: effectiveAutoPause,
  });
  try {
    await client.transition(sandbox.id, "running", signal);
    const data = await client.json(`/sandboxes/${sandbox.id}/exec`, "POST", {
      cmd: "/bin/bash", args: ["-lc", `mkdir -p -- ${shellQuote(CWD)}`],
    }, signal);
    if (object(data.result).exit_code !== 0) throw new Error("CreateOS workspace preparation failed; the image must provide Bash.");
    const marker = randomUUID();
    await client.upload(sandbox.id, MARKER, marker, signal);
    return {
      providerLeaseId: sandbox.id,
      metadata: {
        provider: "createos", apiUrl: config.apiUrl,
        companyId: params.companyId, environmentId: params.environmentId,
        remoteCwd: CWD, shellCommand: "bash", marker,
        shape: config.shape, rootfs: effectiveRootfs, adapterType: params.adapterType ?? null,
        region: config.region, baseEgressAllowlist: config.egressAllowlist,
        effectiveEgressAllowlist: effectiveEgress,
        reuseLease: config.reuseLease,
        autoPauseAfterSeconds: effectiveAutoPause,
      },
    };
  } catch (error) {
    try { await client.destroySandbox(sandbox.id); }
    catch { throw new Error(`CreateOS setup failed and cleanup is unconfirmed for sandbox ${sandbox.id}.`); }
    throw error;
  }
}

// Each worker owns its own transient lifecycle state. The host owns durable leases.
export function createPlugin() {
  let ctx: PluginContext | null = null;
  let shuttingDown = false;
  type Active = { controller: AbortController; done: Promise<void> };
  const active = new Map<string, Set<Active>>();
  const closing = new Set<string>();
  const unconfirmedCleanup = new Set<string>();
  type LeaseEntry = { companyId: string; environmentId: string; config: CreateosConfig };
  const leases = new Map<string, LeaseEntry>();
  type SessionEntry = {
    hostRouteId: string;
    workerSessionId: string;
    providerLeaseId: string;
    session: ManagedProcessSession;
  };
  const loginByRoute = new Map<string, SessionEntry>();
  const loginBySession = new Map<string, SessionEntry>();
  const duplexByRoute = new Map<string, SessionEntry>();
  const duplexBySession = new Map<string, SessionEntry>();

  function registerLease(params: PluginEnvironmentDriverBaseParams, id: string) {
    leases.set(id, { companyId: params.companyId, environmentId: params.environmentId, config: parseConfig(params.config) });
  }

  function resolveLease(params: { companyId: string; environmentId: string; providerLeaseId: string }): LeaseEntry {
    const lease = leases.get(params.providerLeaseId);
    if (!lease || lease.companyId !== params.companyId || lease.environmentId !== params.environmentId) {
      throw new Error("CreateOS session requires a lease cached for this environment.");
    }
    return lease;
  }

  function forget(entry: SessionEntry, routes: Map<string, SessionEntry>, sessions: Map<string, SessionEntry>) {
    if (routes.get(entry.hostRouteId) === entry) routes.delete(entry.hostRouteId);
    if (sessions.get(entry.workerSessionId) === entry) sessions.delete(entry.workerSessionId);
  }

  async function stopLeaseSessions(providerLeaseId: string, tolerateFailure: boolean) {
    const entries = [...loginByRoute.values(), ...duplexByRoute.values()]
      .filter((entry) => entry.providerLeaseId === providerLeaseId);
    const results = await Promise.allSettled(entries.map((entry) => entry.session.close()));
    if (!tolerateFailure) {
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
    for (const entry of entries) {
      forget(entry, loginByRoute, loginBySession);
      forget(entry, duplexByRoute, duplexBySession);
    }
  }

  function key(params: PluginEnvironmentDriverBaseParams, id: string): string {
    const config = parseConfig(params.config);
    const account = createHash("sha256").update(resolveApiKey(config)).digest("hex");
    return JSON.stringify([params.companyId, params.environmentId, config.apiUrl, account, id]);
  }

  async function stopActive(scope: string) {
    const calls = [...(active.get(scope) ?? [])];
    for (const call of calls) call.controller.abort();
    await Promise.all(calls.map((call) => call.done));
  }

  async function track<T>(
    params: PluginEnvironmentDriverBaseParams & { lease: PluginEnvironmentLease },
    work: (client: CreateosClient, signal: AbortSignal) => Promise<T>,
    timeoutOverride?: number,
  ): Promise<T> {
    if (!params.lease.providerLeaseId || !metadataMatches(params, params.lease.metadata)) throw new Error("CreateOS execution requires a lease from this environment.");
    const scope = key(params, params.lease.providerLeaseId);
    if (shuttingDown || closing.has(scope) || unconfirmedCleanup.has(scope)) throw new Error("CreateOS lease is closing or requires cleanup.");
    const config = parseConfig(params.config);
    const timeoutMs = timeoutOverride ?? config.timeoutMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) throw new Error("Invalid CreateOS command timeout.");
    const controller = new AbortController();
    let finish!: () => void;
    const entry: Active = { controller, done: new Promise<void>((resolve) => { finish = resolve; }) };
    const calls = active.get(scope) ?? new Set<Active>();
    calls.add(entry);
    active.set(scope, calls);
    try {
      return await work(new CreateosClient(config), AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]));
    } catch (error) {
      if (error instanceof CreateosCleanupError) unconfirmedCleanup.add(scope);
      throw error;
    } finally {
      calls.delete(entry);
      if (calls.size === 0) active.delete(scope);
      finish();
    }
  }

  async function release(params: PluginEnvironmentReleaseLeaseParams, destroy: boolean) {
    const id = params.providerLeaseId;
    if (!id) return;
    if (!metadataMatches(params, params.leaseMetadata)) throw new Error("CreateOS lease does not belong to this environment.");
    const scope = key(params, id);
    if (closing.has(scope)) throw new Error("CreateOS lease cleanup is already in progress.");
    closing.add(scope);
    try {
      try { await stopLeaseSessions(id, destroy); }
      catch (error) {
        unconfirmedCleanup.add(scope);
        throw error;
      }
      await stopActive(scope);
      const config = parseConfig(params.config);
      const client = new CreateosClient(config);
      const leaseAutoPause = params.leaseMetadata?.autoPauseAfterSeconds;
      const reusableWithProviderGuard = config.reuseLease && leaseAutoPause === config.autoPauseAfterSeconds;
      if (destroy || !reusableWithProviderGuard) {
        await client.destroySandbox(id);
        unconfirmedCleanup.delete(scope);
      } else {
        if (unconfirmedCleanup.has(scope)) throw new Error("CreateOS process cleanup is unconfirmed; destroy this lease before reusing it.");
        // Keep the sandbox warm. CreateOS pauses it after the configured idle
        // window; a later resume accepts either its running or paused state.
      }
    } finally {
      leases.delete(id);
      closing.delete(scope);
    }
  }

  return definePlugin({
    async setup(context) { ctx = context; ctx.logger.info("CreateOS sandbox provider ready"); },
    async onHealth() { return { status: "ok", message: "CreateOS provider loaded; probe an environment to check connectivity." }; },
    async onEnvironmentValidateConfig(params) {
      try { return { ok: true, normalizedConfig: { ...parseConfig(params.config) } }; }
      catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "Invalid CreateOS configuration."] }; }
    },
    async onEnvironmentProbe(params) {
      let lease: PluginEnvironmentLease | null = null;
      try {
        lease = await acquire({ ...params, runId: "probe" });
        const result = await execute(new CreateosClient(parseConfig(params.config)), {
          ...params, lease, command: "/bin/echo", args: ["paperclip-createos-ready"], cwd: CWD,
        }, AbortSignal.timeout(parseConfig(params.config).timeoutMs));
        if (result.timedOut || result.exitCode !== 0 || !result.stdout.includes("paperclip-createos-ready")) throw new Error("CreateOS command probe failed.");
        return { ok: true, summary: "CreateOS sandbox creation and command execution succeeded." };
      } catch (error) {
        return { ok: false, summary: error instanceof Error ? error.message : "CreateOS probe failed." };
      } finally {
        // Never leave a reusable probe sandbox behind or hide deletion failure.
        if (lease?.providerLeaseId) await new CreateosClient(parseConfig(params.config)).destroySandbox(lease.providerLeaseId);
      }
    },
    async onEnvironmentAcquireLease(params) {
      const lease = await acquire(params);
      if (lease.providerLeaseId) registerLease(params, lease.providerLeaseId);
      return lease;
    },
    async onEnvironmentResumeLease(params) {
      if (!metadataMatches(params, params.leaseMetadata)) throw new Error("CreateOS lease does not belong to this environment.");
      const scope = key(params, params.providerLeaseId);
      if (closing.has(scope) || unconfirmedCleanup.has(scope)) throw new Error("CreateOS lease cleanup must finish before resume.");
      const marker = params.leaseMetadata?.marker;
      if (typeof marker !== "string" || !/^[0-9a-f-]{36}$/.test(marker)) return { providerLeaseId: null, metadata: { expired: true } };
      const config = parseConfig(params.config);
      const adapterType = typeof params.leaseMetadata?.adapterType === "string" ? params.leaseMetadata.adapterType : undefined;
      const configuredEgress = Array.isArray(params.leaseMetadata?.baseEgressAllowlist)
        ? params.leaseMetadata.baseEgressAllowlist : [];
      if (params.leaseMetadata?.shape !== config.shape ||
          params.leaseMetadata.rootfs !== resolveRootfs(config, adapterType) ||
          params.leaseMetadata.region !== config.region ||
          params.leaseMetadata.autoPauseAfterSeconds !== (config.reuseLease ? config.autoPauseAfterSeconds : null) ||
          JSON.stringify(configuredEgress) !== JSON.stringify(config.egressAllowlist)) {
        return { providerLeaseId: null, metadata: { expired: true } };
      }
      const client = new CreateosClient(config);
      const signal = AbortSignal.timeout(config.timeoutMs);
      try {
        const sandbox = await client.getSandbox(params.providerLeaseId, signal);
        if (["destroyed", "failed"].includes(sandbox.status!)) return { providerLeaseId: null, metadata: { expired: true } };
        const egress = params.leaseMetadata?.effectiveEgressAllowlist;
        if (!Array.isArray(egress) || egress.some((entry) => typeof entry !== "string")) {
          return { providerLeaseId: null, metadata: { expired: true } };
        }
        await client.setEgress(params.providerLeaseId, egress, signal);
        await client.transition(params.providerLeaseId, "running", signal);
        const data = await client.json(`/sandboxes/${params.providerLeaseId}/exec`, "POST", {
          cmd: "/bin/cat", args: [MARKER],
        }, signal);
        const result = object(data.result);
        if (result.exit_code !== 0 || result.stdout !== marker) return { providerLeaseId: null, metadata: { expired: true } };
        registerLease(params, params.providerLeaseId);
        return { providerLeaseId: params.providerLeaseId, metadata: { ...params.leaseMetadata, resumedLease: true } };
      } catch (error) {
        if (error instanceof CreateosApiError && error.status === 404) return { providerLeaseId: null, metadata: { expired: true } };
        // A transient error does not prove the original sandbox is lost.
        throw error;
      }
    },
    onEnvironmentReleaseLease: (params) => release(params, false),
    onEnvironmentDestroyLease: (params) => release(params, true),
    async onEnvironmentRealizeWorkspace(params) {
      if (!params.lease.providerLeaseId || !metadataMatches(params, params.lease.metadata)) throw new Error("CreateOS workspace requires a lease from this environment.");
      // The runtime's source mappings stage into this provider workspace.
      return { cwd: CWD, metadata: { provider: "createos", remoteCwd: CWD } };
    },
    async onEnvironmentExecute(params: PluginEnvironmentExecuteParams) {
      return track(params, (client, signal) => execute(client, params, signal,
        (stream, text) => ctx?.execution.log(stream, text)), params.timeoutMs);
    },
    onEnvironmentSyncIn: (params) => track(params, (client, signal) => syncFiles(client, params, "in", signal)),
    onEnvironmentSyncOut: (params) => track(params, (client, signal) => syncFiles(client, params, "out", signal)),
    async onLoginPtyOpen(params) {
      ctx?.logger.info("CreateOS login PTY open requested.");
      if (loginByRoute.has(params.hostRouteId)) throw new Error("CreateOS login route is already open.");
      if (!/^\/tmp\/paperclip-adapter-login\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.sessionHome)) {
        throw new Error("CreateOS login session home is invalid.");
      }
      const lease = resolveLease(params);
      const client = new CreateosClient(lease.config);
      const prepared = await client.json(`/sandboxes/${params.providerLeaseId}/exec`, "POST", {
        cmd: "/bin/mkdir", args: ["-p", "--", params.sessionHome],
      }, AbortSignal.timeout(lease.config.timeoutMs));
      if (object(prepared.result).exit_code !== 0) throw new Error("CreateOS login home preparation failed.");
      ctx?.logger.info("CreateOS login PTY home prepared.");
      const commands = {
        claude: ["claude", "setup-token"],
        codex: ["codex", "login", "--device-auth"],
        grok: ["grok", "login", "--device-auth"],
      } as const;
      const command = commands[params.loginCommandKey];
      const loginEnv = [
        `HOME=${shellQuote(params.sessionHome)}`,
        `TERM=${shellQuote("xterm-256color")}`,
        ...(params.loginCommandKey === "codex" ? [`CODEX_HOME=${shellQuote(params.sessionHome)}`] : []),
        ...(params.loginCommandKey === "grok" ? [`GROK_HOME=${shellQuote(params.sessionHome)}`] : []),
      ];
      const script = loginScript(command, loginEnv);
      const decoder = new StringDecoder("utf8");
      const workerSessionId = `pty-${randomUUID()}`;
      let session: ManagedProcessSession;
      try {
        session = await openManagedProcess(client, params.providerLeaseId, {
          cmd: "/bin/bash", args: ["-lc", script], cwd: CWD,
          pty: { cols: 120, rows: 30 },
        }, "pty", (bytes) => ctx?.loginPty.output(params.hostRouteId, workerSessionId, decoder.write(Buffer.from(bytes))));
      } catch (error) {
        ctx?.logger.info(error instanceof CreateosApiError
          ? `CreateOS login PTY process creation failed (HTTP ${error.status}).`
          : "CreateOS login PTY process creation failed before binding.");
        throw error;
      }
      ctx?.logger.info("CreateOS login PTY process opened.");
      const entry: SessionEntry = { hostRouteId: params.hostRouteId, workerSessionId, providerLeaseId: params.providerLeaseId, session };
      loginByRoute.set(params.hostRouteId, entry);
      loginBySession.set(workerSessionId, entry);
      void session.wait().then(
        (result) => {
          ctx?.logger.info(`CreateOS login PTY exited (code=${result.exitCode ?? "signal"}).`);
          const tail = decoder.end();
          if (tail) ctx?.loginPty.output(params.hostRouteId, workerSessionId, tail);
          ctx?.loginPty.exit(params.hostRouteId, workerSessionId, result.exitCode);
        },
        () => {
          ctx?.logger.info("CreateOS login PTY stream failed.");
          const tail = decoder.end();
          if (tail) ctx?.loginPty.output(params.hostRouteId, workerSessionId, tail);
          ctx?.loginPty.exit(params.hostRouteId, workerSessionId, null);
        },
      ).finally(() => forget(entry, loginByRoute, loginBySession));
      return { workerSessionId };
    },
    async onLoginPtyInput(params) {
      await loginBySession.get(params.workerSessionId)?.session.write(Buffer.from(params.data));
    },
    async onLoginPtyStop(params) {
      await loginBySession.get(params.workerSessionId)?.session.stop();
    },
    async onLoginPtyClose(params) {
      const entry = loginByRoute.get(params.hostRouteId);
      if (entry) {
        await entry.session.close();
        forget(entry, loginByRoute, loginBySession);
      }
      return { hostRouteId: params.hostRouteId };
    },
    async onDuplexChannelOpen(params) {
      if (duplexByRoute.has(params.hostRouteId)) throw new Error("CreateOS duplex route is already open.");
      if (!params.command.length || params.command.some((entry) => !entry || entry.includes("\0"))) {
        throw new Error("CreateOS duplex command is invalid.");
      }
      const lease = resolveLease(params);
      const client = new CreateosClient(lease.config);
      const workerSessionId = `duplex-${randomUUID()}`;
      const session = await openManagedProcess(client, params.providerLeaseId, {
        cmd: params.command[0], args: params.command.slice(1), cwd: CWD,
      }, "pipe", (bytes) => ctx?.duplexChannel.data(params.hostRouteId, workerSessionId, bytes));
      const entry: SessionEntry = { hostRouteId: params.hostRouteId, workerSessionId, providerLeaseId: params.providerLeaseId, session };
      duplexByRoute.set(params.hostRouteId, entry);
      duplexBySession.set(workerSessionId, entry);
      void session.wait().then(
        (result) => ctx?.duplexChannel.exit(params.hostRouteId, workerSessionId, result.exitCode),
        () => ctx?.duplexChannel.exit(params.hostRouteId, workerSessionId, null),
      ).finally(() => forget(entry, duplexByRoute, duplexBySession));
      return { hostRouteId: params.hostRouteId, workerSessionId };
    },
    async onDuplexChannelWrite(params) {
      const entry = duplexBySession.get(params.workerSessionId);
      if (!entry || entry.hostRouteId !== params.hostRouteId) return;
      const bytes = decodeChannelBytes(params.data);
      if (bytes) await entry.session.write(bytes);
    },
    async onDuplexChannelStop(params) {
      const entry = duplexBySession.get(params.workerSessionId);
      if (entry?.hostRouteId === params.hostRouteId) await entry.session.stop();
    },
    async onDuplexChannelClose(params) {
      const entry = duplexByRoute.get(params.hostRouteId);
      if (!entry) return { hostRouteId: params.hostRouteId };
      await entry.session.close();
      forget(entry, duplexByRoute, duplexBySession);
      return { hostRouteId: params.hostRouteId, workerSessionId: entry.workerSessionId };
    },
    async onShutdown() {
      shuttingDown = true;
      const sessions = [...loginByRoute.values(), ...duplexByRoute.values()];
      loginByRoute.clear(); loginBySession.clear(); duplexByRoute.clear(); duplexBySession.clear();
      await Promise.all(sessions.map((entry) => entry.session.close().catch(() => undefined)));
      await Promise.all([...active.keys()].map(stopActive));
      leases.clear();
      ctx = null;
    },
  });
}

export default createPlugin();
