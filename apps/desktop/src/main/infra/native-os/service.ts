import { Context, type Effect, type Option } from 'effect';

/**
 * The thin electron edge for native OS side-effects the settings + diagnostics
 * surfaces drive. One injectable boundary — the Live
 * layer touches `app` / `app.dock` / `shell` / electron-log, unit tests provide
 * a fake that records the calls — so the OS-sync consumer and capability IPC
 * handlers stay headless-testable and the domains that
 * use them (SettingsService et al.) stay electron-free.
 *
 * The implementation uses these exact Electron calls:
 * `setLoginItemSettings({ openAtLogin, openAsHidden: false })` and the darwin
 * `app.dock` show/hide (a no-op off macOS where `app.dock` is undefined).
 */
export interface NativeOsApi {
  /** `app.setLoginItemSettings({ openAtLogin, openAsHidden: false })`. */
  readonly setLoginItem: (openAtLogin: boolean) => Effect.Effect<void>;
  /** `app.dock` show/hide — macOS only; a true no-op elsewhere. */
  readonly setDockVisible: (visible: boolean) => Effect.Effect<void>;
  /** `shell.openExternal(url)` — the System Settings deep-link lane. */
  readonly openExternal: (url: string) => Effect.Effect<void>;
  /** `shell.showItemInFolder(<electron-log file>)` — reveal the log. */
  readonly revealLogs: Effect.Effect<void>;
  /**
   * Open a directory in the OS file browser, creating it first so revealing an
   * empty audio folder shows a folder rather than nothing.
   *
   * The path is MAIN's to supply — the one caller passes AppConfig.audioDir.
   * The IPC handler in front of this takes no argument at all, for the same
   * reason `chooseDirectory` lives here: a path that main acts on must never
   * arrive on a renderer's word.
   */
  readonly revealDirectory: (dir: string) => Effect.Effect<void>;
  /** Request a relaunch (through the launcher in dev), then quit gracefully. */
  readonly relaunch: Effect.Effect<void>;
  /**
   * `dialog.showOpenDialog({ properties: ['openDirectory'] })` — one folder, or
   * None when the user dismissed it. The picker lives HERE, not in the renderer:
   * the path it returns is used to read the user's disk, and main must never
   * take such a path on a renderer's word.
   */
  readonly chooseDirectory: (title: string) => Effect.Effect<Option.Option<string>>;
}

export class NativeOs extends Context.Tag('desktop/NativeOs')<NativeOs, NativeOsApi>() {}
