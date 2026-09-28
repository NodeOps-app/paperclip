export interface CreateosConfig {
  apiUrl: string;
  apiKey: string | null;
  shape: string;
  rootfs: string | null;
  rootfsByAdapter: Record<string, string>;
  egressAllowlist: string[];
  region: string | null;
  timeoutMs: number;
  reuseLease: boolean;
  autoPauseAfterSeconds: number;
}

export const DEFAULT_AUTO_PAUSE_AFTER_SECONDS = 600;

export function parseConfig(raw: Record<string, unknown>): CreateosConfig {
  const text = (key: string): string | null => {
    const value = raw[key];
    if (value == null) return null;
    if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
      throw new Error(`${key} must be a non-empty string.`);
    }
    return value.trim();
  };
  const apiUrl = text("apiUrl");
  if (!apiUrl) throw new Error("CreateOS requires an API URL.");
  let url: URL;
  try { url = new URL(apiUrl); } catch { throw new Error("CreateOS API URL is invalid."); }
  // Configuration is board-owned, but never follow redirects with the API key.
  // Plain HTTP is useful for a loopback development server only.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash ||
      !["", "/", "/v1", "/v1/"].includes(url.pathname)) {
    throw new Error("CreateOS API URL must be an HTTPS origin (optionally ending in /v1); HTTP is allowed on loopback only.");
  }
  const shape = text("shape");
  if (!shape) throw new Error("CreateOS requires a shape from its shape catalog.");
  const timeoutMs = raw.timeoutMs ?? 300_000;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000) {
    throw new Error("timeoutMs must be an integer between 1 and 86400000.");
  }
  if (raw.reuseLease != null && typeof raw.reuseLease !== "boolean") {
    throw new Error("reuseLease must be a boolean.");
  }
  const autoPauseAfterSeconds = raw.autoPauseAfterSeconds ?? DEFAULT_AUTO_PAUSE_AFTER_SECONDS;
  if (typeof autoPauseAfterSeconds !== "number" || !Number.isInteger(autoPauseAfterSeconds) ||
      autoPauseAfterSeconds < 60 || autoPauseAfterSeconds > 86_400) {
    throw new Error("autoPauseAfterSeconds must be an integer between 60 and 86400.");
  }
  const rootfsByAdapter: Record<string, string> = {};
  if (raw.rootfsByAdapter != null) {
    if (typeof raw.rootfsByAdapter !== "object" || Array.isArray(raw.rootfsByAdapter)) {
      throw new Error("rootfsByAdapter must be an object of adapter names to root filesystems.");
    }
    for (const [adapter, rootfs] of Object.entries(raw.rootfsByAdapter as Record<string, unknown>)) {
      const key = adapter.trim();
      if (!key || /[\0\r\n]/.test(key) || typeof rootfs !== "string" || !rootfs.trim() || /[\0\r\n]/.test(rootfs)) {
        throw new Error("rootfsByAdapter must contain non-empty adapter and root filesystem strings.");
      }
      rootfsByAdapter[key] = rootfs.trim();
    }
  }
  let egressAllowlist: string[] = [];
  if (raw.egressAllowlist != null) {
    if (!Array.isArray(raw.egressAllowlist) || raw.egressAllowlist.some((entry) => typeof entry !== "string" || !entry.trim() || /[\0\r\n]/.test(entry))) {
      throw new Error("egressAllowlist must be an array of non-empty host or CIDR strings.");
    }
    egressAllowlist = [...new Set(raw.egressAllowlist.map((entry) => entry.trim()))];
  }
  return {
    apiUrl: url.origin,
    apiKey: text("apiKey"),
    shape,
    rootfs: text("rootfs"),
    rootfsByAdapter,
    egressAllowlist,
    region: text("region"),
    timeoutMs,
    reuseLease: raw.reuseLease === true,
    autoPauseAfterSeconds,
  };
}

export function resolveRootfs(config: CreateosConfig, adapterType?: string): string | null {
  return (adapterType ? config.rootfsByAdapter[adapterType] : undefined) ?? config.rootfs;
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim() || /[\0\r\n]/.test(entry))) {
    throw new Error("networkEgress allowlists must contain non-empty strings.");
  }
  return value.map((entry) => entry.trim());
}

export function resolveEgressAllowlist(
  config: CreateosConfig,
  settings?: Record<string, unknown> | null,
): string[] {
  const network = settings?.networkEgress;
  if (network != null && (typeof network !== "object" || Array.isArray(network))) {
    throw new Error("networkEgress must be an object.");
  }
  const record = (network ?? {}) as Record<string, unknown>;
  const merged = [...config.egressAllowlist, ...stringList(record.allowFqdns), ...stringList(record.allowCidrs)];
  const unique = [...new Set(merged)];
  if (unique.length > 1) return unique.filter((entry) => entry !== "*");
  return unique;
}

export function resolveApiKey(config: CreateosConfig): string {
  if (!config.apiKey && config.apiUrl !== "https://api.sb.createos.sh") {
    throw new Error("Custom CreateOS API endpoints require an explicit environment API key; the host fallback is only available for https://api.sb.createos.sh.");
  }
  const key = config.apiKey ?? process.env.CREATEOS_API_KEY?.trim();
  if (!key || /[\r\n\0]/.test(key)) {
    throw new Error("CreateOS requires an API key in the environment config or CREATEOS_API_KEY.");
  }
  return key;
}
