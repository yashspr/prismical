/**
 * What the `cli` provider offers: which agent CLIs are actually installed on
 * this machine, and which model ids each one accepts.
 *
 * This is the local answer to the other providers' `/models` fetch. Detection
 * is a PATH lookup per descriptor; the model ids are a CLI's own list command
 * where it has one (opencode, cursor-agent) and its documented aliases where it
 * does not (Claude Code). A tool with neither still appears as a bare id —
 * `codex` runs fine on its configured default, and the settings card lets the
 * user type `codex/<model>` for anything else.
 *
 * A list command is best-effort and time-boxed: it spawns a process, and a CLI
 * that hangs (an expired login prompting for auth, a network stall) must not
 * hang the settings card. A timeout drops that tool's models, never the tool.
 */
import type { AiModelListing } from '@prismical/desktop-contracts';
import type { BinaryResolver } from './binary-path';
import { parseCustomCommand } from './command';
import {
  BUILTIN_CLI_DESCRIPTORS,
  formatCliModelId,
  parseModelListOutput,
  type CliDescriptor,
} from './descriptors';
import { makeRunScratchDir, removeScratchDir, runCli } from './run';

/** A list command gets this long before its models are dropped from the listing. */
const LIST_TIMEOUT_MS = 10_000;
/** Per tool, so one CLI with a thousand models cannot bury the others. */
const MODELS_PER_TOOL = 40;

export interface DetectedCli {
  readonly descriptor: CliDescriptor;
  readonly binaryPath: string;
}

/** Every built-in CLI that is installed, in descriptor order. */
export const detectCliTools = async (
  resolver: BinaryResolver
): Promise<ReadonlyArray<DetectedCli>> => {
  const found = await Promise.all(
    BUILTIN_CLI_DESCRIPTORS.map(async descriptor => {
      const binaryPath = await resolver.find(descriptor.binary);
      return binaryPath === null ? null : { descriptor, binaryPath };
    })
  );
  return found.filter((entry): entry is DetectedCli => entry !== null);
};

const listToolModels = async (entry: DetectedCli): Promise<ReadonlyArray<string>> => {
  const { descriptor } = entry;
  if (descriptor.listModelsArgs === undefined) return descriptor.staticModels;
  const scratch = makeRunScratchDir();
  try {
    const result = await runCli({
      binary: entry.binaryPath,
      args: descriptor.listModelsArgs,
      stdin: null,
      cwd: scratch,
      abortSignal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!result.ok) return descriptor.staticModels;
    const ids = parseModelListOutput(result.stdout);
    return ids.length === 0 ? descriptor.staticModels : ids;
  } catch {
    return descriptor.staticModels;
  } finally {
    removeScratchDir(scratch);
  }
};

/**
 * The `cli` provider's model catalogue.
 *
 * `not-configured` when nothing is installed and no custom command is set —
 * the same answer the keyed providers give with no key, and the one the
 * settings card already knows how to explain.
 */
export const listCliModels = async (args: {
  readonly resolver: BinaryResolver;
  readonly cliCommand: string | null;
}): Promise<AiModelListing> => {
  const detected = await detectCliTools(args.resolver);
  const perTool = await Promise.all(
    detected.map(async entry => {
      const models = await listToolModels(entry);
      return [
        // The bare tool id always leads: it runs on whatever model the CLI is
        // already configured for, which is what most people want.
        formatCliModelId(entry.descriptor.id, null),
        ...models
          .slice(0, MODELS_PER_TOOL)
          .map(model => formatCliModelId(entry.descriptor.id, model)),
      ];
    })
  );

  const models = perTool.flat();
  const custom = args.cliCommand === null ? null : parseCustomCommand(args.cliCommand);
  if (custom?.ok === true) models.push('custom');

  if (models.length === 0) return { models: [], error: 'not-configured' };
  return { models, error: null };
};
