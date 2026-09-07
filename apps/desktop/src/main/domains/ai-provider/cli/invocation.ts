/**
 * Turning a `cli` model id into something runnable: which binary, which argv.
 *
 * Deliberately LAZY — `buildLanguageModel` is called while resolving a run and
 * must not touch the disk, and a CLI that is missing has to fail the RUN with a
 * provider error rather than the settings screen with a blank card. So this
 * returns the thunk the language model awaits on its first (and only) call.
 */
import type { BinaryResolver } from './binary-path';
import { parseCustomCommand } from './command';
import { descriptorFor, parseCliModelId } from './descriptors';
import type { CliInvocation, CliInvocationError } from './language-model';

export const makeInvocationResolver =
  (args: {
    readonly resolver: BinaryResolver;
    readonly modelId: string;
    readonly cliCommand: string | null;
    /** Optional: omitted means the CLI's own default, like a null value. */
    readonly cliEffort?: string | null;
  }) =>
  async (): Promise<CliInvocation | CliInvocationError> => {
    const ref = parseCliModelId(args.modelId);
    if (ref === null) return { error: 'not-installed', tool: args.modelId };

    if (ref.tool === 'custom') {
      if (args.cliCommand === null) return { error: 'bad-command', problem: 'empty' };
      const parsed = parseCustomCommand(args.cliCommand);
      if (!parsed.ok) return { error: 'bad-command', problem: parsed.problem };
      const [command, ...rest] = parsed.argv;
      if (command === undefined) return { error: 'bad-command', problem: 'empty' };
      // An absolute or relative path is taken as written; a bare name is looked
      // up on the same search path the built-in CLIs use.
      const binaryPath =
        command.includes('/') || command.includes('\\')
          ? command
          : await args.resolver.find(command);
      if (binaryPath === null) return { error: 'not-installed', tool: command };
      return { kind: 'custom', binaryPath, argv: rest };
    }

    const descriptor = descriptorFor(ref.tool);
    if (descriptor === null) return { error: 'not-installed', tool: ref.tool };
    const binaryPath = await args.resolver.find(descriptor.binary);
    if (binaryPath === null) return { error: 'not-installed', tool: descriptor.label };
    // The preference is ONE value shared by every CLI, so it is filtered
    // against the chosen tool's own published levels here. A CLI with no effort
    // control, or one that does not know this level, runs without the flag
    // rather than being handed a token it would reject.
    const effort =
      args.cliEffort != null && descriptor.effortLevels?.includes(args.cliEffort) === true
        ? args.cliEffort
        : null;
    return { kind: 'builtin', descriptor, binaryPath, model: ref.model, effort };
  };
