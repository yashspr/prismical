/**
 * A fake NativeOs edge that records every OS side effect
 * instead of touching electron, so the os-sync consumer + the capability handlers
 * are headless-testable. Electron-free.
 */
import { Effect, Layer, Option } from 'effect';

import { NativeOs, type NativeOsApi } from '../../src/main/infra/native-os/service';

export interface FakeNativeOsCalls {
  readonly loginItem: boolean[];
  readonly dock: boolean[];
  readonly openExternal: string[];
  /** Titles the folder picker was opened with. */
  readonly chooseDirectory: string[];
  reveal: number;
  /** Directories handed to revealDirectory, in order. */
  revealDirectory: string[];
  relaunch: number;
  /** What the next `chooseDirectory` answers; null is "the user cancelled". */
  nextDirectory: string | null;
}

export interface FakeNativeOs {
  readonly layer: Layer.Layer<NativeOs>;
  readonly calls: FakeNativeOsCalls;
}

export const makeFakeNativeOs = (): FakeNativeOs => {
  const calls: FakeNativeOsCalls = {
    loginItem: [],
    dock: [],
    openExternal: [],
    chooseDirectory: [],
    reveal: 0,
    revealDirectory: [],
    relaunch: 0,
    nextDirectory: null,
  };

  const service: NativeOsApi = {
    setLoginItem: openAtLogin =>
      Effect.sync(() => {
        calls.loginItem.push(openAtLogin);
      }),
    setDockVisible: visible =>
      Effect.sync(() => {
        calls.dock.push(visible);
      }),
    openExternal: url =>
      Effect.sync(() => {
        calls.openExternal.push(url);
      }),
    revealDirectory: dir =>
      Effect.sync(() => {
        calls.revealDirectory.push(dir);
      }),
    revealLogs: Effect.sync(() => {
      calls.reveal += 1;
    }),
    relaunch: Effect.sync(() => {
      calls.relaunch += 1;
    }),
    chooseDirectory: title =>
      Effect.sync(() => {
        calls.chooseDirectory.push(title);
        return Option.fromNullable(calls.nextDirectory);
      }),
  };

  return { layer: Layer.succeed(NativeOs, service), calls };
};
