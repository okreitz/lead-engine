/**
 * Registry of the only external binaries the engine may run (CLAUDE.md, SPEC §10).
 *
 * - Each binary is a named entry; callers never pass a binary path.
 * - Arguments are always an array and are never interpolated into a shell (`shell: false`).
 * - Each entry validates its arguments before anything is spawned.
 * - This is the only module allowed to import `execa` (enforced by ESLint).
 */
import { execa } from 'execa';

export interface CommandSpec {
  /** Executable name looked up on PATH. */
  bin: string;
  /** Throws if the argument list is not allowed for this command. */
  validate(args: readonly string[]): void;
  /** Hard timeout in milliseconds. */
  timeoutMs: number;
}

/** Arguments may not contain NUL bytes; anything else is passed through as data. */
function noNulBytes(args: readonly string[]): void {
  for (const arg of args) {
    if (arg.includes('\0')) throw new CommandArgumentError('argument contains a NUL byte');
  }
}

export const COMMANDS = {
  // Headless print mode only. The exact flags are in docs/claude-cli.md; the adapter
  // (Phase 1) builds them and passes the prompt on stdin.
  claude: {
    bin: 'claude',
    timeoutMs: 120_000,
    validate(args) {
      noNulBytes(args);
      if (args[0] !== '-p') throw new CommandArgumentError('claude must run in print mode (-p)');
    },
  },
  // Technology detection (`httpx -td`), Phase 2.
  httpx: {
    bin: 'httpx',
    timeoutMs: 600_000,
    validate(args) {
      noNulBytes(args);
    },
  },
} as const satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;

export class CommandArgumentError extends Error {
  override name = 'CommandArgumentError';
}

export interface RunOptions {
  /** Written to the child's stdin (e.g. the LLM prompt). */
  input?: string;
  /** Working directory; defaults to the engine's. */
  cwd?: string;
  /** Extra environment variables. The parent environment is inherited. */
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs an allowlisted binary with an argument array. Never uses a shell. */
export async function runCommand(
  name: CommandName,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const spec: CommandSpec | undefined = COMMANDS[name];
  if (!spec) throw new CommandArgumentError(`unknown command: ${String(name)}`);
  spec.validate(args);

  const result = await execa(spec.bin, [...args], {
    shell: false,
    reject: false,
    timeout: spec.timeoutMs,
    stripFinalNewline: true,
    ...(options.input !== undefined ? { input: options.input } : { stdin: 'ignore' as const }),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
  });

  return {
    exitCode: result.exitCode ?? -1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    timedOut: result.timedOut,
  };
}
