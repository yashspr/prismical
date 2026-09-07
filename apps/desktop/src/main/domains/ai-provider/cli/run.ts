/**
 * Spawning one CLI run and collecting its answer.
 *
 * The contract, uniform across every descriptor: `shell: false`, the prompt
 * written to stdin and stdin then CLOSED (a coding agent that keeps reading
 * would otherwise wait forever for a turn that is never coming), the run
 * bounded by the caller's AbortSignal, and the child killed on abort. stdout
 * and stderr are captured to a cap so a CLI that decides to stream a progress
 * log cannot grow the main process's heap without bound.
 *
 * The working directory is a dedicated EMPTY scratch directory, never the
 * user's home or the app's resources: these are coding agents, and several of
 * them read the working directory for context (CLAUDE.md, AGENTS.md, a git
 * repo) before answering. An empty directory is the closest thing to "no
 * project" they offer.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Beyond this much captured output a run is treated as runaway and killed. */
const OUTPUT_CAP_BYTES = 8 * 1024 * 1024;

export type CliRunFailure =
  | 'not-installed'
  | 'spawn-failed'
  | 'exit-code'
  | 'aborted'
  | 'empty-output';

export interface CliRunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly failure: CliRunFailure | null;
}

export interface CliRunRequest {
  readonly binary: string;
  readonly args: ReadonlyArray<string>;
  /** Written to stdin when set; stdin is closed either way. */
  readonly stdin: string | null;
  readonly cwd: string;
  readonly abortSignal?: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * An empty directory the CLIs can call their workspace. Created per run and
 * removed after it, so nothing a misbehaving agent writes survives, and two
 * concurrent runs never share a `--output-last-message` path.
 */
export const makeRunScratchDir = (): string => {
  const root = path.join(tmpdir(), 'prismical-cli');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, 'run-'));
};

export const removeScratchDir = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // A scratch directory we cannot remove is a temp-dir problem, not a run
    // problem — the answer has already been read out of it.
  }
};

export const readLastMessageFile = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

export const runCli = async (request: CliRunRequest): Promise<CliRunResult> => {
  if (request.abortSignal?.aborted === true) {
    return { ok: false, stdout: '', stderr: '', exitCode: null, failure: 'aborted' };
  }

  return await new Promise<CliRunResult>(resolve => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.binary, [...request.args], {
        cwd: request.cwd,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: request.env ?? process.env,
      });
    } catch {
      resolve({ ok: false, stdout: '', stderr: '', exitCode: null, failure: 'spawn-failed' });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CliRunResult): void => {
      if (settled) return;
      settled = true;
      request.abortSignal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    /**
     * Resolve as soon as the kill is ISSUED rather than waiting for `close`.
     * A coding agent that traps SIGTERM (or is stuck in a syscall) would
     * otherwise leave this promise pending forever, and the caller has already
     * said it does not want the answer. The child is signalled and abandoned.
     */
    function onAbort(): void {
      child.kill('SIGTERM');
      finish({ ok: false, stdout, stderr, exitCode: null, failure: 'aborted' });
    }
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length + chunk.length > OUTPUT_CAP_BYTES) {
        // Same reasoning as the abort path: signal and stop waiting, rather
        // than trusting a runaway process to honour the signal.
        child.kill('SIGTERM');
        finish({ ok: false, stdout, stderr, exitCode: null, failure: 'exit-code' });
        return;
      }
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      // stderr is only ever used to explain a failure, so a small tail is
      // enough and keeps a chatty progress log out of memory.
      stderr = (stderr + chunk).slice(-16_384);
    });

    child.on('error', () => {
      // ENOENT here means the binary vanished between resolution and spawn.
      finish({ ok: false, stdout, stderr, exitCode: null, failure: 'spawn-failed' });
    });

    child.on('close', code => {
      // An aborted or overflowed run has already settled; finish() ignores this.
      finish({
        ok: code === 0,
        stdout,
        stderr,
        exitCode: code,
        failure: code === 0 ? null : 'exit-code',
      });
    });

    // Close stdin in every case: a CLI reading a prompt from stdin waits for
    // EOF before it starts, and one that ignores stdin does not care.
    const stdin = child.stdin;
    if (stdin === null) return;
    stdin.on('error', () => {
      // EPIPE when the CLI exits before reading the prompt; `close` reports it.
    });
    if (request.stdin !== null) stdin.write(request.stdin);
    stdin.end();
  });
};
