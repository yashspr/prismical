/**
 * The agent CLIs the `cli` provider can drive, one descriptor each, plus the
 * pure parsers that pull a final answer out of what each one prints.
 *
 * Every descriptor is a ONE-SHOT, NON-INTERACTIVE run: the prompt goes in on
 * STDIN (all four supported CLIs read it there — never argv, where a meeting
 * transcript would blow past ARG_MAX and show up in `ps`), and exactly one
 * answer comes back. The CLIs are coding agents by trade, so each descriptor
 * also carries the flags that keep a summarization run from wandering: tools
 * denied where the CLI can deny them, sandboxes pinned read-only, MCP servers
 * and workspace-trust prompts off. A run still executes a binary the user
 * installed and signed in to — that is the whole point of the provider — but it
 * must not be able to touch the user's files on the way.
 *
 * Nothing here imports node: the descriptors and the extractors are data and
 * string functions so the wire shapes are unit-testable without spawning
 * anything. `run.ts` does the spawning, `catalogue.ts` the detection.
 */

/** The built-in CLIs, plus `custom` — a command template the user supplies. */
export const CLI_TOOL_IDS = ['claude', 'codex', 'opencode', 'cursor-agent', 'custom'] as const;
export type CliToolId = (typeof CLI_TOOL_IDS)[number];

export const isCliToolId = (value: string): value is CliToolId =>
  (CLI_TOOL_IDS as ReadonlyArray<string>).includes(value);

/**
 * Where a run's final answer is once the process exits:
 *   stdout            → the CLI printed the answer and nothing else;
 *   last-message-file → the CLI wrote it to the path we passed (codex `-o`),
 *                       because its stdout also carries a banner and a log;
 *   jsonl             → one JSON event per line; the text parts concatenate.
 */
export type CliOutputMode = 'stdout' | 'last-message-file' | 'jsonl';

export interface CliDescriptor {
  readonly id: Exclude<CliToolId, 'custom'>;
  /** The executable to look for on PATH (see binary-path.ts). */
  readonly binary: string;
  /** Human name for the settings card and log lines. */
  readonly label: string;
  readonly output: CliOutputMode;
  /**
   * argv for one non-interactive run. `lastMessageFile` is a scratch path the
   * CLI may write its final message to; descriptors that do not use it ignore
   * the argument.
   */
  readonly buildArgs: (input: {
    readonly model: string | null;
    readonly lastMessageFile: string;
    /** The chosen reasoning effort, or null for the CLI's own default. */
    readonly effort: string | null;
  }) => string[];
  /**
   * The reasoning-effort levels this CLI accepts, absent when it has no such
   * control. Declared per descriptor rather than assumed globally: the levels
   * are one CLI's vocabulary, and passing another's would either be rejected or,
   * worse, silently misread. Only levels listed here ever reach an argv.
   */
  readonly effortLevels?: ReadonlyArray<string>;
  /**
   * Model ids offered without probing. Only documented, stable aliases belong
   * here — a guessed model id produces a run that fails at the provider, which
   * reads to the user as "the CLI provider is broken".
   */
  readonly staticModels: ReadonlyArray<string>;
  /** argv that prints the available model ids, when the CLI can list them. */
  readonly listModelsArgs?: ReadonlyArray<string>;
}

/**
 * Claude Code's permission deny-list for a summarization run. Passed as
 * `--settings` JSON so it applies no matter what the user's own settings say;
 * `--strict-mcp-config` with no `--mcp-config` drops every configured MCP
 * server. Note we do NOT pass `--bare`: it forces ANTHROPIC_API_KEY auth and
 * refuses to read the OAuth credentials, which is exactly the subscription this
 * provider exists to use.
 */
/**
 * Claude Code's `--effort` levels. Exported because the settings card offers
 * exactly these — a level the CLI does not know would fail the run at spawn.
 */
export const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

const CLAUDE_DENY_SETTINGS = JSON.stringify({
  permissions: {
    deny: ['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Glob', 'Grep', 'Task'],
  },
});

export const BUILTIN_CLI_DESCRIPTORS: ReadonlyArray<CliDescriptor> = [
  {
    id: 'claude',
    binary: 'claude',
    label: 'Claude Code',
    output: 'stdout',
    buildArgs: ({ model, effort }) => [
      '--print',
      '--output-format',
      'text',
      '--strict-mcp-config',
      '--settings',
      CLAUDE_DENY_SETTINGS,
      ...(model === null ? [] : ['--model', model]),
      ...(effort === null ? [] : ['--effort', effort]),
    ],
    // The published aliases. Claude Code has no list-models command, and
    // pinning dated ids here would rot on every model release.
    staticModels: ['fable', 'opus', 'sonnet', 'haiku'],
    // `claude --effort <level>`, verbatim from its --help. Omitting the flag
    // leaves Claude Code on its own default, which is what `null` means here.
    effortLevels: CLAUDE_EFFORT_LEVELS,
  },
  {
    id: 'codex',
    binary: 'codex',
    label: 'Codex',
    output: 'last-message-file',
    buildArgs: ({ model, lastMessageFile }) => [
      'exec',
      // The run happens in an empty scratch directory, which is not a git
      // repo — codex refuses to start in one without this.
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      '--output-last-message',
      lastMessageFile,
      ...(model === null ? [] : ['--model', model]),
      // `-` is codex's "read the prompt from stdin" argument.
      '-',
    ],
    staticModels: [],
  },
  {
    id: 'opencode',
    binary: 'opencode',
    label: 'opencode',
    output: 'jsonl',
    // opencode's default output is ANSI-decorated and carries a header line;
    // the JSON event stream is the only parseable shape, and it is also the
    // only one of the four CLIs that reports token usage.
    buildArgs: ({ model }) => ['run', '--format', 'json', ...(model === null ? [] : ['-m', model])],
    staticModels: [],
    listModelsArgs: ['models'],
  },
  {
    id: 'cursor-agent',
    binary: 'cursor-agent',
    label: 'Cursor Agent',
    output: 'stdout',
    buildArgs: ({ model }) => [
      '--print',
      '--output-format',
      'text',
      // Without this cursor-agent stops and asks whether the working directory
      // is trusted, which never returns in a non-interactive run.
      '--trust',
      ...(model === null ? [] : ['--model', model]),
    ],
    staticModels: [],
    listModelsArgs: ['--list-models'],
  },
];

export const descriptorFor = (id: CliToolId): CliDescriptor | null =>
  BUILTIN_CLI_DESCRIPTORS.find(descriptor => descriptor.id === id) ?? null;

// ---------------------------------------------------------------------------
// Model ids
//
// The `cli` provider has no single model namespace, so the model id names the
// TOOL first and leaves the rest to that tool: `claude`, `claude/opus`,
// `opencode/openai/gpt-4.1`, `custom`. Split at the FIRST slash only — opencode
// model ids contain slashes of their own.
// ---------------------------------------------------------------------------

export interface CliModelRef {
  readonly tool: CliToolId;
  /** The tool's own model id, or null to let the tool pick its default. */
  readonly model: string | null;
}

export const parseCliModelId = (modelId: string): CliModelRef | null => {
  const trimmed = modelId.trim();
  if (trimmed.length === 0) return null;
  const slash = trimmed.indexOf('/');
  const tool = slash === -1 ? trimmed : trimmed.slice(0, slash);
  if (!isCliToolId(tool)) return null;
  const model = slash === -1 ? '' : trimmed.slice(slash + 1).trim();
  return { tool, model: model.length === 0 ? null : model };
};

export const formatCliModelId = (tool: CliToolId, model: string | null): string =>
  model === null || model.length === 0 ? tool : `${tool}/${model}`;

// ---------------------------------------------------------------------------
// Output extraction
// ---------------------------------------------------------------------------

/** Token counts a CLI happened to report. Every field is optional — most report none. */
export interface CliUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
}

export interface CliOutput {
  readonly text: string;
  readonly usage: CliUsage;
}

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/**
 * opencode's `--format json` stream: one event per line. The answer is every
 * `text` event's `part.text` in order; `step_finish` carries the token counts.
 * A malformed line is skipped rather than failing the run — the stream is a
 * log, and a single unparseable entry must not lose an answer that arrived.
 */
export const parseJsonlOutput = (stdout: string): CliOutput => {
  const chunks: string[] = [];
  let usage: CliUsage = {};
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    const record = event as Record<string, unknown>;
    const part =
      record.part !== null && typeof record.part === 'object'
        ? (record.part as Record<string, unknown>)
        : null;
    if (part === null) continue;
    if (record.type === 'text' && typeof part.text === 'string') {
      chunks.push(part.text);
      continue;
    }
    if (record.type === 'step_finish' && part.tokens !== null && typeof part.tokens === 'object') {
      const tokens = part.tokens as Record<string, unknown>;
      usage = {
        ...(asCount(tokens.input) === undefined ? {} : { inputTokens: asCount(tokens.input) }),
        ...(asCount(tokens.output) === undefined ? {} : { outputTokens: asCount(tokens.output) }),
        ...(asCount(tokens.total) === undefined ? {} : { totalTokens: asCount(tokens.total) }),
      };
    }
  }
  return { text: chunks.join('').trim(), usage };
};

/**
 * A model-listing command's stdout → the ids it named. One id per line, ANSI
 * escapes and blank lines dropped; anything with whitespace inside is a
 * heading or a warning, not an id.
 */
// eslint-disable-next-line no-control-regex -- stripping ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const parseModelListOutput = (stdout: string): string[] => {
  const ids = stdout
    .replace(ANSI, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !/\s/.test(line) && !line.startsWith('-'));
  return Array.from(new Set(ids));
};
