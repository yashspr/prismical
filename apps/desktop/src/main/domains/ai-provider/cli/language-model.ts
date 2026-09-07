/**
 * An agent CLI as an AI-SDK LanguageModelV4.
 *
 * The whole `cli` provider reduces to this adapter: the local skill runner
 * calls `generateText` exactly as it does for a BYO key, and this model turns
 * that call into one non-interactive CLI run. Because AiProvider pins the
 * `cli` provider's tool support to 'none', the runner only ever reaches its
 * JSON-in-text rung — so what arrives here is a system prompt, a user prompt
 * and NO tools, which is precisely what a CLI can answer.
 *
 * `doStream` is not implemented. Skills are the supported lane and they are
 * one-shot; Ask streams, and a CLI that buffers its answer for ten seconds
 * behind a chat cursor is worse than no answer at all. It throws the SDK's own
 * unsupported-functionality error rather than faking a stream, so the failure
 * names itself if Ask is ever pointed here.
 *
 * FAILURES THROW `APICallError`. That is not decorative: the skill runner
 * folds an APICallError into a clean `PROVIDER_CALL_FAILED` envelope and
 * rethrows anything else, so a CLI that is missing, misconfigured or angry
 * must arrive as one of these or it takes the whole run down with it.
 */
import {
  APICallError,
  UnsupportedFunctionalityError,
  type LanguageModelV4,
  type LanguageModelV4CallOptions,
  type LanguageModelV4GenerateResult,
  type LanguageModelV4Prompt,
  type LanguageModelV4Usage,
} from '@ai-sdk/provider';
import path from 'node:path';
import { parseJsonlOutput, type CliDescriptor, type CliUsage } from './descriptors';
import { applyPromptPlaceholder, type CustomCommandParse } from './command';
import {
  makeRunScratchDir,
  readLastMessageFile,
  removeScratchDir,
  runCli,
  type CliRunResult,
} from './run';

/** What a run needs beyond the prompt: which binary, which argv, how to read it. */
export type CliInvocation =
  | {
      readonly kind: 'builtin';
      readonly descriptor: CliDescriptor;
      readonly binaryPath: string;
      readonly model: string | null;
      /** Already filtered against the descriptor's own levels; null = omit. */
      readonly effort: string | null;
    }
  | {
      readonly kind: 'custom';
      readonly binaryPath: string;
      readonly argv: ReadonlyArray<string>;
    };

export interface CliLanguageModelOptions {
  readonly modelId: string;
  /** Resolved lazily so a missing binary fails the RUN, not the settings screen. */
  readonly invocation: () => Promise<CliInvocation | CliInvocationError>;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

export type CliInvocationError =
  | { readonly error: 'not-installed'; readonly tool: string }
  | {
      readonly error: 'bad-command';
      readonly problem: Extract<CustomCommandParse, { ok: false }>['problem'];
    };

const isInvocationError = (
  value: CliInvocation | CliInvocationError
): value is CliInvocationError => 'error' in value;

const toV4Usage = (usage: CliUsage): LanguageModelV4Usage => ({
  inputTokens: {
    total: usage.inputTokens,
    noCache: usage.inputTokens,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: usage.outputTokens,
    text: usage.outputTokens,
    reasoning: undefined,
  },
});

/**
 * The V4 prompt flattened to the one string a CLI can take.
 *
 * A CLI has no system-message channel worth using (claude's
 * `--append-system-prompt` would put a whole meeting transcript's worth of
 * instructions on argv), so the system prompt is folded in as a leading block
 * with an explicit separator. File parts are dropped with a warning rather
 * than silently: the skills lane sends text only, and a silently ignored
 * attachment would read as the model ignoring its input.
 */
export const flattenPrompt = (
  prompt: LanguageModelV4Prompt
): { readonly text: string; readonly droppedFiles: number } => {
  const system: string[] = [];
  const turns: string[] = [];
  let droppedFiles = 0;

  for (const message of prompt) {
    if (message.role === 'system') {
      system.push(message.content);
      continue;
    }
    if (message.role === 'tool') continue;
    const parts: string[] = [];
    for (const part of message.content) {
      if (part.type === 'text') parts.push(part.text);
      else if (part.type === 'file') droppedFiles += 1;
    }
    if (parts.length === 0) continue;
    turns.push(message.role === 'assistant' ? `Assistant:\n${parts.join('\n')}` : parts.join('\n'));
  }

  const body = turns.join('\n\n');
  const text = system.length === 0 ? body : `${system.join('\n\n')}\n\n---\n\n${body}`;
  return { text: text.trim(), droppedFiles };
};

const callFailed = (message: string, modelId: string, detail?: string): APICallError =>
  new APICallError({
    message,
    // Not a network call; the "url" names the lane so a log line is legible.
    url: `cli://${modelId}`,
    requestBodyValues: {},
    // Deliberately not 400/422: the skill runner reads those as a provider
    // rejecting the TOOL SHAPE, which has no meaning for a CLI.
    statusCode: 500,
    ...(detail === undefined ? {} : { responseBody: detail }),
    // One failed spawn is enough; a retry would just run the CLI twice.
    isRetryable: false,
  });

/** stderr is for the log and the error detail — trimmed to something readable. */
const tail = (value: string, max = 500): string => {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
};

export const createCliLanguageModel = (options: CliLanguageModelOptions): LanguageModelV4 => {
  const log = options.log ?? (() => undefined);

  const doGenerate = async (
    call: LanguageModelV4CallOptions
  ): Promise<LanguageModelV4GenerateResult> => {
    const invocation = await options.invocation();
    if (isInvocationError(invocation)) {
      throw invocation.error === 'not-installed'
        ? callFailed(
            `The ${invocation.tool} CLI is not installed or could not be found on this computer.`,
            options.modelId
          )
        : callFailed(
            `The custom CLI command is not usable (${invocation.problem}).`,
            options.modelId
          );
    }

    const { text: prompt, droppedFiles } = flattenPrompt(call.prompt);
    if (prompt.length === 0) throw callFailed('The prompt was empty.', options.modelId);

    const scratch = makeRunScratchDir();
    try {
      const lastMessageFile = path.join(scratch, 'last-message.txt');
      const args =
        invocation.kind === 'builtin'
          ? invocation.descriptor.buildArgs({
              model: invocation.model,
              lastMessageFile,
              effort: invocation.effort,
            })
          : [...invocation.argv];
      const placed =
        invocation.kind === 'builtin'
          ? { argv: args, viaStdin: true }
          : applyPromptPlaceholder(args, prompt);

      const started = Date.now();
      const result: CliRunResult = await runCli({
        binary: invocation.binaryPath,
        args: placed.argv,
        stdin: placed.viaStdin ? prompt : null,
        cwd: scratch,
        ...(call.abortSignal === undefined ? {} : { abortSignal: call.abortSignal }),
      });
      log('cli run finished', {
        model: options.modelId,
        ms: Date.now() - started,
        exitCode: result.exitCode,
        failure: result.failure,
      });

      if (result.failure === 'aborted') {
        // The caller aborted: surface the abort, not a provider failure.
        throw call.abortSignal?.reason instanceof Error
          ? call.abortSignal.reason
          : new DOMException('The run was aborted.', 'AbortError');
      }
      if (!result.ok) {
        throw callFailed(
          `The CLI exited with code ${String(result.exitCode)}.`,
          options.modelId,
          tail(result.stderr)
        );
      }

      const mode = invocation.kind === 'builtin' ? invocation.descriptor.output : 'stdout';
      const output =
        mode === 'jsonl'
          ? parseJsonlOutput(result.stdout)
          : mode === 'last-message-file'
            ? { text: readLastMessageFile(lastMessageFile).trim(), usage: {} }
            : { text: result.stdout.trim(), usage: {} };

      if (output.text.length === 0) {
        throw callFailed('The CLI produced no answer.', options.modelId, tail(result.stderr));
      }

      return {
        content: [{ type: 'text', text: output.text }],
        finishReason: { unified: 'stop', raw: 'stop' },
        // toV4Usage of an empty CliUsage IS the empty usage shape.
        usage: toV4Usage(output.usage),
        warnings:
          droppedFiles === 0
            ? []
            : [
                {
                  type: 'other',
                  message: `${String(droppedFiles)} file part(s) were dropped: a CLI provider takes text only.`,
                },
              ],
      };
    } finally {
      removeScratchDir(scratch);
    }
  };

  return {
    specificationVersion: 'v4',
    provider: 'cli',
    modelId: options.modelId,
    supportedUrls: {},
    doGenerate,
    doStream: () => {
      throw new UnsupportedFunctionalityError({
        functionality: 'streaming with a CLI provider',
      });
    },
  };
};
