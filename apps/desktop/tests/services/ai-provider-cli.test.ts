/**
 * The `cli` provider: argv construction, output extraction, the custom-command
 * tokenizer, binary resolution, and a real end-to-end run against a stub
 * "CLI" (a shell script this test writes) so the spawn contract — prompt on
 * stdin, stdin closed, answer on stdout — is exercised for real rather than
 * mocked.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, assert, describe, expect, it } from 'vitest';
import { makeBinaryResolver } from '../../src/main/domains/ai-provider/cli/binary-path';
import {
  applyPromptPlaceholder,
  parseCustomCommand,
} from '../../src/main/domains/ai-provider/cli/command';
import {
  descriptorFor,
  formatCliModelId,
  parseCliModelId,
  parseJsonlOutput,
  parseModelListOutput,
} from '../../src/main/domains/ai-provider/cli/descriptors';
import {
  createCliLanguageModel,
  flattenPrompt,
} from '../../src/main/domains/ai-provider/cli/language-model';
import { makeInvocationResolver } from '../../src/main/domains/ai-provider/cli/invocation';
import { listCliModels } from '../../src/main/domains/ai-provider/cli/catalogue';

const scratch = mkdtempSync(path.join(tmpdir(), 'prismical-cli-test-'));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A stub CLI on disk: a script whose behaviour each test picks. */
const writeStubCli = (name: string, body: string): string => {
  const dir = path.join(scratch, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return dir;
};

describe('cli descriptors', () => {
  it('builds a claude run that is non-interactive and cannot touch the disk', () => {
    const claude = descriptorFor('claude');
    assert.isNotNull(claude);
    const args = claude.buildArgs({ model: 'opus', lastMessageFile: '/tmp/x', effort: null });
    expect(args).toContain('--print');
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--model'))).toEqual(['--model', 'opus']);
    // The deny list rides --settings as JSON and must name the file/exec tools.
    const settings = args[args.indexOf('--settings') + 1] ?? '';
    const parsed = JSON.parse(settings) as { permissions: { deny: string[] } };
    expect(parsed.permissions.deny).toEqual(
      expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'WebFetch'])
    );
  });

  it('passes --effort only when a level is chosen, and offers fable', () => {
    const claude = descriptorFor('claude');
    assert.isNotNull(claude);
    // `fable` is a published alias (claude --help names it alongside opus and
    // sonnet); it was missing from the suggestions, not from the CLI.
    expect(claude.staticModels).toContain('fable');

    const withEffort = claude.buildArgs({ model: 'opus', lastMessageFile: '/tmp/x', effort: 'high' });
    expect(withEffort.slice(withEffort.indexOf('--effort'))).toEqual(['--effort', 'high']);
    // No level chosen → no flag at all, so Claude Code keeps its own default
    // rather than being pinned to one we picked for it.
    expect(claude.buildArgs({ model: 'opus', lastMessageFile: '/tmp/x', effort: null })).not.toContain(
      '--effort'
    );
    expect(claude.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('never hands a CLI an effort level it does not publish', async () => {
    // The preference is ONE value shared by every CLI. codex declares no
    // effortLevels, so the flag must not appear in its argv however the user
    // set the control — an unknown token would fail the run at spawn.
    const dir = writeStubCli('codex', 'cat');
    const resolved = await makeInvocationResolver({
      resolver: makeBinaryResolver({
        processPath: dir,
        staticDirs: [],
        readLoginShellPath: () => Promise.resolve([]),
      }),
      modelId: 'codex',
      cliCommand: null,
      cliEffort: 'max',
    })();
    assert.isTrue('kind' in resolved && resolved.kind === 'builtin');
    if ('kind' in resolved && resolved.kind === 'builtin') {
      assert.strictEqual(resolved.effort, null, 'filtered out for a CLI with no levels');
    }
  });

  it('carries a published effort level through to the run', async () => {
    const dir = writeStubCli('claude', 'cat');
    const resolved = await makeInvocationResolver({
      resolver: makeBinaryResolver({
        processPath: dir,
        staticDirs: [],
        readLoginShellPath: () => Promise.resolve([]),
      }),
      modelId: 'claude/opus',
      cliCommand: null,
      cliEffort: 'xhigh',
    })();
    assert.isTrue('kind' in resolved && resolved.kind === 'builtin');
    if ('kind' in resolved && resolved.kind === 'builtin') {
      assert.strictEqual(resolved.effort, 'xhigh');
      expect(
        resolved.descriptor.buildArgs({
          model: resolved.model,
          lastMessageFile: '/tmp/x',
          effort: resolved.effort,
        })
      ).toContain('--effort');
    }
  });

  it('omits the model flag entirely when no model is pinned', () => {
    expect(
      descriptorFor('claude')?.buildArgs({ model: null, lastMessageFile: '/tmp/x', effort: null })
    ).not.toContain('--model');
    expect(
      descriptorFor('codex')?.buildArgs({ model: null, lastMessageFile: '/tmp/x', effort: null })
    ).not.toContain('--model');
  });

  it('points codex at the scratch last-message file and reads the prompt from stdin', () => {
    const args = descriptorFor('codex')?.buildArgs({
      model: 'gpt-5.6',
      lastMessageFile: '/tmp/last.txt',
      effort: null,
    });
    assert.isDefined(args);
    expect(args.slice(args.indexOf('--output-last-message'))).toContain('/tmp/last.txt');
    expect(args).toContain('--skip-git-repo-check');
    expect(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2)).toEqual([
      '--sandbox',
      'read-only',
    ]);
    // `-` is what makes codex read stdin, and it must come last.
    expect(args.at(-1)).toBe('-');
  });

  it('passes cursor-agent the trust flag a non-interactive run cannot answer for', () => {
    expect(
      descriptorFor('cursor-agent')?.buildArgs({ model: null, lastMessageFile: '', effort: null })
    ).toContain('--trust');
  });
});

describe('cli model ids', () => {
  it('splits at the first slash so a nested model id survives', () => {
    expect(parseCliModelId('claude')).toEqual({ tool: 'claude', model: null });
    expect(parseCliModelId('claude/opus')).toEqual({ tool: 'claude', model: 'opus' });
    expect(parseCliModelId('opencode/openai/gpt-4.1')).toEqual({
      tool: 'opencode',
      model: 'openai/gpt-4.1',
    });
  });

  it('rejects an id that names no known tool', () => {
    expect(parseCliModelId('gpt-5')).toBeNull();
    expect(parseCliModelId('')).toBeNull();
    expect(parseCliModelId('   ')).toBeNull();
  });

  it('round-trips through formatCliModelId', () => {
    expect(formatCliModelId('opencode', 'openai/gpt-4.1')).toBe('opencode/openai/gpt-4.1');
    expect(formatCliModelId('claude', null)).toBe('claude');
    expect(parseCliModelId(formatCliModelId('codex', 'gpt-5.6'))).toEqual({
      tool: 'codex',
      model: 'gpt-5.6',
    });
  });
});

describe('cli output extraction', () => {
  it("concatenates opencode's text events and picks up its token counts", () => {
    const stdout = [
      '{"type":"step_start","part":{"type":"step-start"}}',
      '{"type":"text","part":{"type":"text","text":"## Summary\\n"}}',
      '{"type":"text","part":{"type":"text","text":"- a point"}}',
      '{"type":"step_finish","part":{"tokens":{"total":120,"input":100,"output":20}}}',
    ].join('\n');
    expect(parseJsonlOutput(stdout)).toEqual({
      text: '## Summary\n- a point',
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
    });
  });

  it('skips a malformed line rather than losing an answer that arrived', () => {
    const stdout = [
      'not json at all',
      '{"type":"text","part":{"type":"text","text":"kept"}}',
      '{ broken',
    ].join('\n');
    expect(parseJsonlOutput(stdout).text).toBe('kept');
  });

  it('strips ANSI and headings out of a model listing', () => {
    const stdout = '[0m\nopencode/big-pickle\nopenai/gpt-4.1\n> some heading here\n\n';
    expect(parseModelListOutput(stdout)).toEqual(['opencode/big-pickle', 'openai/gpt-4.1']);
  });

  it('de-duplicates repeated ids', () => {
    expect(parseModelListOutput('a\na\nb')).toEqual(['a', 'b']);
  });
});

describe('custom command parsing', () => {
  it('tokenizes on unquoted whitespace and honours quotes as grouping', () => {
    expect(parseCustomCommand('my-agent --print')).toEqual({
      ok: true,
      argv: ['my-agent', '--print'],
    });
    expect(parseCustomCommand('my-agent --system "be brief" -x')).toEqual({
      ok: true,
      argv: ['my-agent', '--system', 'be brief', '-x'],
    });
  });

  it('REJECTS shell metacharacters instead of half-executing them', () => {
    // The whole point: a user who expects a shell must be told there isn't
    // one, not handed a command that runs the first half.
    for (const template of [
      'agent && rm -rf /',
      'agent | tee out',
      'agent > out.txt',
      'agent $(whoami)',
      'agent `id`',
      'agent; id',
    ]) {
      expect(parseCustomCommand(template), template).toEqual({
        ok: false,
        problem: 'shell-metacharacters',
      });
    }
  });

  it('allows the {prompt} placeholder through despite its braces', () => {
    expect(parseCustomCommand('agent --ask {prompt}')).toEqual({
      ok: true,
      argv: ['agent', '--ask', '{prompt}'],
    });
  });

  it('reports an empty or unbalanced template', () => {
    expect(parseCustomCommand('   ')).toEqual({ ok: false, problem: 'empty' });
    expect(parseCustomCommand('agent "unclosed')).toEqual({
      ok: false,
      problem: 'unbalanced-quotes',
    });
  });

  it('substitutes the placeholder, and falls back to stdin when there is none', () => {
    expect(applyPromptPlaceholder(['agent', '--ask', '{prompt}'], 'hello')).toEqual({
      argv: ['agent', '--ask', 'hello'],
      viaStdin: false,
    });
    expect(applyPromptPlaceholder(['agent', '--print'], 'hello')).toEqual({
      argv: ['agent', '--print'],
      viaStdin: true,
    });
  });
});

describe('prompt flattening', () => {
  it('folds the system prompt in ahead of the user turn', () => {
    const { text } = flattenPrompt([
      { role: 'system', content: 'You summarize meetings.' },
      { role: 'user', content: [{ type: 'text', text: 'Here is the transcript.' }] },
    ]);
    expect(text).toBe('You summarize meetings.\n\n---\n\nHere is the transcript.');
  });

  it('counts dropped file parts rather than ignoring them silently', () => {
    const { text, droppedFiles } = flattenPrompt([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: new Uint8Array([1]) },
          },
        ],
      },
    ]);
    expect(text).toBe('look');
    expect(droppedFiles).toBe(1);
  });
});

describe('binary resolution', () => {
  it('finds an executable in a search directory and memoizes the miss', async () => {
    const dir = writeStubCli('found-tool', 'echo hi');
    const resolver = makeBinaryResolver({
      processPath: dir,
      staticDirs: [],
      readLoginShellPath: () => Promise.resolve([]),
    });
    expect(await resolver.find('found-tool')).toBe(path.join(dir, 'found-tool'));
    expect(await resolver.find('definitely-not-installed')).toBeNull();
  });

  it('falls back to the login-shell PATH when the process PATH is the truncated GUI one', async () => {
    // This is the packaged-app case: Finder hands Electron /usr/bin:/bin and
    // nothing else, and only the login shell knows where the CLI really is.
    const dir = writeStubCli('shell-only-tool', 'echo hi');
    const resolver = makeBinaryResolver({
      processPath: '/usr/bin:/bin',
      staticDirs: [],
      readLoginShellPath: () => Promise.resolve([dir]),
    });
    expect(await resolver.find('shell-only-tool')).toBe(path.join(dir, 'shell-only-tool'));
  });

  it('asks the login shell at most once no matter how many lookups happen', async () => {
    let calls = 0;
    const resolver = makeBinaryResolver({
      processPath: '',
      staticDirs: [],
      readLoginShellPath: () => {
        calls += 1;
        return Promise.resolve([]);
      },
    });
    await Promise.all([resolver.find('a'), resolver.find('b'), resolver.find('c')]);
    expect(calls).toBe(1);
  });
});

describe('the cli language model end to end', () => {
  const modelFor = (dir: string, modelId: string, cliCommand: string | null = null) => {
    const resolver = makeBinaryResolver({
      processPath: dir,
      staticDirs: [],
      readLoginShellPath: () => Promise.resolve([]),
    });
    return createCliLanguageModel({
      modelId,
      invocation: makeInvocationResolver({ resolver, modelId, cliCommand }),
    });
  };

  const call = {
    prompt: [
      { role: 'system' as const, content: 'SYS' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'TRANSCRIPT' }] },
    ],
  };

  it('sends the prompt on stdin and returns what the CLI printed', async () => {
    // The stub echoes its stdin back, which proves the prompt actually
    // travelled on stdin AND that stdin was closed (`cat` never returns
    // otherwise).
    const dir = writeStubCli('claude', 'cat');
    const result = await modelFor(dir, 'claude/opus').doGenerate(call);
    expect(result.content).toEqual([{ type: 'text', text: 'SYS\n\n---\n\nTRANSCRIPT' }]);
    expect(result.finishReason.unified).toBe('stop');
  });

  it('reads codex answers out of the last-message file, not its noisy stdout', async () => {
    // Mimics codex: a banner on stdout, the real answer written to the path
    // passed after --output-last-message.
    const dir = writeStubCli(
      'codex',
      [
        'echo "OpenAI Codex v0.0.0"',
        'while [ "$1" != "--output-last-message" ]; do shift; done',
        'printf "the real answer" > "$2"',
      ].join('\n')
    );
    const result = await modelFor(dir, 'codex').doGenerate(call);
    expect(result.content).toEqual([{ type: 'text', text: 'the real answer' }]);
  });

  it('runs a custom command and substitutes {prompt} into argv', async () => {
    const dir = writeStubCli('my-agent', 'echo "$2"');
    const result = await modelFor(dir, 'custom', 'my-agent --ask {prompt}').doGenerate(call);
    expect(result.content).toEqual([{ type: 'text', text: 'SYS\n\n---\n\nTRANSCRIPT' }]);
  });

  it('fails with an APICallError the skill runner can fold, not a raw throw', async () => {
    // A raw throw escapes runTerminalTool and takes the whole skill run down;
    // an APICallError becomes a clean PROVIDER_CALL_FAILED envelope.
    const dir = writeStubCli('claude', 'echo "boom" >&2; exit 3');
    await expect(modelFor(dir, 'claude').doGenerate(call)).rejects.toMatchObject({
      name: 'AI_APICallError',
      isRetryable: false,
    });
  });

  it('fails when the CLI is not installed rather than resolving to nothing', async () => {
    const resolver = makeBinaryResolver({
      processPath: '',
      staticDirs: [],
      readLoginShellPath: () => Promise.resolve([]),
    });
    const model = createCliLanguageModel({
      modelId: 'claude',
      invocation: makeInvocationResolver({ resolver, modelId: 'claude', cliCommand: null , cliEffort: null}),
    });
    await expect(model.doGenerate(call)).rejects.toThrow(/not installed/i);
  });

  it('rejects a custom command carrying shell syntax at run time', async () => {
    const dir = writeStubCli('my-agent', 'echo hi');
    await expect(modelFor(dir, 'custom', 'my-agent && rm -rf /').doGenerate(call)).rejects.toThrow(
      /shell-metacharacters/
    );
  });

  it('treats an empty answer as a failure instead of an empty summary', async () => {
    const dir = writeStubCli('claude', 'exit 0');
    await expect(modelFor(dir, 'claude').doGenerate(call)).rejects.toThrow(/no answer/i);
  });

  it('settles promptly on abort instead of waiting for a CLI that ignores SIGTERM', async () => {
    // The stub traps SIGTERM and keeps running: if the runner waited for
    // `close`, this would hang the skill run forever.
    const dir = writeStubCli('claude', 'trap "" TERM\nsleep 30');
    const controller = new AbortController();
    const started = Date.now();
    const pending = modelFor(dir, 'claude').doGenerate({ ...call, abortSignal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('does not pretend to stream', () => {
    const dir = writeStubCli('claude', 'cat');
    expect(() => modelFor(dir, 'claude').doStream(call)).toThrow();
  });
});

describe('the cli catalogue', () => {
  const resolverFor = (dir: string) =>
    makeBinaryResolver({
      processPath: dir,
      staticDirs: [],
      readLoginShellPath: () => Promise.resolve([]),
    });

  it('lists a detected CLI bare first, then its models', async () => {
    const dir = writeStubCli('claude', 'cat');
    const listing = await listCliModels({ resolver: resolverFor(dir), cliCommand: null });
    expect(listing.error).toBeNull();
    expect(listing.models[0]).toBe('claude');
    expect(listing.models).toEqual(expect.arrayContaining(['claude/opus', 'claude/sonnet']));
  });

  it('reports not-configured when nothing is installed and no command is set', async () => {
    const listing = await listCliModels({
      resolver: makeBinaryResolver({
        processPath: '',
        staticDirs: [],
        readLoginShellPath: () => Promise.resolve([]),
      }),
      cliCommand: null,
    });
    expect(listing).toEqual({ models: [], error: 'not-configured' });
  });

  it('offers `custom` once a usable command is set, even with no CLI installed', async () => {
    const listing = await listCliModels({
      resolver: makeBinaryResolver({
        processPath: '',
        staticDirs: [],
        readLoginShellPath: () => Promise.resolve([]),
      }),
      cliCommand: 'my-agent --print',
    });
    expect(listing.models).toEqual(['custom']);
  });

  it('does not offer `custom` for a command that would need a shell', async () => {
    const listing = await listCliModels({
      resolver: makeBinaryResolver({
        processPath: '',
        staticDirs: [],
        readLoginShellPath: () => Promise.resolve([]),
      }),
      cliCommand: 'my-agent | tee log',
    });
    expect(listing).toEqual({ models: [], error: 'not-configured' });
  });
});
