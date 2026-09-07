/**
 * Finding a CLI on disk from inside Electron.
 *
 * A GUI app on macOS does NOT inherit the user's shell PATH. Launched from the
 * Dock or Finder, `process.env.PATH` is roughly `/usr/bin:/bin:/usr/sbin:/sbin`
 * — so `claude` in `/opt/homebrew/bin`, `codex` under an nvm node, and anything
 * a version manager puts on PATH are all invisible, even though they run fine
 * in the user's terminal. `pnpm dev` hides this completely: a dev build started
 * FROM a shell inherits that shell's PATH and every CLI is found, right up
 * until the packaged app ships and finds none of them.
 *
 * So the search path is the process PATH plus (a) the user's login-shell PATH,
 * asked once per boot and cached, which is what picks up nvm / asdf / mise /
 * volta, and (b) a static list of the usual install directories, as the answer
 * when the login shell is unavailable or slow.
 *
 * The lookup itself is a direct stat of each candidate directory rather than
 * `which`: no shell, no PATH interpretation, and an answer we can log.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const isWindows = platform() === 'win32';

/** How long the login shell gets to print its PATH before we fall back. */
const LOGIN_SHELL_TIMEOUT_MS = 3_000;

/**
 * Where these CLIs actually install. Homebrew (both prefixes), the npm global
 * prefixes, and the per-user bin directories the install scripts prefer.
 */
const staticCandidates = (): string[] => {
  const home = homedir();
  if (isWindows) {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    return [
      path.join(appData, 'npm'),
      path.join(localAppData, 'Programs'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.local', 'bin'),
    ];
  }
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.deno', 'bin'),
    path.join(home, '.npm-global', 'bin'),
  ];
};

const splitPath = (value: string | undefined): string[] =>
  (value ?? '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);

/**
 * The login shell's PATH. `-l` so the profile that sets up nvm/asdf actually
 * runs, `-i` because many people configure PATH in the interactive rc file
 * rather than the profile. Any failure is an empty answer, never a throw: a
 * user with an exotic or broken shell must still get the static candidates.
 */
export const loginShellPath = async (): Promise<string[]> => {
  if (isWindows) return [];
  const shell = process.env.SHELL;
  if (shell === undefined || shell.length === 0) return [];
  try {
    const { stdout } = await execFileAsync(shell, ['-lic', 'echo "$PATH"'], {
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      encoding: 'utf8',
      // A profile that prints a banner can be chatty; PATH is one line and we
      // take the last non-empty one.
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.includes(path.delimiter) || line.startsWith('/'));
    return splitPath(lines.at(-1));
  } catch {
    return [];
  }
};

export interface BinaryResolver {
  /** The absolute path to `binary`, or null when it is not installed. */
  readonly find: (binary: string) => Promise<string | null>;
}

const executableAt = (dir: string, binary: string): string | null => {
  const candidates = isWindows
    ? [`${binary}.cmd`, `${binary}.exe`, `${binary}.bat`, binary]
    : [binary];
  for (const name of candidates) {
    const full = path.join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      // On Windows the execute bit is meaningless; presence is the test.
      if (!isWindows) accessSync(full, constants.X_OK);
      return full;
    } catch {
      continue;
    }
  }
  return null;
};

/**
 * A resolver that asks the login shell at most once and memoizes both the
 * search path and every lookup. Boot-scoped by AiProviderLive: a CLI installed
 * while the app is running is picked up after a restart, which is the same
 * bargain the rest of the provider makes with its catalogue cache.
 */
export const makeBinaryResolver = (options: {
  readonly readLoginShellPath?: () => Promise<string[]>;
  readonly staticDirs?: ReadonlyArray<string>;
  readonly processPath?: string;
}): BinaryResolver => {
  const readLogin = options.readLoginShellPath ?? loginShellPath;
  const statics = options.staticDirs ?? staticCandidates();
  const fromProcess = splitPath(options.processPath ?? process.env.PATH);

  let searchDirs: Promise<ReadonlyArray<string>> | null = null;
  const dirs = (): Promise<ReadonlyArray<string>> => {
    searchDirs ??= readLogin().then(login =>
      // Order matters: the process PATH first (a dev run's shell is already
      // the right answer), then the login shell, then the guesses.
      Array.from(new Set([...fromProcess, ...login, ...statics]))
    );
    return searchDirs;
  };

  const found = new Map<string, Promise<string | null>>();
  return {
    find: binary => {
      const cached = found.get(binary);
      if (cached !== undefined) return cached;
      const lookup = dirs().then(list => {
        for (const dir of list) {
          const hit = executableAt(dir, binary);
          if (hit !== null) return hit;
        }
        return null;
      });
      found.set(binary, lookup);
      return lookup;
    },
  };
};
