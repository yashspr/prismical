/**
 * The local models settings screen is desktop-owned: the
 * on-device model manager reaches the shared shell only through the
 * 'local-models' capability (nav entry + route), never as an app-mode branch
 * inside app-ui. Built from app-ui primitives over
 * DesktopCapabilityPort.localModels (window.desktop.models in the adapter).
 *
 * Per row, local model states are: not installed → Download (or reuse a copy
 * already on the device, see below); downloading → progress + Cancel;
 * verifying/cancelling → status; error → message + Retry + Dismiss (cancel
 * clears an error entry); installed → Delete behind a confirm. The ACTIVE model
 * is a device preference (DeviceSettings.transcription.modelId; null = the
 * recommended entry) and is only selectable among installed models.
 *
 * Two families are listed, in their own sections, because they are different
 * trade-offs rather than a longer list of the same thing: Whisper (one ggml
 * file) and Parakeet (a four-file bundle main folds into one row — see
 * bundles.ts, the screen never sees the parts).
 *
 * IMPORT is the other way to install: main can find weights that already exist
 * elsewhere on this device and LINK them, so a model shared with another app
 * costs no download and no second copy. The scan matches on the pinned SHA-1,
 * so a `not-found` genuinely means "nothing here is these bytes" — the folder
 * picker is offered next, for a copy in a place the app does not know about.
 */
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LocalModel,
  LocalModelDownload,
  LocalModelDownloadError,
  LocalModelImportResult,
  LocalModelKind,
  LocalModelsState,
} from '@prismical/app-contracts';
import { useDesktopCapabilities, useDeviceSettings } from '@prismical/app-client';
import {
  formatApplicationBytes,
  useApplicationLocale,
  type SupportedLocale,
} from '@prismical/app-i18n';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@prismical/app-ui/ui/alert-dialog';
import { Badge } from '@prismical/app-ui/ui/badge';
import { Button } from '@prismical/app-ui/ui/button';
import { Card, CardContent } from '@prismical/app-ui/ui/card';

// The wire error set → catalog keys (hyphenated ids are not catalog keys).
const ERROR_KEYS = {
  network: 'network',
  'checksum-mismatch': 'checksumMismatch',
  'insufficient-space': 'insufficientSpace',
  io: 'io',
} as const satisfies Record<LocalModelDownloadError, string>;

/**
 * The families the screen offers, in order. The `vad` kind is deliberately
 * absent: those weights are managed beside the first whisper download, not
 * chosen by the user.
 */
const GROUPS = [
  { kind: 'whisper', titleKey: 'groupWhisper', hintKey: 'groupWhisperHint' },
  { kind: 'parakeet', titleKey: 'groupParakeet', hintKey: 'groupParakeetHint' },
] as const satisfies ReadonlyArray<{
  kind: LocalModelKind;
  titleKey: string;
  hintKey: string;
}>;

/** Per-row import progress. `scanning` disables the buttons; the result is the message. */
type ImportState = { readonly scanning: boolean; readonly result: LocalModelImportResult | null };

const IDLE_IMPORT: ImportState = { scanning: false, result: null };

/** The live model-manager snapshot; null until the first snapshot lands. */
function useLocalModels(): LocalModelsState | null {
  const caps = useDesktopCapabilities();
  const [state, setState] = React.useState<LocalModelsState | null>(null);
  React.useEffect(() => caps.localModels.subscribe(setState), [caps]);
  return state;
}

function DownloadStatus({
  download,
  locale,
}: {
  download: LocalModelDownload;
  locale: SupportedLocale;
}) {
  const { t } = useTranslation();
  switch (download.status) {
    case 'downloading': {
      const percent =
        download.totalBytes > 0
          ? Math.min(100, Math.floor((download.bytesDownloaded / download.totalBytes) * 100))
          : 0;
      return (
        <div className="space-y-1" data-testid="local-model-progress">
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full bg-primary" style={{ width: `${percent}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {t('desktop.localModels.downloading', {
              downloaded: formatApplicationBytes(download.bytesDownloaded, locale),
              total: formatApplicationBytes(download.totalBytes, locale),
              percent,
            })}
          </p>
        </div>
      );
    }
    case 'verifying':
      return <p className="text-xs text-muted-foreground">{t('desktop.localModels.verifying')}</p>;
    case 'cancelling':
      return <p className="text-xs text-muted-foreground">{t('desktop.localModels.cancelling')}</p>;
    case 'error':
      return (
        <p className="text-xs text-destructive" data-testid="local-model-error">
          {t(`desktop.localModels.errors.${ERROR_KEYS[download.error ?? 'io']}`)}
        </p>
      );
  }
}

/**
 * What the last import attempt found. `not-found` is the one outcome that is
 * not an end state: it is the prompt to point at the folder ourselves, so it
 * renders beside that button rather than as a failure.
 */
function ImportStatus({ state }: { state: ImportState }) {
  const { t } = useTranslation();
  if (state.scanning) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="local-model-import-status">
        {t('desktop.localModels.importSearching')}
      </p>
    );
  }
  const result = state.result;
  if (result === null || result.outcome === 'cancelled') return null;
  const message =
    result.outcome === 'imported'
      ? t('desktop.localModels.importDone', {
          linked: result.imported,
          total: result.total,
          path: result.sourceDir ?? '',
        })
      : result.outcome === 'partial'
        ? t('desktop.localModels.importPartial', {
            linked: result.imported,
            total: result.total,
            path: result.sourceDir ?? '',
          })
        : result.outcome === 'not-found'
          ? t('desktop.localModels.importNotFound')
          : result.outcome === 'already-installed'
            ? t('desktop.localModels.importAlready')
            : t('desktop.localModels.importFailed');
  const bad = result.outcome === 'io' || result.outcome === 'unknown-model';
  return (
    <p
      className={bad ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
      data-testid="local-model-import-status"
    >
      {message}
    </p>
  );
}

function ModelRow({
  model,
  active,
  locale,
  onUse,
  onDelete,
}: {
  model: LocalModel;
  active: boolean;
  locale: SupportedLocale;
  onUse: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const download = model.download;
  const [importState, setImportState] = React.useState<ImportState>(IDLE_IMPORT);

  // One in-flight import per row. `browse` false scans the directories main
  // knows about; true opens the folder picker (in main — the renderer never
  // names a path).
  const runImport = (browse: boolean): void => {
    setImportState({ scanning: true, result: null });
    void caps.localModels.import(model.id, browse).then(
      result => setImportState({ scanning: false, result }),
      () => setImportState({ scanning: false, result: null })
    );
  };

  const idle = download === null && !model.installed;
  // The picker is offered only once an automatic scan has fallen short —
  // showing both from the start makes the cheap option look like the same
  // amount of work as the expensive one. `partial` counts as falling short:
  // the parts that did not turn up may well be in a folder we do not know.
  const outcome = importState.result?.outcome;
  const offerBrowse = idle && (outcome === 'not-found' || outcome === 'partial');


  const actions =
    download?.status === 'downloading' ? (
      <Button
        variant="outline"
        size="sm"
        onClick={() => void caps.localModels.cancelDownload(model.id)}
      >
        {t('desktop.localModels.cancel')}
      </Button>
    ) : download?.status === 'verifying' || download?.status === 'cancelling' ? (
      <Button variant="outline" size="sm" disabled>
        {t('desktop.localModels.cancel')}
      </Button>
    ) : download?.status === 'error' ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void caps.localModels.cancelDownload(model.id)}
        >
          {t('desktop.localModels.dismiss')}
        </Button>
        <Button size="sm" onClick={() => void caps.localModels.download(model.id)}>
          {t('desktop.localModels.retry')}
        </Button>
      </>
    ) : model.installed ? (
      <>
        {active ? null : (
          <Button variant="outline" size="sm" onClick={onUse}>
            {t('desktop.localModels.useModel')}
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm" className="text-destructive">
              {t('desktop.localModels.delete')}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('desktop.localModels.deleteConfirmTitle', { name: model.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {model.linked
                  ? t('desktop.localModels.deleteConfirmLinked')
                  : t('desktop.localModels.deleteConfirm')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('desktop.localModels.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                onClick={onDelete}
              >
                {t('desktop.localModels.delete')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </>
    ) : (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={importState.scanning}
          data-testid="local-model-import"
          onClick={() => runImport(offerBrowse)}
        >
          {offerBrowse
            ? t('desktop.localModels.importBrowse')
            : t('desktop.localModels.importScan')}
        </Button>
        <Button
          size="sm"
          disabled={importState.scanning}
          onClick={() => void caps.localModels.download(model.id)}
        >
          {t('desktop.localModels.download')}
        </Button>
      </>
    );

  return (
    <li
      className="flex items-center justify-between gap-4 py-3"
      data-testid="local-model-row"
      data-model-id={model.id}
      data-installed={model.installed}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{model.name}</span>
          {model.recommended ? (
            <Badge variant="secondary" data-testid="local-model-recommended">
              {t('desktop.localModels.recommended')}
            </Badge>
          ) : null}
          {model.installed ? (
            <Badge variant="outline">{t('desktop.localModels.installed')}</Badge>
          ) : null}
          {model.installed && model.linked ? (
            <Badge variant="outline" data-testid="local-model-linked">
              {t('desktop.localModels.linked')}
            </Badge>
          ) : null}
          {active && model.installed ? (
            <Badge data-testid="local-model-active">{t('desktop.localModels.active')}</Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {formatApplicationBytes(model.sizeBytes, locale)}
        </p>
        {download ? <DownloadStatus download={download} locale={locale} /> : null}
        {download ? null : <ImportStatus state={importState} />}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </li>
  );
}

export function LocalModelsScreen() {
  const { t } = useTranslation();
  const { resolvedLocale } = useApplicationLocale();
  const caps = useDesktopCapabilities();
  const state = useLocalModels();
  const { settings, set } = useDeviceSettings();
  const transcription = settings.transcription;

  const models = state?.models ?? [];
  // The EFFECTIVE active id mirrors main's resolution (modelId ?? the
  // recommended WHISPER entry — main's RECOMMENDED_MODEL_ID is a whisper id, so
  // the fallback must be looked up in that family even though Parakeet marks a
  // recommendation of its own). The Active badge renders only when that model
  // is actually INSTALLED (a badge on missing weights would be a lie).
  const activeId =
    transcription.modelId ??
    models.find(model => model.kind === 'whisper' && model.recommended)?.id ??
    null;

  // A patch replaces the whole record — always spread the current one.
  const setActiveModel = (modelId: string | null): void => {
    void set({ transcription: { ...transcription, modelId } });
  };
  const deleteModel = (model: LocalModel): void => {
    void caps.localModels.delete(model.id);
    // Never leave the EFFECTIVE choice pointing at deleted weights: this row
    // can be active through the explicit preference OR as the null-default
    // recommended fallback. Move the preference to another installed model when
    // one exists, else back to null.
    if (model.id === activeId) {
      const fallback =
        models.find(
          candidate => candidate.installed && candidate.id !== model.id && candidate.kind !== 'vad'
        )?.id ?? null;
      if (fallback !== transcription.modelId) setActiveModel(fallback);
    }
  };

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-xl font-bold">{t('desktop.localModels.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('desktop.localModels.description')}</p>
      </div>

      <Card>
        <CardContent>
          {state === null ? (
            <p className="text-sm text-muted-foreground">{t('desktop.localModels.loading')}</p>
          ) : (
            <>
              <p className="break-all text-xs text-muted-foreground" data-testid="local-models-dir">
                {t('desktop.localModels.storageLocation', { path: state.modelsDir })}
              </p>
              {GROUPS.map(group => {
                const rows = models.filter(model => model.kind === group.kind);
                if (rows.length === 0) return null;
                return (
                  <section key={group.kind} className="mt-6 first:mt-4">
                    <h2 className="text-sm font-semibold text-foreground">
                      {t(`desktop.localModels.${group.titleKey}`)}
                    </h2>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t(`desktop.localModels.${group.hintKey}`)}
                    </p>
                    <ul
                      className="mt-1 divide-y divide-border"
                      data-testid="local-models-list"
                      data-group={group.kind}
                    >
                      {rows.map(model => (
                        <ModelRow
                          key={model.id}
                          model={model}
                          active={model.id === activeId}
                          locale={resolvedLocale}
                          onUse={() => setActiveModel(model.id)}
                          onDelete={() => deleteModel(model)}
                        />
                      ))}
                    </ul>
                  </section>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
