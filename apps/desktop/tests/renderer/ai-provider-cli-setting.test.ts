// @vitest-environment jsdom
/**
 * The `cli` branch of the AI-provider card: the CLI provider is offered, it
 * asks for no API key, and the command template it does ask for is committed
 * to device settings without disturbing the rest of the record.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEVICE_SETTINGS } from '@prismical/app-contracts';
import { AiProviderSetting } from '../../src/renderer/main/app/settings/ai-provider-setting';

const harness = vi.hoisted(() => {
  const listModels = vi.fn();
  const hasKey = vi.fn();
  return {
    set: vi.fn(),
    listModels,
    hasKey,
    provider: { value: 'cli' as string },
    cliCommand: { value: null as string | null },
    caps: {
      has: () => true,
      aiProvider: { listModels, hasKey, setKey: vi.fn(), clearKey: vi.fn() },
    },
  };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => harness.caps,
  useDeviceSettings: () => ({
    settings: {
      ...DEFAULT_DEVICE_SETTINGS,
      ai: {
        provider: harness.provider.value,
        model: 'claude/opus',
        baseUrl: null,
        cliCommand: harness.cliCommand.value,
      },
    },
    set: harness.set,
  }),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  harness.provider.value = 'cli';
  harness.cliCommand.value = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const changeInput = (input: HTMLInputElement, value: string): void => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
};

const render = async (): Promise<HTMLDivElement> => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.hasKey.mockResolvedValue(false);
  harness.listModels.mockResolvedValue({ models: ['claude', 'claude/opus'], error: null });
  harness.set.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(AiProviderSetting)));
  return container;
};

describe('the cli provider in the AI-provider card', () => {
  it('offers the CLI provider as a choice', async () => {
    const view = await render();
    expect(view.querySelector('#ai-provider-cli')).not.toBeNull();
  });

  it('asks for a command template and NOT for an API key', async () => {
    const view = await render();
    // A CLI is already signed in on this machine — prompting for a key would
    // be asking for the credential the provider exists to avoid.
    expect(view.querySelector('#ai-provider-api-key')).toBeNull();
    expect(view.querySelector('#ai-provider-base-url')).toBeNull();
    expect(view.querySelector('#ai-provider-cli-command')).not.toBeNull();
  });

  it('commits the template on blur, carrying the rest of the record with it', async () => {
    const view = await render();
    const input = view.querySelector<HTMLInputElement>('#ai-provider-cli-command')!;
    await act(async () => {
      input.focus();
      changeInput(input, '  my-agent --print  ');
    });
    await act(async () => input.blur());
    // The `ai` setting is ONE record: a patch that dropped model would reset
    // the user's model pick as a side effect of typing a command.
    expect(harness.set).toHaveBeenCalledWith({
      ai: {
        provider: 'cli',
        model: 'claude/opus',
        baseUrl: null,
        cliCommand: 'my-agent --print',
      },
    });
  });

  it('clears the template back to null when emptied', async () => {
    harness.cliCommand.value = 'my-agent --print';
    const view = await render();
    const input = view.querySelector<HTMLInputElement>('#ai-provider-cli-command')!;
    await act(async () => {
      input.focus();
      changeInput(input, '   ');
    });
    await act(async () => input.blur());
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({ ai: expect.objectContaining({ cliCommand: null }) })
    );
  });

  it('hides the command field for every other provider', async () => {
    harness.provider.value = 'openai';
    const view = await render();
    expect(view.querySelector('#ai-provider-cli-command')).toBeNull();
    expect(view.querySelector('#ai-provider-api-key')).not.toBeNull();
  });
});
