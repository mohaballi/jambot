import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Devbox } from "@namespacelabs/sdk/devbox";
import { PermissionDeniedErrorSchema } from "@namespacelabs/sdk/proto/namespace/cloud/iam/v1beta/authz_pb";

export const DEVBOX_NAME = process.env.DEVBOX_NAME ?? "jambox";
export const APP_PORT = Number(process.env.APP_PORT ?? 3000);
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);

let namespaceAuthConfigured = false;

/**
 * The Namespace SDK resolves credentials from `NSC_TOKEN_FILE`,
 * `/var/run/nsc/token.json`, or the local user config — none of which exist on
 * a serverless host. `NAMESPACE_TOKEN` is written to a token file in the temp
 * dir and pointed at via `NSC_TOKEN_FILE` so the SDK's default resolution finds
 * it after every restart. Session tokens (`st_`) are stored as `session_token`
 * so the SDK can mint fresh bearer tokens; anything else is a `bearer_token`.
 */
export function configureNamespaceAuth(): void {
  if (namespaceAuthConfigured) return;
  namespaceAuthConfigured = true;

  if (process.env.NSC_TOKEN_FILE) return;

  const token = process.env.NAMESPACE_TOKEN?.trim();
  if (!token) return;

  const dir = join(tmpdir(), "nsc");
  const file = join(dir, "token.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(parseNamespaceToken(token)), { mode: 0o600 });
    process.env.NSC_TOKEN_FILE = file;
  } catch (error) {
    console.error("Failed to write Namespace token file", error);
  }
}

function parseNamespaceToken(token: string): Record<string, string> {
  if (token.startsWith("{")) {
    try {
      const parsed = JSON.parse(token);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Fall through and treat it as a raw token value.
    }
  }

  return token.startsWith("st_") ? { session_token: token } : { bearer_token: token };
}

interface MissingPermission {
  resourceType: string;
  action: string;
}

/**
 * A Namespace RPC denied for lack of grants fails as a Connect error carrying a
 * `PermissionDeniedError` detail. Pull the missing grants out so the failure
 * names exactly which permission the token needs.
 */
export function formatPermissionError(error: unknown): string | undefined {
  const findDetails = (error as { findDetails?: (schema: unknown) => unknown })?.findDetails;
  if (typeof findDetails !== "function") return undefined;

  let found: unknown;
  try {
    found = findDetails.call(error, PermissionDeniedErrorSchema);
  } catch {
    return undefined;
  }

  const missing = (found as { missingAccessPermissions?: MissingPermission[] }[])?.flatMap(
    (detail) => detail.missingAccessPermissions ?? [],
  );
  if (!missing?.length) return undefined;

  return [...new Set(missing.map((access) => `${access.resourceType}:${access.action}`))].join(", ");
}

const POLL_INTERVAL_MS = 2_000;
const SESSION_START_TIMEOUT_MS = 90_000;
const EXISTING_SESSION_TIMEOUT_MS = 15_000;

interface SessionSummary {
  name: string;
}

interface AgentSessionClient {
  listTerminalSessions(input: object): Promise<{ sessions: SessionSummary[] }>;
  createTerminalSession(input: { name: string; command: string }): Promise<unknown>;
  deleteTerminalSession(input: { name: string }): Promise<unknown>;
}

async function sessionClient(devbox: Devbox): Promise<AgentSessionClient> {
  const handle = devbox as unknown as {
    connections?: { getAgent(ref: string): Promise<{ client?: AgentSessionClient }> };
  };

  if (!handle.connections) {
    throw new Error("Namespace SDK no longer exposes devbox agent connections");
  }

  const agent = await handle.connections.getAgent(devbox.id);
  if (!agent.client) {
    throw new Error("Namespace SDK no longer exposes the devbox agent client");
  }

  return agent.client;
}

/** Devboxes suspend when idle; start them before using sessions/exec. */
export async function ensureRunning(devbox: Devbox): Promise<void> {
  if (devbox.info.state === "running") return;
  await devbox.start({ timeoutMs: 180_000 });
}

export function workspaceDir(devbox: Devbox): string {
  return devbox.info.defaultDir ?? devbox.info.workspaceDir ?? "/workspaces";
}

/** Switches the workspace to `main` before any work starts. */
export async function checkoutMain(devbox: Devbox, workspace: string): Promise<void> {
  await git(devbox, workspace, ["checkout", "main"]);
}

/** Fast-forwards `main` to the remote before any work starts. */
export async function pullMain(devbox: Devbox, workspace: string): Promise<void> {
  await git(devbox, workspace, ["pull"]);
}

async function git(devbox: Devbox, workspace: string, args: string[]): Promise<void> {
  const result = await devbox.exec(["git", ...args], { cwd: workspace, timeoutMs: 60_000 });
  if (result.exitCode !== 0) {
    const detail = result.error ?? (result.stderr.trim() || "unknown error");
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
}

export function appSessionCommand(workspace: string): string {
  return `bash -lc "cd ${workspace} && exec npm run dev"`;
}

export function opencodeSessionCommand(workspace: string): string {
  return `bash -lc "cd ${workspace} && exec opencode serve --port ${OPENCODE_PORT}"`;
}

/**
 * The cached agent connection can be dropped by the gateway mid-call (it has no
 * keepalive). The SDK surfaces that as a `ConnectError` with code `Unknown` and
 * Node's `Premature close` message. Invalidate the cached tunnel and retry once.
 */
async function withAgentRetry<T>(devbox: Devbox, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!isStaleConnectionError(error)) throw error;
    const handle = devbox as unknown as { connections?: { invalidate(ref: string): void } };
    handle.connections?.invalidate(devbox.id);
    return fn();
  }
}

function isStaleConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /premature close|connection is closed|socket hang up|ECONNRESET/i.test(message);
}

export async function ensureSession(
  devbox: Devbox,
  options: { name: string; command: string; port: number },
): Promise<boolean> {
  return withAgentRetry(devbox, async () => {
    const sessions = await sessionClient(devbox);
    const existing = await sessions.listTerminalSessions({});
    const present = existing.sessions.some((session) => session.name === options.name);

    if (present) {
      if (await waitForPort(devbox, options.port, EXISTING_SESSION_TIMEOUT_MS)) return true;
      await sessions.deleteTerminalSession({ name: options.name });
    }

    await sessions.createTerminalSession({ name: options.name, command: options.command });
    return waitForPort(devbox, options.port, SESSION_START_TIMEOUT_MS);
  });
}

export async function ensureExposedPort(devbox: Devbox, port: number, name: string): Promise<string> {
  return withAgentRetry(devbox, async () => {
    // Reuse a port already exposing this number, whatever it's named.
    const byNumber = await getPortQuietly(devbox, { number: port });
    if (byNumber) return byNumber.url;

    // A leftover port can hold this name on a different number, which makes
    // create() fail with a name conflict. Rebind it before creating.
    const byName = await getPortQuietly(devbox, { name });
    if (byName) {
      if (byName.number === port) return byName.url;
      await devbox.exposedPorts.delete({ id: byName.id }).catch(() => undefined);
    }

    try {
      const created = await devbox.exposedPorts.create({ number: port, name });
      return created.url;
    } catch (error) {
      // The port already exists — a lookup missed it or a concurrent call won.
      const raced = await getPortQuietly(devbox, { name });
      if (raced?.number === port) return raced.url;
      throw error;
    }
  });
}

/**
 * Like `exposedPorts.get`, but returns undefined only when the port genuinely
 * isn't there. A dropped agent connection rethrows so `withAgentRetry` can
 * reconnect, instead of falling through to a create that conflicts.
 */
async function getPortQuietly(
  devbox: Devbox,
  selector: { number: number } | { name: string },
): Promise<{ id: string; number: number; url: string } | undefined> {
  try {
    return await devbox.exposedPorts.get(selector);
  } catch (error) {
    if (error instanceof Error && error.name === "ExposedPortNotFoundError") return undefined;
    throw error;
  }
}

function opencodeBase(): string {
  return `http://127.0.0.1:${OPENCODE_PORT}`;
}

interface OpencodeResponse {
  status: number;
  body: string;
}

/**
 * Talks to the opencode server over its HTTP API. The server only listens on
 * the devbox loopback, so requests run there via exec with an argv array (no
 * shell, so prompts need no escaping).
 */
async function opencodeRequest(
  devbox: Devbox,
  workspace: string,
  method: string,
  path: string,
  payload?: unknown,
): Promise<OpencodeResponse> {
  const argv = ["curl", "-s", "-S", "-X", method, "-H", "content-type: application/json", "-w", "\n%{http_code}"];
  if (payload !== undefined) argv.push("--data", JSON.stringify(payload));
  argv.push(`${opencodeBase()}${path}`);

  const result = await devbox.exec(argv, { cwd: workspace, timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`opencode request failed: ${result.error ?? (result.stderr.trim() || "unknown error")}`);
  }

  const split = result.stdout.lastIndexOf("\n");
  return {
    status: Number(result.stdout.slice(split + 1).trim()),
    body: result.stdout.slice(0, split),
  };
}

export async function createOpencodeSession(
  devbox: Devbox,
  workspace: string,
  title: string,
): Promise<string> {
  const { status, body } = await opencodeRequest(devbox, workspace, "POST", "/session", {
    title,
    directory: workspace,
  });
  const sessionId = status < 300 ? (JSON.parse(body) as { id?: string }).id : undefined;

  if (!sessionId) {
    throw new Error(`could not create an opencode session (HTTP ${status}): ${body.trim().slice(0, 200)}`);
  }

  return sessionId;
}

/** Fire-and-forget prompt: returns as soon as opencode accepts it. */
export async function promptOpencodeSession(
  devbox: Devbox,
  workspace: string,
  sessionId: string,
  prompt: string,
): Promise<void> {
  const { status, body } = await opencodeRequest(
    devbox,
    workspace,
    "POST",
    `/session/${sessionId}/prompt_async`,
    { parts: [{ type: "text", text: prompt }] },
  );

  if (status >= 300) {
    throw new Error(`opencode rejected the prompt (HTTP ${status}): ${body.trim().slice(0, 200)}`);
  }
}

/** Describes a permission request opencode is blocked on, if any. */
export async function pendingOpencodePermission(
  devbox: Devbox,
  workspace: string,
  sessionId: string,
): Promise<string | undefined> {
  const { body } = await opencodeRequest(devbox, workspace, "GET", "/permission");
  if (!body.trim()) return undefined;

  const pending = (JSON.parse(body) as {
    sessionID?: string;
    permission?: string;
    patterns?: string[];
  }[]).find((request) => request.sessionID === sessionId);

  if (!pending) return undefined;
  return `${pending.permission ?? "action"} ${(pending.patterns ?? []).join(", ")}`.trim();
}

export interface OpencodeSessionStatus {
  /** Whether opencode produced an assistant turn at all. */
  replied: boolean;
  /** Error reported on the last assistant turn, if any. */
  error?: string;
}

export async function opencodeSessionStatus(
  devbox: Devbox,
  workspace: string,
  sessionId: string,
): Promise<OpencodeSessionStatus> {
  const { body } = await opencodeRequest(devbox, workspace, "GET", `/session/${sessionId}/message`);
  const messages = body.trim()
    ? (JSON.parse(body) as { info?: { role?: string; error?: unknown } }[])
    : [];
  const assistant = messages.filter((message) => message.info?.role === "assistant");
  const failed = assistant.filter((message) => message.info?.error);

  return {
    replied: assistant.length > 0,
    error: failed.length ? JSON.stringify(failed[failed.length - 1].info?.error).slice(0, 300) : undefined,
  };
}

/**
 * URL that opens a session in the opencode web UI. The UI addresses sessions by
 * base64url(directory) rather than the raw path, which would otherwise collide
 * with the `/session/{id}` JSON API.
 */
export function opencodeSessionUrl(baseUrl: string, workspace: string, sessionId: string): string {
  const slug = Buffer.from(workspace, "utf8").toString("base64url");
  return `${baseUrl.replace(/\/+$/, "")}/${slug}/session/${sessionId}`;
}

async function portStatus(devbox: Devbox, port: number): Promise<boolean> {
  try {
    const probe = await devbox.exec(
      [
        "curl",
        "-s",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        "3",
        `http://127.0.0.1:${port}/`,
      ],
      { timeoutMs: 10_000 },
    );
    const status = Number(probe.stdout.trim());
    return probe.exitCode === 0 && status >= 200 && status < 400;
  } catch {
    return false;
  }
}

async function waitForPort(devbox: Devbox, port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  do {
    if (await portStatus(devbox, port)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  } while (Date.now() < deadline);

  return false;
}
