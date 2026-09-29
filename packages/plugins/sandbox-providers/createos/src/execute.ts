import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import type { PluginEnvironmentExecuteParams, PluginEnvironmentExecuteResult } from "@paperclipai/plugin-sdk";
import { CreateosApiError, CreateosClient, identifier, object } from "./client.js";

const MAX_LINE_BYTES = 1_048_576;
const MAX_CAPTURE_CHARS = 4_194_304;

export class CreateosCleanupError extends Error {}

export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Sandbox command values cannot contain NUL.");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandScript(params: PluginEnvironmentExecuteParams, stdinPath: string | null, startGatePath?: string): string {
  if (!params.command) throw new Error("A sandbox command is required.");
  const env = Object.entries(params.env ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
      throw new Error("Invalid sandbox environment variable.");
    }
    return `${key}=${shellQuote(value)}`;
  });
  const command = [params.command, ...(params.args ?? [])].map(shellQuote).join(" ");
  return [
    ...(startGatePath ? [
      `until [ -e ${shellQuote(startGatePath)} ]; do sleep 0.01; done`,
      `rm -f -- ${shellQuote(startGatePath)}`,
    ] : []),
    params.cwd ? `cd -- ${shellQuote(params.cwd)} || exit` : "",
    `exec env ${env.join(" ")} ${command}${stdinPath ? ` < ${shellQuote(stdinPath)}` : ""}`,
  ].filter(Boolean).join("\n");
}

export async function* processEvents(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error("CreateOS returned an empty process stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.length > MAX_LINE_BYTES) throw new Error("CreateOS process frame is too large.");
        if (line.trim()) yield parseEvent(line);
      }
      if (pending.length > MAX_LINE_BYTES) throw new Error("CreateOS process frame is too large.");
      if (done) {
        if (pending.trim()) yield parseEvent(pending);
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function parseEvent(line: string): Record<string, unknown> {
  try { return object(JSON.parse(line)); }
  catch { throw new Error("CreateOS returned an invalid process frame."); }
}

export interface ProcessExit {
  exitCode: number | null;
  signal: string | null;
}

interface RecoveredProcessExit extends ProcessExit {
  newestSeq: number;
}

async function recoverProcessExit(
  client: CreateosClient,
  base: string,
  cursor: number,
  signal: AbortSignal,
): Promise<RecoveredProcessExit> {
  let details: Record<string, unknown>;
  for (;;) {
    try {
      details = await client.json(`${base}/wait?scope=tree&timeout_ms=30000`, "GET", undefined, signal);
      break;
    } catch (error) {
      if (!(error instanceof CreateosApiError && error.status === 408) || signal.aborted) throw error;
    }
  }
  const output = object(details.output);
  const newestSeq = output.newest_seq;
  if (typeof newestSeq !== "number" || !Number.isSafeInteger(newestSeq) || newestSeq < cursor) {
    throw new Error("CreateOS process output journal is invalid.");
  }
  const exitCode = details.exit_code;
  const exitSignal = details.signal;
  if (!(typeof exitCode === "number" && Number.isInteger(exitCode)) &&
      !(typeof exitSignal === "string" && /^SIG[A-Z0-9]+$/.test(exitSignal))) {
    throw new Error("CreateOS process exit status is missing.");
  }
  return {
    exitCode: typeof exitCode === "number" ? exitCode : null,
    signal: typeof exitSignal === "string" && exitSignal ? exitSignal : null,
    newestSeq,
  };
}

export async function followProcess(
  client: CreateosClient,
  sandboxId: string,
  processId: string,
  signal: AbortSignal,
  onData: (stream: "stdout" | "stderr" | "pty", bytes: Buffer) => void,
  onConnected: () => void = () => {},
): Promise<ProcessExit> {
  const base = `/sandboxes/${identifier(sandboxId)}/processes/${identifier(processId)}`;
  let cursor = 0;
  let reconnects = 0;
  let recoveredExit: RecoveredProcessExit | null = null;
  for (;;) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await client.request(`${base}/connect?after=${cursor}`, { signal });
    } catch (error) {
      if (error instanceof CreateosApiError && error.status === 410) {
        throw new Error("CreateOS process output was evicted before it could be read.");
      }
      if (signal.aborted || (error instanceof CreateosApiError && error.status < 500 && error.status !== 429)) throw error;
      if (++reconnects > 3) throw new Error("CreateOS process output connection failed.");
      await delay(250, undefined, { signal });
      continue;
    }
    onConnected();
    try {
      for await (const event of processEvents(response)) {
        if (event.type === "heartbeat") continue;
        if (event.type === "data") {
          const seq = event.seq;
          if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) throw new Error("CreateOS process sequence is invalid.");
          if (seq <= cursor) continue;
          if (seq !== cursor + 1) throw new Error("CreateOS process output has a sequence gap.");
          if ((event.stream !== "stdout" && event.stream !== "stderr" && event.stream !== "pty") ||
              typeof event.data_base64 !== "string" ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.data_base64)) {
            throw new Error("CreateOS process output is invalid.");
          }
          onData(event.stream, Buffer.from(event.data_base64, "base64"));
          cursor = seq;
        } else if (event.type === "exit") {
          const exitCode = event.exit_code;
          const exitSignal = event.signal;
          if (!(typeof exitCode === "number" && Number.isInteger(exitCode)) &&
              !(typeof exitSignal === "string" && /^SIG[A-Z0-9]+$/.test(exitSignal))) {
            throw new Error("CreateOS process exit status is missing.");
          }
          return {
            exitCode: typeof exitCode === "number" ? exitCode : null,
            signal: typeof exitSignal === "string" ? exitSignal : null,
          };
        } else if (event.type === "error") {
          throw new Error(event.error === "output_offset_expired"
            ? "CreateOS process output was evicted before it could be read."
            : "CreateOS process stream reported an error.");
        } else {
          throw new Error("CreateOS returned an unknown process event.");
        }
      }
    } catch (error) {
      if (!(error instanceof TypeError) || signal.aborted) throw error;
    }
    if (++reconnects > 3) {
      if (recoveredExit) {
        if (cursor === recoveredExit.newestSeq) return recoveredExit;
        throw new Error("CreateOS process stream ended before all output could be replayed.");
      }
      recoveredExit = await recoverProcessExit(client, base, cursor, signal);
      if (cursor === recoveredExit.newestSeq) return recoveredExit;
      // The process tree is complete and its journal is now immutable. Give
      // the public streaming proxies one bounded replay window to deliver the
      // missing tail before treating it as data loss.
      reconnects = 0;
      await delay(1_000, undefined, { signal });
      continue;
    }
    await delay(250, undefined, { signal });
  }
}

class Output {
  stdout = "";
  stderr = "";
  truncated = false;
  private decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  constructor(private log: (stream: "stdout" | "stderr", text: string) => void) {}

  private append(stream: "stdout" | "stderr", text: string) {
    if (!text) return;
    this.log(stream, text);
    const combined = this[stream] + text;
    if (combined.length > MAX_CAPTURE_CHARS) this.truncated = true;
    this[stream] = combined.slice(-MAX_CAPTURE_CHARS);
  }

  write(stream: "stdout" | "stderr", bytes: Buffer) {
    this.append(stream, this.decoders[stream].write(bytes));
  }

  finish() {
    for (const stream of ["stdout", "stderr"] as const) this.append(stream, this.decoders[stream].end());
  }
}

export async function executeStream(
  client: CreateosClient,
  params: PluginEnvironmentExecuteParams,
  signal: AbortSignal,
  log: (stream: "stdout" | "stderr", text: string) => void = () => {},
): Promise<PluginEnvironmentExecuteResult> {
  const id = identifier(params.lease.providerLeaseId);
  const script = commandScript(params, null);
  const output = new Output(log);
  try {
    const response = await client.request(`/sandboxes/${id}/exec?stream=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cmd: "/bin/bash", args: ["-lc", script], stream: true,
        ...(params.stdin != null ? { stdin: params.stdin } : {}),
      }),
      signal,
    });
    for await (const event of processEvents(response)) {
      if (event.hb === true) continue;
      if (typeof event.stdout === "string") {
        output.write("stdout", Buffer.from(event.stdout));
        continue;
      }
      if (typeof event.stderr === "string") {
        output.write("stderr", Buffer.from(event.stderr));
        continue;
      }
      if (typeof event.error === "string") throw new Error("CreateOS command stream reported an error.");
      if (typeof event.exit_code === "number" && Number.isInteger(event.exit_code)) {
        output.finish();
        return {
          exitCode: event.exit_code, signal: null, timedOut: false,
          stdout: output.stdout, stderr: output.stderr,
          metadata: { outputTruncated: output.truncated },
        };
      }
      throw new Error("CreateOS returned an invalid command stream event.");
    }
    throw new Error("CreateOS command stream ended without an exit status.");
  } catch (error) {
    output.finish();
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      return {
        exitCode: null, timedOut: true, stdout: output.stdout, stderr: output.stderr,
        metadata: { outputTruncated: output.truncated },
      };
    }
    if (signal.aborted) throw new Error("CreateOS command was cancelled.");
    throw error;
  }
}

// A broken output connection does not stop a managed process. Always reconnect
// to the SAME process, never retry its creation, and explicitly terminate its
// tree on timeout/failure. Cleanup has its own deadline, independent of execute.
export async function execute(
  client: CreateosClient,
  params: PluginEnvironmentExecuteParams,
  signal: AbortSignal,
  log: (stream: "stdout" | "stderr", text: string) => void = () => {},
): Promise<PluginEnvironmentExecuteResult> {
  const id = identifier(params.lease.providerLeaseId);
  const stdinPath = params.stdin != null ? `/tmp/paperclip-stdin-${randomUUID()}` : null;
  const startGatePath = `/tmp/paperclip-start-${randomUUID()}`;
  const script = commandScript(params, stdinPath, startGatePath);
  const output = new Output(log);
  let processId: string | null = null;
  let creationMayHaveSucceeded = false;
  let completed = false;
  let staged = false;
  const base = `/sandboxes/${id}/processes`;
  try {
    if (stdinPath) {
      staged = true;
      await client.upload(id, stdinPath, params.stdin!, signal);
    }
    let created: Record<string, unknown>;
    creationMayHaveSucceeded = true;
    try {
      created = await client.json(base, "POST", {
        cmd: "/bin/bash", args: ["-lc", script],
        ...(params.cwd ? { cwd: params.cwd } : {}),
        // CreateOS API overrides are limited to keys declared at sandbox
        // creation. Per-command variables are already safely quoted in the
        // command's `env` invocation, including on a reused sandbox.
      }, signal);
    } catch (error) {
      if (error instanceof CreateosApiError && error.status < 500) creationMayHaveSucceeded = false;
      throw error;
    }
    processId = identifier(created.process_id);
    // No interactive stdin for ordinary commands; any supplied input comes
    // from the staged file. The command waits on startGatePath so the public
    // stream is attached before a fast command can emit output and exit.
    let connectedResolve!: () => void;
    const connected = new Promise<void>((resolve) => { connectedResolve = resolve; });
    const follow = followProcess(client, id, processId, signal, (stream, bytes) => {
      if (stream === "pty") throw new Error("CreateOS pipe process returned PTY output.");
      output.write(stream, bytes);
    }, connectedResolve);
    // If gate upload or stdin close fails, cleanup below terminates the
    // managed process. Mark the follower handled while that cleanup completes.
    void follow.catch(() => undefined);
    const closeStdin = client.json(`${base}/${processId}/stdin/close`, "POST", undefined, signal)
      .catch((error) => {
        if (!(error instanceof CreateosApiError && error.status === 409)) throw error;
      });
    await Promise.race([
      connected,
      follow.then(() => { throw new Error("CreateOS process ended before its output stream connected."); }),
    ]);
    await client.upload(id, startGatePath, "", signal);
    const [exit] = await Promise.all([follow, closeStdin]);
    completed = true;
    output.finish();
    return {
      exitCode: exit.exitCode,
      signal: exit.signal,
      timedOut: false, stdout: output.stdout, stderr: output.stderr,
      metadata: { processId, outputTruncated: output.truncated },
    };
  } catch (error) {
    if (creationMayHaveSucceeded && !processId) {
      throw new CreateosCleanupError("CreateOS process creation could not be confirmed; destroy the lease before reusing it.");
    }
    if (signal.aborted && signal.reason?.name === "TimeoutError") {
      output.finish();
      return {
        exitCode: null, timedOut: true, stdout: output.stdout, stderr: output.stderr,
        metadata: { processId, outputTruncated: output.truncated },
      };
    }
    if (signal.aborted) throw new Error("CreateOS command was cancelled.");
    throw error;
  } finally {
    const cleanupSignal = AbortSignal.timeout(client.config.timeoutMs);
    // Do not hide a cleanup failure: the host must know containment is unproven.
    try {
      if (processId && !completed) {
        try {
          const termination = await client.json(`${base}/${processId}?grace_ms=1000`, "DELETE", undefined, cleanupSignal);
          if (termination.tree_exited !== true) throw new Error("Process tree has not exited.");
        }
        catch (error) { if (!(error instanceof CreateosApiError && error.status === 404)) throw new CreateosCleanupError("CreateOS command cleanup failed; process termination is unconfirmed."); }
      }
    } finally {
      if (processId || staged) {
        // /files has no delete verb. /exec supplies a bounded, one-shot removal
        // after the managed process finishes, without retaining another record.
        await client.json(`/sandboxes/${id}/exec`, "POST", {
          cmd: "/bin/rm", args: ["-f", "--", startGatePath, ...(stdinPath ? [stdinPath] : [])],
        }, cleanupSignal).catch(() => undefined);
      }
    }
  }
}
