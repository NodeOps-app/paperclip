import { expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createPlugin } from "./plugin.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CreateosApiError, CreateosClient, object } from "./client.js";
import { parseConfig } from "./config.js";
import { openManagedProcess } from "./process-session.js";

// Explicit opt-in: this creates a billable sandbox on the supplied endpoint.
// It never selects a region or discovers credentials automatically.
it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS create/exec/stdin/reuse/destroy live smoke", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  let duplexDataResolve!: (bytes: Uint8Array) => void;
  const duplexData = new Promise<Uint8Array>((resolve) => { duplexDataResolve = resolve; });
  await hooks.setup!({
    logger: { info() {} },
    loginPty: { output() {}, exit() {} },
    duplexChannel: { data(_route, _session, bytes) { duplexDataResolve(bytes); }, exit() {} },
  } as unknown as PluginContext);
  const egressAllowlist = (process.env.CREATEOS_EGRESS_ALLOWLIST ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const params = {
    driverKey: "createos", companyId: "createos-plugin-smoke", environmentId: "createos-plugin-smoke",
    issueId: "createos-plugin-smoke",
    config: {
      apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), egressAllowlist,
      reuseLease: true, autoPauseAfterSeconds: 60, timeoutMs: 120_000,
    },
  };
  const lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "smoke" });
  let temp: string | null = null;
  try {
    temp = await fs.mkdtemp(path.join(os.tmpdir(), "createos-live-"));
    const workspace = await hooks.onEnvironmentRealizeWorkspace!({ ...params, lease, workspace: {} });
    const large = Buffer.alloc(5 * 1024 * 1024, 0xa5);
    const source = path.join(temp, "source");
    const target = path.join(temp, "download");
    await fs.writeFile(source, large);
    await hooks.onEnvironmentSyncIn!({ ...params, lease, operations: [{ operationId: "smoke-in", files: [{
      sourcePath: source, targetPath: `${workspace.cwd}/large.bin`, kind: "file", mode: 0o600,
    }] }] });
    const concurrentSource = path.join(temp, "concurrent-source");
    await fs.writeFile(concurrentSource, Buffer.from("concurrent"));
    await Promise.all([
      hooks.onEnvironmentSyncOut!({ ...params, lease, operations: [{ operationId: "smoke-out", files: [{
        sourcePath: `${workspace.cwd}/large.bin`, targetPath: target, kind: "file", mode: 0o600,
      }] }] }),
      hooks.onEnvironmentSyncIn!({ ...params, lease, operations: [{ operationId: "smoke-concurrent-in", files: [{
        sourcePath: concurrentSource, targetPath: `${workspace.cwd}/concurrent.txt`, kind: "file", mode: 0o600,
      }] }] }),
    ]);
    expect((await fs.readFile(target)).equals(large)).toBe(true);
    const written = await hooks.onEnvironmentExecute!({
      ...params, lease, command: "/bin/bash", args: ["-c", "cat > smoke.txt; printf '%s' \"$SMOKE\" >&2"],
      stdin: "persisted\n", env: { SMOKE: "stderr works" }, cwd: workspace.cwd,
    });
    expect(written).toMatchObject({ exitCode: 0, timedOut: false, stderr: "stderr works" });
    if (egressAllowlist.includes("github.com")) {
      const allowed = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "/usr/bin/curl",
        args: ["-fsS", "--connect-timeout", "10", "--max-time", "20", "-o", "/dev/null", "https://github.com"],
        cwd: workspace.cwd,
      });
      expect(allowed).toMatchObject({ exitCode: 0, timedOut: false });
      const blocked = await hooks.onEnvironmentExecute!({
        ...params, lease, command: "/usr/bin/curl",
        args: ["-fsS", "--connect-timeout", "5", "--max-time", "10", "-o", "/dev/null", "https://example.com"],
        cwd: workspace.cwd,
      });
      expect(blocked.timedOut).toBe(false);
      expect(blocked.exitCode).not.toBe(0);
    }
    const ptyOutput: Buffer[] = [];
    const pty = await openManagedProcess(new CreateosClient(parseConfig(params.config)), lease.providerLeaseId!, {
      cmd: "/bin/bash", args: ["-lc", "stty size"], cwd: workspace.cwd,
      pty: { rows: 30, cols: 120 },
    }, "pty", (bytes) => ptyOutput.push(Buffer.from(bytes)));
    expect(await pty.wait()).toMatchObject({ exitCode: 0 });
    expect(Buffer.concat(ptyOutput).toString()).toContain("30 120");
    await pty.close();
    const channel = await hooks.onDuplexChannelOpen!({
      hostRouteId: "live-duplex", driverKey: "createos", companyId: params.companyId,
      environmentId: params.environmentId, providerLeaseId: lease.providerLeaseId!, command: ["/bin/cat"],
    });
    const channelBytes = Buffer.from([0, 255, 1, 10]);
    await hooks.onDuplexChannelWrite!({ ...channel, data: channelBytes.toString("base64") });
    expect(Buffer.from(await duplexData)).toEqual(channelBytes);
    await hooks.onDuplexChannelStop!({ ...channel });
    await hooks.onDuplexChannelClose!({ ...channel });
    await hooks.onEnvironmentReleaseLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata });
    const client = new CreateosClient(parseConfig(params.config));
    const pauseDeadline = Date.now() + 120_000;
    for (;;) {
      const sandbox = await client.getSandbox(lease.providerLeaseId!, AbortSignal.timeout(120_000));
      if (sandbox.status === "paused") break;
      if (Date.now() >= pauseDeadline) throw new Error("CreateOS sandbox did not auto-pause within 120 seconds.");
      await delay(1_000);
    }
    const resumed = await hooks.onEnvironmentResumeLease!({ ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    const read = await hooks.onEnvironmentExecute!({ ...params, lease: resumed, command: "/bin/cat", args: ["smoke.txt"], cwd: workspace.cwd });
    expect(read).toMatchObject({ exitCode: 0, timedOut: false, stdout: "persisted\n" });
  } finally {
    try { await hooks.onEnvironmentDestroyLease!({ ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata }); }
    finally {
      await hooks.onShutdown!();
      if (temp) await fs.rm(temp, { recursive: true, force: true });
    }
  }
}, 300_000);

it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS non-reusable release destroys the live sandbox", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  const params = {
    driverKey: "createos", companyId: "createos-destroy-smoke", environmentId: "createos-destroy-smoke",
    config: { apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), reuseLease: false, timeoutMs: 120_000 },
  };
  let lease: Awaited<ReturnType<NonNullable<typeof hooks.onEnvironmentAcquireLease>>> | null = null;
  let released = false;
  try {
    lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "live-destroy-on-release" });
    expect(await hooks.onEnvironmentExecute!({
      ...params, lease, command: "/bin/bash", args: ["-lc", "printf disposable"], cwd: "/paperclip-workspace",
    })).toMatchObject({ exitCode: 0, stdout: "disposable" });
    await hooks.onEnvironmentReleaseLease!({
      ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
    });
    released = true;
    let postReleaseStatus: string | null = null;
    try {
      postReleaseStatus = (await new CreateosClient(parseConfig(params.config))
        .getSandbox(lease.providerLeaseId!, AbortSignal.timeout(120_000))).status ?? null;
    } catch (error) {
      expect(error).toBeInstanceOf(CreateosApiError);
      expect((error as CreateosApiError).status).toBe(404);
    }
    if (postReleaseStatus !== null) expect(["destroying", "destroyed"]).toContain(postReleaseStatus);
  } finally {
    if (lease?.providerLeaseId && !released) {
      await hooks.onEnvironmentDestroyLease!({
        ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
      });
    }
    await hooks.onShutdown!();
  }
}, 300_000);

it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS egress enforcement and auto-pause/resume live smoke", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  const params = {
    driverKey: "createos", companyId: "createos-egress-smoke", environmentId: "createos-egress-smoke",
    issueId: "createos-egress-smoke",
    config: {
      apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), egressAllowlist: ["github.com"],
      reuseLease: true, autoPauseAfterSeconds: 60, timeoutMs: 120_000,
    },
  };
  let lease: Awaited<ReturnType<NonNullable<typeof hooks.onEnvironmentAcquireLease>>> | null = null;
  try {
    lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "live-egress-auto-pause" });
    const client = new CreateosClient(parseConfig(params.config));
    const run = async (url: string) => object((await client.json(`/sandboxes/${lease!.providerLeaseId}/exec`, "POST", {
      cmd: "/usr/bin/curl", args: ["-fsS", "--connect-timeout", "5", "--max-time", "15", "-o", "/dev/null", url],
    }, AbortSignal.timeout(120_000))).result);
    expect((await run("https://github.com")).exit_code).toBe(0);
    expect((await run("https://example.com")).exit_code).not.toBe(0);

    await hooks.onEnvironmentReleaseLease!({
      ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
    });
    const pauseDeadline = Date.now() + 120_000;
    for (;;) {
      const sandbox = await client.getSandbox(lease.providerLeaseId!, AbortSignal.timeout(120_000));
      if (sandbox.status === "paused") break;
      if (Date.now() >= pauseDeadline) throw new Error("CreateOS sandbox did not auto-pause within 120 seconds.");
      await delay(1_000);
    }
    const resumed = await hooks.onEnvironmentResumeLease!({
      ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata,
    });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(resumed.metadata).toMatchObject({ resumedLease: true });
  } finally {
    if (lease?.providerLeaseId) {
      await hooks.onEnvironmentDestroyLease!({
        ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
      });
    }
    await hooks.onShutdown!();
  }
}, 300_000);

it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS PTY, duplex, and paused lease resume live smoke", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  let duplexDataResolve!: (bytes: Uint8Array) => void;
  const duplexData = new Promise<Uint8Array>((resolve) => { duplexDataResolve = resolve; });
  await hooks.setup!({
    logger: { info() {} },
    loginPty: { output() {}, exit() {} },
    duplexChannel: { data(_route, _session, bytes) { duplexDataResolve(bytes); }, exit() {} },
  } as unknown as PluginContext);
  const params = {
    driverKey: "createos", companyId: "createos-session-smoke", environmentId: "createos-session-smoke",
    issueId: "createos-session-smoke",
    config: {
      apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}),
      reuseLease: true, autoPauseAfterSeconds: 600, timeoutMs: 120_000,
    },
  };
  let lease: Awaited<ReturnType<NonNullable<typeof hooks.onEnvironmentAcquireLease>>> | null = null;
  try {
    lease = await hooks.onEnvironmentAcquireLease!({ ...params, runId: "live-session-resume" });
    const client = new CreateosClient(parseConfig(params.config));
    const ptyOutput: Buffer[] = [];
    const pty = await openManagedProcess(client, lease.providerLeaseId!, {
      cmd: "/bin/bash", args: ["-lc", "stty size"], cwd: "/paperclip-workspace",
      pty: { rows: 30, cols: 120 },
    }, "pty", (bytes) => ptyOutput.push(Buffer.from(bytes)));
    expect(await pty.wait()).toMatchObject({ exitCode: 0 });
    expect(Buffer.concat(ptyOutput).toString()).toContain("30 120");
    await pty.close();

    const channel = await hooks.onDuplexChannelOpen!({
      hostRouteId: "live-session-duplex", driverKey: "createos", companyId: params.companyId,
      environmentId: params.environmentId, providerLeaseId: lease.providerLeaseId!, command: ["/bin/cat"],
    });
    const channelBytes = Buffer.from([0, 255, 1, 10]);
    await hooks.onDuplexChannelWrite!({ ...channel, data: channelBytes.toString("base64") });
    expect(Buffer.from(await duplexData)).toEqual(channelBytes);
    await hooks.onDuplexChannelStop!({ ...channel });
    await hooks.onDuplexChannelClose!({ ...channel });

    expect(object((await client.json(`/sandboxes/${lease.providerLeaseId}/exec`, "POST", {
      cmd: "/bin/bash", args: ["-lc", "printf reusable > /paperclip-workspace/reuse-proof.txt"],
    }, AbortSignal.timeout(120_000))).result).exit_code).toBe(0);
    await hooks.onEnvironmentReleaseLease!({
      ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
    });
    await client.transition(lease.providerLeaseId!, "paused", AbortSignal.timeout(120_000));
    const resumed = await hooks.onEnvironmentResumeLease!({
      ...params, providerLeaseId: lease.providerLeaseId!, leaseMetadata: lease.metadata,
    });
    expect(resumed.providerLeaseId).toBe(lease.providerLeaseId);
    expect(resumed.metadata).toMatchObject({ resumedLease: true });
    const proof = object((await client.json(`/sandboxes/${lease.providerLeaseId}/exec`, "POST", {
      cmd: "/bin/cat", args: ["/paperclip-workspace/reuse-proof.txt"],
    }, AbortSignal.timeout(120_000))).result);
    expect(proof).toMatchObject({ exit_code: 0, stdout: "reusable" });
  } finally {
    if (lease?.providerLeaseId) {
      await hooks.onEnvironmentDestroyLease!({
        ...params, providerLeaseId: lease.providerLeaseId, leaseMetadata: lease.metadata,
      });
    }
    await hooks.onShutdown!();
  }
}, 300_000);

it.skipIf(process.env.CREATEOS_LIVE_TEST !== "1")("CreateOS interactive setup pause/fork live smoke", async () => {
  const { CREATEOS_API_URL: apiUrl, CREATEOS_API_KEY: apiKey, CREATEOS_SHAPE: shape, CREATEOS_ROOTFS: rootfs } = process.env;
  if (!apiUrl || !apiKey || !shape) throw new Error("Set CREATEOS_API_URL, CREATEOS_API_KEY, and CREATEOS_SHAPE for the live smoke.");
  const hooks = createPlugin().definition;
  const baseParams = {
    driverKey: "createos", companyId: "createos-template-smoke", environmentId: "createos-template-smoke",
    config: { apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), timeoutMs: 120_000 },
  };
  let setup: Awaited<ReturnType<NonNullable<typeof hooks.onEnvironmentStartInteractiveSetup>>> | null = null;
  let templateRef: string | null = null;
  let lease: Awaited<ReturnType<NonNullable<typeof hooks.onEnvironmentAcquireLease>>> | null = null;
  try {
    setup = await hooks.onEnvironmentStartInteractiveSetup!({ ...baseParams, sessionId: "live-template-setup" });
    expect(setup.connectionPayload?.command).toBe(`createos sandbox shell ${setup.providerLeaseId}`);
    const client = new CreateosClient(parseConfig(baseParams.config));
    const written = await client.json(`/sandboxes/${setup.providerLeaseId}/exec`, "POST", {
      cmd: "/bin/bash", args: ["-lc", "printf captured > /paperclip-workspace/template-proof.txt"],
    }, AbortSignal.timeout(120_000));
    expect(written.result).toMatchObject({ exit_code: 0 });
    const captured = await hooks.onEnvironmentCaptureTemplate!({
      ...baseParams,
      providerLeaseId: setup.providerLeaseId,
      setupMetadata: setup.metadata,
    });
    templateRef = captured.templateRef;
    const leaseParams = { ...baseParams, config: { ...baseParams.config, snapshot: templateRef } };
    lease = await hooks.onEnvironmentAcquireLease!({ ...leaseParams, runId: "live-template-fork" });
    expect(lease.providerLeaseId).not.toBe(templateRef);
    expect(await hooks.onEnvironmentExecute!({
      ...leaseParams,
      lease,
      command: "/bin/cat",
      args: ["template-proof.txt"],
      cwd: "/paperclip-workspace",
    })).toMatchObject({ exitCode: 0, stdout: "captured" });
  } finally {
    if (lease) {
      const leaseParams = { ...baseParams, config: { ...baseParams.config, snapshot: templateRef } };
      await hooks.onEnvironmentDestroyLease!({
        ...leaseParams,
        providerLeaseId: lease.providerLeaseId,
        leaseMetadata: lease.metadata,
      });
    }
    if (templateRef) {
      await hooks.onEnvironmentDeleteTemplate!({
        ...baseParams,
        templateRef,
        templateKind: "snapshot",
        reason: "live smoke cleanup",
      });
    } else if (setup?.providerLeaseId) {
      await hooks.onEnvironmentCancelInteractiveSetup!({
        ...baseParams,
        providerLeaseId: setup.providerLeaseId,
        setupMetadata: setup.metadata,
        reason: "live smoke cleanup",
      });
    }
    await hooks.onShutdown!();
  }
}, 300_000);
