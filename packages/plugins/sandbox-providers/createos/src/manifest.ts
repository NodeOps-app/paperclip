import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.createos-sandbox-provider",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "CreateOS Sandbox Provider",
  description: "Runs Paperclip agents in CreateOS sandboxes.",
  author: "CreateOS",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "./dist/worker.js" },
  environmentDrivers: [{
    driverKey: "createos",
    kind: "sandbox_provider",
    displayName: "CreateOS Sandbox",
    description: "CreateOS sandboxes with live command output and warm-window lease reuse.",
    supportsReusableLeases: true,
    sandboxCapabilities: {
      incrementalSessionOutput: true,
      concurrentSyncOperations: true,
      duplexCommandStream: true,
    },
    supportsLoginPty: true,
    configSchema: {
      type: "object",
      required: ["apiUrl", "shape"],
      properties: {
        apiUrl: { type: "string", title: "API URL", default: "https://api.sb.createos.sh", description: "https://api.sb.createos.sh" },
        apiKey: { type: "string", format: "secret-ref", description: "CreateOS API key or Paperclip secret reference. Saved keys become company secrets. The official API endpoint can use CREATEOS_API_KEY from the host; custom endpoints require an explicit key." },
        shape: {
          type: "string",
          title: "Shape",
          description: "Choose the sandbox CPU and memory size.",
          // Published catalog from https://api.sb.createos.sh/v1/shapes.
          enum: [
            "s-1vcpu-256mb", "s-0.25vcpu-512mb", "s-0.5vcpu-1gb",
            "s-1vcpu-1gb", "s-1vcpu-2gb", "s-2vcpu-2gb", "s-2vcpu-4gb",
            "s-4vcpu-4gb", "s-4vcpu-8gb", "s-8vcpu-8gb", "s-8vcpu-16gb",
          ],
        },
        rootfs: { type: "string", description: "Root filesystem or ready template ID/name. Omit to use the provider default. The image must supply Bash and the selected agent runtime dependencies." },
        rootfsByAdapter: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Optional adapter-name to root filesystem mapping. A matching adapter overrides rootfs for that run.",
        },
        egressAllowlist: {
          type: "array",
          items: { type: "string" },
          default: [],
          description: "Base outbound allowlist of FQDNs and CIDRs. Empty or [\"*\"] allows all; restrictive task grants are merged per run.",
        },
        region: { type: "string", description: "Optional region; must match the API endpoint's region." },
        timeoutMs: { type: "integer", minimum: 1, maximum: 86400000, default: 300000, description: "Operation and default command timeout in milliseconds. This is not a sandbox lifetime." },
        reuseLease: { type: "boolean", default: false, description: "Keep the sandbox warm after a run so subsequent runs can reuse it; CreateOS pauses it after the configured idle window." },
        autoPauseAfterSeconds: { type: "integer", minimum: 60, maximum: 86400, default: 600, description: "For reusable leases, seconds of inactivity before CreateOS pauses the warm sandbox. Does not provide a guaranteed expiry." },
      },
    },
  }],
};

export default manifest;
