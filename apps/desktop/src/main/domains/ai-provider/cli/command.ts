/**
 * The `custom` CLI tool: a command template the user types into the settings
 * card, turned into an argv WITHOUT a shell.
 *
 * This is the one place in the provider where the user hands us something to
 * execute, so the rules are deliberately narrow. The template is tokenized
 * here — quote-aware, but with no expansion of any kind — and the resulting
 * argv goes to `spawn` with `shell: false`. There is no `$VAR`, no `~`, no
 * globbing, no `&&`, no pipe, no redirect: a template containing shell
 * metacharacters is REJECTED rather than quietly interpreted, because a user
 * who writes `foo && rm -rf bar` expecting a shell must not get a silent
 * half-execution, and a template assembled from anywhere but the user's own
 * keystrokes must not be able to reach a shell at all.
 *
 * `{prompt}` in the template is replaced by the prompt text. With no
 * `{prompt}` anywhere, the prompt goes in on stdin — the same contract the
 * built-in descriptors use, and the right default for a meeting transcript.
 */

/** The prompt's slot in a template; absent means the prompt rides stdin. */
export const PROMPT_PLACEHOLDER = '{prompt}';

/** A template with any of these is rejected: they only mean something to a shell. */
const SHELL_METACHARACTERS = /[|&;<>$`\\!*?()[\]{}]/;

export type CustomCommandProblem = 'empty' | 'shell-metacharacters' | 'unbalanced-quotes';

export type CustomCommandParse =
  | { readonly ok: true; readonly argv: ReadonlyArray<string> }
  | { readonly ok: false; readonly problem: CustomCommandProblem };

/**
 * Split a template into argv on unquoted whitespace, honouring single and
 * double quotes as grouping only (no escapes inside — an escape is a shell
 * concept and the metacharacter check has already rejected backslashes).
 *
 * `{prompt}` survives tokenization as literal text inside whatever token holds
 * it; substitution happens later, per run, in `applyPromptPlaceholder`.
 */
export const parseCustomCommand = (template: string): CustomCommandParse => {
  const trimmed = template.trim();
  if (trimmed.length === 0) return { ok: false, problem: 'empty' };

  // `{` and `}` are metacharacters to a shell but we need them for {prompt},
  // so check the template with the placeholder removed.
  const withoutPlaceholder = trimmed.replaceAll(PROMPT_PLACEHOLDER, '');
  if (SHELL_METACHARACTERS.test(withoutPlaceholder)) {
    return { ok: false, problem: 'shell-metacharacters' };
  }

  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const char of trimmed) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== null) return { ok: false, problem: 'unbalanced-quotes' };
  if (started) argv.push(current);
  if (argv.length === 0) return { ok: false, problem: 'empty' };
  return { ok: true, argv };
};

export interface PlacedPrompt {
  readonly argv: ReadonlyArray<string>;
  /** True when no token held the placeholder, so the prompt must ride stdin. */
  readonly viaStdin: boolean;
}

/** Substitute `{prompt}` wherever it appears; report when it appeared nowhere. */
export const applyPromptPlaceholder = (
  argv: ReadonlyArray<string>,
  prompt: string
): PlacedPrompt => {
  const viaStdin = !argv.some(token => token.includes(PROMPT_PLACEHOLDER));
  return {
    argv: viaStdin ? argv : argv.map(token => token.replaceAll(PROMPT_PLACEHOLDER, prompt)),
    viaStdin,
  };
};
