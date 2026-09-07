/**
 * LanguageModel construction per provider. Each BYOK provider
 * goes through its official AI-SDK package; Ollama and any other
 * OpenAI-compatible server go through `@ai-sdk/openai-compatible` (Ollama
 * serves the OpenAI chat protocol, tools included, under `/v1`). The `cli`
 * provider has no SDK and no endpoint — it drives an agent CLI already
 * installed and signed in on this machine, through the adapter in `cli/`. The
 * key is handed to the SDK and nowhere else — never logged, never in an error.
 */
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { AiProviderKind } from '@prismical/desktop-contracts';
import { normalizeBaseUrl, ollamaChatBaseUrl, type FetchLike } from './catalogue';
import type { BinaryResolver } from './cli/binary-path';
import { makeInvocationResolver } from './cli/invocation';
import { createCliLanguageModel } from './cli/language-model';

export interface BuildModelArgs {
  readonly provider: AiProviderKind;
  readonly modelId: string;
  readonly apiKey: string | null;
  /** Already resolved against PROVIDER_DEFAULTS by the caller (null = the SDK default). */
  readonly baseUrl: string | null;
  readonly fetchFn?: FetchLike;
  /** `cli` only: how a CLI name becomes a path. Required for that provider. */
  readonly binaryResolver?: BinaryResolver;
  /** `cli` only: the user's custom command template, when the model id is `custom`. */
  readonly cliCommand?: string | null;
  /** `cli` only: reasoning effort, for the CLIs whose descriptor declares it. */
  readonly cliEffort?: string | null;
  readonly log?: (message: string, data?: Record<string, unknown>) => void;
}

export function buildLanguageModel(args: BuildModelArgs): LanguageModel {
  const fetch = args.fetchFn as typeof globalThis.fetch | undefined;
  switch (args.provider) {
    case 'openai':
      return createOpenAI({
        apiKey: args.apiKey ?? undefined,
        ...(args.baseUrl ? { baseURL: normalizeBaseUrl(args.baseUrl) } : {}),
        ...(fetch ? { fetch } : {}),
      })(args.modelId);
    case 'anthropic':
      return createAnthropic({
        apiKey: args.apiKey ?? undefined,
        ...(args.baseUrl ? { baseURL: normalizeBaseUrl(args.baseUrl) } : {}),
        ...(fetch ? { fetch } : {}),
      })(args.modelId);
    case 'openai-compatible':
      return createOpenAICompatible({
        name: 'openai-compatible',
        baseURL: normalizeBaseUrl(args.baseUrl ?? ''),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
        ...(fetch ? { fetch } : {}),
      }).chatModel(args.modelId);
    case 'ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: ollamaChatBaseUrl(args.baseUrl ?? ''),
        ...(fetch ? { fetch } : {}),
      }).chatModel(args.modelId);
    case 'cli': {
      // AiProviderLive always supplies the resolver; a caller that does not is
      // a wiring bug, and one that fails every run beats one that silently
      // resolves CLIs against the truncated GUI PATH.
      const resolver = args.binaryResolver;
      if (resolver === undefined) {
        throw new Error('buildLanguageModel: the cli provider needs a binaryResolver');
      }
      return createCliLanguageModel({
        modelId: args.modelId,
        invocation: makeInvocationResolver({
          resolver,
          modelId: args.modelId,
          cliCommand: args.cliCommand ?? null,
          cliEffort: args.cliEffort ?? null,
        }),
        ...(args.log === undefined ? {} : { log: args.log }),
      });
    }
  }
}
