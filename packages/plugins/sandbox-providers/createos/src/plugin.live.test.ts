import { expect, it } from "vitest";
import { createPlugin } from "./plugin.js";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import { CreateosClient } from "./client.js";
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
    config: { apiUrl, apiKey, shape, ...(rootfs ? { rootfs } : {}), egressAllowlist, reuseLease: true, timeoutMs: 120_000 },
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
