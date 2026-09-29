import { CreateosApiError, CreateosClient, identifier } from "./client.js";
import { followProcess, type ProcessExit } from "./execute.js";

const MAX_INPUT_BYTES = 256 * 1024;

export type ManagedProcessMode = "pipe" | "pty";

export interface ManagedProcessSession {
  readonly processId: string;
  write(bytes: Uint8Array): Promise<void>;
  wait(): Promise<ProcessExit>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function openManagedProcess(
  client: CreateosClient,
  sandboxId: string,
  body: Record<string, unknown>,
  mode: ManagedProcessMode,
  onData: (bytes: Uint8Array) => void,
): Promise<ManagedProcessSession> {
  const id = identifier(sandboxId);
  const base = `/sandboxes/${id}/processes`;
  const created = await client.json(base, "POST", body, AbortSignal.timeout(client.config.timeoutMs));
  const processId = identifier(created.process_id);
  const controller = new AbortController();
  let input = Promise.resolve();
  let stopPromise: Promise<void> | null = null;
  let closePromise: Promise<void> | null = null;
  const done = followProcess(client, id, processId, controller.signal, (stream, bytes) => {
    if (mode === "pty" ? stream !== "pty" : stream !== "stdout") return;
    onData(bytes);
  });
  // Callers attach their own completion notification. Keep an internal handler
  // as well so a close racing a failed stream never creates an unhandled rejection.
  void done.catch(() => undefined);

  const write = async (bytes: Uint8Array) => {
    if (closePromise || stopPromise || bytes.byteLength === 0) return;
    const copy = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    input = input.then(async () => {
      for (let offset = 0; offset < copy.length; offset += MAX_INPUT_BYTES) {
        const chunk = copy.subarray(offset, offset + MAX_INPUT_BYTES);
        await client.json(`${base}/${processId}/input`, "POST", { data_base64: chunk.toString("base64") }, AbortSignal.timeout(client.config.timeoutMs));
      }
    });
    await input;
  };

  const stop = async () => {
    if (!stopPromise) stopPromise = (async () => {
      await input.catch(() => undefined);
      try {
        await client.json(`${base}/${processId}/signal`, "POST", { signal: "SIGTERM" }, AbortSignal.timeout(client.config.timeoutMs));
      }
      catch {
        // DELETE is the authoritative whole-tree stop. Attempt it even when the
        // graceful signal fails, rather than abandoning a possibly live child.
      }
      try {
        const receipt = await client.json(`${base}/${processId}?grace_ms=1000`, "DELETE", undefined, AbortSignal.timeout(client.config.timeoutMs));
        if (receipt.tree_exited !== true) throw new Error("CreateOS process tree termination was not confirmed.");
      } catch (error) {
        if (!(error instanceof CreateosApiError && error.status === 404)) throw error;
      } finally {
        controller.abort(new Error("CreateOS managed process was stopped."));
      }
    })();
    await stopPromise;
  };

  const close = async () => {
    if (!closePromise) closePromise = (async () => {
      if (mode === "pipe" && !stopPromise) {
        try { await client.json(`${base}/${processId}/stdin/close`, "POST", undefined, AbortSignal.timeout(client.config.timeoutMs)); }
        catch (error) {
          if (!(error instanceof CreateosApiError && [404, 409].includes(error.status))) throw error;
        }
      }
      await stop();
    })();
    await closePromise;
  };

  return { processId, write, wait: () => done, stop, close };
}
