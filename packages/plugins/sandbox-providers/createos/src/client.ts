import { setTimeout as delay } from "node:timers/promises";
import type { CreateosConfig } from "./config.js";
import { resolveApiKey } from "./config.js";
import { waitForRequest } from "./request-pacer.js";

export class CreateosApiError extends Error {
  constructor(readonly status: number, operation?: string) {
    // Provider bodies may echo command input or credentials. Keep them out of
    // persisted errors and probe metadata.
    super(`CreateOS request failed (HTTP ${status})${operation ? ` during ${operation}` : ""}.`);
  }
}

export interface Sandbox {
  id: string;
  status?: string;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("CreateOS returned an invalid response.");
  }
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(value)) {
    throw new Error("CreateOS returned an invalid resource ID.");
  }
  return value;
}

export class CreateosClient {
  readonly apiKey: string;
  constructor(readonly config: CreateosConfig) {
    this.apiKey = resolveApiKey(config);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = init.signal ?? AbortSignal.timeout(this.config.timeoutMs);
    await waitForRequest(this.config.apiUrl, signal);
    let response: Response;
    try {
      response = await fetch(`${this.config.apiUrl}/v1${path}`, {
        ...init,
        redirect: "error",
        headers: { ...init.headers, "X-Api-Key": this.apiKey },
        signal,
      });
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      // Do not propagate fetch causes: they can contain the configured URL.
      if (error instanceof Error && error.name === "TimeoutError") throw error;
      throw new Error("CreateOS connection failed.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Only fixed operation labels: never include paths, queries, or bodies,
      // which may contain credentials or private workspace names.
      const operation = path.includes("/files?") ? "file transfer"
        : path.includes("/stdin/close") ? "stdin close"
        : path.includes("/connect?") ? "output connection"
        : path.endsWith("/processes") ? "process creation"
        : path.includes("/processes/") ? "process cleanup"
        : path.includes("/exec") ? "workspace command"
        : "sandbox lifecycle";
      throw new CreateosApiError(response.status, operation);
    }
    return response;
  }

  async json(path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request(path, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
      signal,
    });
    let envelope: Record<string, unknown>;
    try { envelope = object(await response.json()); } catch { throw new Error("CreateOS returned invalid JSON."); }
    if (envelope.status !== "success") throw new Error("CreateOS returned an unsuccessful response.");
    return object(envelope.data);
  }

  async getSandbox(id: string, signal?: AbortSignal): Promise<Sandbox> {
    const data = await this.json(`/sandboxes/${identifier(id)}`, "GET", undefined, signal);
    if (data.id !== id || typeof data.status !== "string") throw new Error("CreateOS sandbox identity or state is invalid.");
    return { id, status: data.status };
  }

  async createSandbox(signal: AbortSignal, options: {
    rootfs: string | null;
    egress: string[];
    autoPauseAfterSeconds: number | null;
  }): Promise<Sandbox> {
    const { shape, region } = this.config;
    const { rootfs, egress, autoPauseAfterSeconds } = options;
    const data = await this.json("/sandboxes", "POST", {
      shape,
      ...(rootfs ? { rootfs } : {}),
      ...(region ? { region } : {}),
      ...(egress.length ? { egress } : {}),
      ...(autoPauseAfterSeconds != null ? { auto_pause_after_seconds: autoPauseAfterSeconds } : {}),
      ingress_enabled: false,
      // CreateOS owns the idle timer. Paperclip still owns explicit destruction
      // and treats auto-pause as reuse optimization, never guaranteed expiry.
    }, signal);
    return { id: identifier(data.id) };
  }

  async resolveRootfs(rootfs: string | null, signal: AbortSignal): Promise<string> {
    if (rootfs) return rootfs;
    const data = await this.json("/rootfs", "GET", undefined, signal);
    if (typeof data.default !== "string" || !data.default.trim() || /[\0\r\n]/.test(data.default)) {
      throw new Error("CreateOS rootfs catalog did not provide a valid default.");
    }
    return data.default.trim();
  }

  async setEgress(id: string, egress: string[], signal: AbortSignal): Promise<void> {
    await this.json(`/sandboxes/${identifier(id)}/egress`, "PUT", { egress }, signal);
  }

  async destroySandbox(id: string, signal?: AbortSignal): Promise<void> {
    try { await this.json(`/sandboxes/${identifier(id)}`, "DELETE", undefined, signal); }
    catch (error) { if (!(error instanceof CreateosApiError && error.status === 404)) throw error; }
  }

  async setAutoPause(id: string, seconds: number | null, signal: AbortSignal): Promise<void> {
    await this.json(`/sandboxes/${identifier(id)}`, "PATCH", seconds == null
      ? { disable_auto_pause: true }
      : { auto_pause_after_seconds: seconds }, signal);
  }

  async forkSandbox(sourceId: string, signal: AbortSignal, options: {
    egress: string[];
    autoPauseAfterSeconds: number | null;
  }): Promise<Sandbox> {
    const source = await this.getSandbox(sourceId, signal);
    if (source.status !== "paused") {
      throw new Error("CreateOS template sandbox must be paused before it can be forked.");
    }

    let data: Record<string, unknown>;
    let forkConflicts = 0;
    for (;;) {
      signal.throwIfAborted();
      try {
        data = await this.json(`/sandboxes/${identifier(sourceId)}/fork`, "POST", {
          start_paused: false,
          // An empty CreateOS egress list means allow-all, but /fork inherits
          // the source list when the field is omitted or empty. Send the
          // provider's explicit allow-all spelling so a newly relaxed policy
          // does not inherit a captured restrictive list.
          egress: options.egress.length > 0 ? options.egress : ["*"],
          ingress_enabled: false,
        }, signal);
        break;
      } catch (error) {
        // A sandbox can report paused just before its bundle upload becomes
        // forkable. CreateOS reports that short durability window as 409.
        if (!(error instanceof CreateosApiError && error.status === 409) || ++forkConflicts > 40) throw error;
        await delay(250, undefined, { signal });
      }
    }

    const id = identifier(data.id);
    try {
      await this.transition(id, "running", signal);
      await this.setAutoPause(id, options.autoPauseAfterSeconds, signal);
      return { id, status: "running" };
    } catch (error) {
      try { await this.destroySandbox(id); }
      catch { throw new Error(`CreateOS fork setup failed and cleanup is unconfirmed for sandbox ${id}.`); }
      throw error;
    }
  }

  async transition(id: string, desired: "running" | "paused", signal: AbortSignal): Promise<void> {
    let submitted = false;
    for (;;) {
      signal.throwIfAborted();
      const sandbox = await this.getSandbox(id, signal);
      if (sandbox.status === desired) return;
      const canSubmit = desired === "running"
        ? ["paused", "error"].includes(sandbox.status!)
        : sandbox.status === "running";
      if (canSubmit && !submitted) {
        try {
          await this.json(`/sandboxes/${id}/${desired === "running" ? "resume" : "pause"}`, "POST", undefined, signal);
          submitted = true;
        } catch (error) {
          // A concurrent state transition is reconciled by reading its state.
          if (!(error instanceof CreateosApiError && error.status === 409)) throw error;
        }
      } else if (!canSubmit && !["creating", "pausing", "resuming", "forking"].includes(sandbox.status!)) {
        throw new Error(`CreateOS sandbox did not reach ${desired}; provider state is ${sandbox.status}.`);
      }
      // An accepted transition can remain in its previous state briefly.
      // Poll under the same deadline without submitting the action twice.
      await delay(250, undefined, { signal });
    }
  }

  async upload(id: string, path: string, content: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(`/sandboxes/${identifier(id)}/files?path=${encodeURIComponent(path)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: content, signal,
    });
    await response.body?.cancel();
  }
}
