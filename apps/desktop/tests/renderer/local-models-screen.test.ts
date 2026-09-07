// @vitest-environment jsdom
/**
 * The local-models screen's two new jobs: it lists BOTH model families in their
 * own sections (a Parakeet bundle arrives from main as one row, so the screen
 * needs no knowledge of its four files), and it offers reuse of a copy already
 * on the device before making the user download 660 MB.
 *
 * The import affordance is a two-step on purpose: scan first, offer the folder
 * picker only once the scan came back empty. That is the behaviour pinned here,
 * along with the delete confirmation telling the truth about a linked model.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DEVICE_SETTINGS,
  type LocalModel,
  type LocalModelsState,
} from '@prismical/app-contracts';
import { LocalModelsScreen } from '../../src/renderer/main/app/settings/local-models-screen';

const model = (over: Partial<LocalModel> & Pick<LocalModel, 'id' | 'kind'>): LocalModel => ({
  name: over.id,
  filename: `${over.id}.bin`,
  sizeBytes: 1024,
  recommended: false,
  installed: false,
  installedAt: null,
  download: null,
  linked: false,
  ...over,
});

const STATE: LocalModelsState = {
  modelsDir: '/fake/models',
  models: [
    model({ id: 'whisper-base-en', kind: 'whisper', recommended: true, installed: true }),
    model({ id: 'parakeet-tdt-0.6b-v3', kind: 'parakeet', recommended: true }),
  ],
};

const harness = vi.hoisted(() => {
  const importModel = vi.fn();
  const download = vi.fn();
  const deleteModel = vi.fn();
  return {
    importModel,
    download,
    deleteModel,
    set: vi.fn(),
    state: { value: null as LocalModelsState | null },
    caps: {
      has: () => true,
      localModels: {
        import: importModel,
        download,
        delete: deleteModel,
        cancelDownload: vi.fn(),
        getState: vi.fn(),
        subscribe: (listener: (state: LocalModelsState) => void) => {
          if (harness.state.value !== null) listener(harness.state.value);
          return () => undefined;
        },
      },
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@prismical/app-client', () => ({
  useDesktopCapabilities: () => harness.caps,
  useDeviceSettings: () => ({ settings: DEFAULT_DEVICE_SETTINGS, set: harness.set }),
}));
vi.mock('@prismical/app-i18n', () => ({
  useApplicationLocale: () => ({ resolvedLocale: 'en' }),
  formatApplicationBytes: (bytes: number) => `${bytes} B`,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  harness.state.value = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const render = async (state: LocalModelsState = STATE): Promise<HTMLDivElement> => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.state.value = state;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(LocalModelsScreen)));
  return container;
};

const rowFor = (view: HTMLDivElement, id: string): HTMLElement => {
  const row = view.querySelector<HTMLElement>(`[data-model-id="${id}"]`);
  expect(row, `row for ${id}`).not.toBeNull();
  return row!;
};

const click = async (element: Element): Promise<void> => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

describe('the local models screen', () => {
  it('lists both families, each in its own section', async () => {
    const view = await render();
    const groups = [...view.querySelectorAll('[data-group]')].map(list =>
      list.getAttribute('data-group')
    );
    expect(groups).toEqual(['whisper', 'parakeet']);
    // A bundle reaches the screen as ONE row — its four parts never do.
    expect(view.querySelectorAll('[data-model-id]')).toHaveLength(2);
    expect(rowFor(view, 'parakeet-tdt-0.6b-v3')).not.toBeNull();
  });

  it('offers reuse before download, and scans without a folder picker first', async () => {
    harness.importModel.mockResolvedValue({
      outcome: 'imported',
      imported: 4,
      total: 4,
      sourceDir: '/elsewhere',
    });
    const view = await render();
    const row = rowFor(view, 'parakeet-tdt-0.6b-v3');
    const button = row.querySelector('[data-testid="local-model-import"]')!;
    expect(button.textContent).toBe('desktop.localModels.importScan');

    await click(button);
    // `browse: false` — the automatic scan. Nothing was downloaded.
    expect(harness.importModel).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3', false);
    expect(harness.download).not.toHaveBeenCalled();
    expect(
      rowFor(view, 'parakeet-tdt-0.6b-v3').querySelector(
        '[data-testid="local-model-import-status"]'
      )?.textContent
    ).toBe('desktop.localModels.importDone');
  });

  it.each([['not-found'], ['partial']])(
    'offers the folder picker after a scan comes back %s',
    async outcome => {
      harness.importModel.mockResolvedValue({
        outcome,
        imported: outcome === 'partial' ? 1 : 0,
        total: 4,
        sourceDir: outcome === 'partial' ? '/elsewhere' : null,
      });
      const view = await render();
      const row = rowFor(view, 'parakeet-tdt-0.6b-v3');
      await click(row.querySelector('[data-testid="local-model-import"]')!);

      const after = rowFor(view, 'parakeet-tdt-0.6b-v3').querySelector(
        '[data-testid="local-model-import"]'
      )!;
      expect(after.textContent).toBe('desktop.localModels.importBrowse');
      await click(after);
      // The SECOND press is the one that opens the picker in main.
      expect(harness.importModel).toHaveBeenLastCalledWith('parakeet-tdt-0.6b-v3', true);
    }
  );


  it('says a linked model is linked, and warns that deleting keeps the original', async () => {
    const view = await render({
      ...STATE,
      models: [
        model({
          id: 'parakeet-tdt-0.6b-v3',
          kind: 'parakeet',
          installed: true,
          linked: true,
          installedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    });
    const row = rowFor(view, 'parakeet-tdt-0.6b-v3');
    expect(row.querySelector('[data-testid="local-model-linked"]')).not.toBeNull();

    await click(row.querySelector('button.text-destructive')!);
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('desktop.localModels.deleteConfirmLinked');
    expect(dialog?.textContent).not.toContain('desktop.localModels.deleteConfirm"');
  });

  it('shows no import affordance once a model is installed', async () => {
    const view = await render();
    const row = rowFor(view, 'whisper-base-en');
    expect(row.querySelector('[data-testid="local-model-import"]')).toBeNull();
  });
});
