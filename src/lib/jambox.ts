import type { Devbox } from "@namespacelabs/sdk/devbox";

export const DEVBOX_NAME = process.env.DEVBOX_NAME ?? "jambox";
export const APP_PORT = Number(process.env.APP_PORT ?? 3000);
export const OPENCODE_PORT = Number(process.env.OPENCODE_PORT ?? 4096);

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

export function appSessionCommand(workspace: string): string {
  return `bash -lc "cd ${workspace} && exec npm run dev"`;
}

export function opencodeSessionCommand(workspace: string): string {
  return `bash -lc "cd ${workspace} && exec opencode serve --port ${OPENCODE_PORT}"`;
}

export async function ensureSession(
  devbox: Devbox,
  options: { name: string; command: string; port: number },
): Promise<boolean> {
  const sessions = await sessionClient(devbox);
  const existing = await sessions.listTerminalSessions({});
  const present = existing.sessions.some((session) => session.name === options.name);

  if (present) {
    if (await waitForPort(devbox, options.port, EXISTING_SESSION_TIMEOUT_MS)) return true;
    await sessions.deleteTerminalSession({ name: options.name });
  }

  await sessions.createTerminalSession({ name: options.name, command: options.command });
  return waitForPort(devbox, options.port, SESSION_START_TIMEOUT_MS);
}

export async function ensureExposedPort(devbox: Devbox, port: number, name: string): Promise<string> {
  const existing = await devbox.exposedPorts.get({ number: port }).catch(() => undefined);
  if (existing?.url) return existing.url;

  const created = await devbox.exposedPorts.create({ number: port, name });
  return created.url;
}

export async function promptOpencode(devbox: Devbox, workspace: string, prompt: string) {
  const lookup = await devbox.exec(
    [
      "bash",
      "-lc",
      'command -v opencode || { test -x "$HOME/.opencode/bin/opencode" && printf %s "$HOME/.opencode/bin/opencode"; }',
    ],
    { cwd: workspace },
  );
  const binary = lookup.stdout.trim();

  if (lookup.exitCode !== 0 || !binary) {
    throw new Error("opencode is not installed on the devbox");
  }

  return devbox.executions.start(
    [binary, "run", "--attach", `http://127.0.0.1:${OPENCODE_PORT}`, "--dir", workspace, prompt],
    { cwd: workspace, timeoutMs: 30_000 },
  );
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
