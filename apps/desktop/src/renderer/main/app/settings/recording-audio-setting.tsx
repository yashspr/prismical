/**
 * The kept-audio card is desktop-owned, and rides the same
 * `engineSettings` slot as the transcription-engine card (the shared screen
 * renders whatever the desktop router hands it; web passes nothing).
 *
 * Why this exists at all: the WAV pair is written during EVERY recording as the
 * recovery drain's crash insurance, and until now it was deleted the instant
 * the transcript became durable — so a finished meeting left text and no audio,
 * with nothing in the interface to say so. The preference decides cleanup, not
 * capture, which is why turning it on cannot recover a meeting recorded while
 * it was off.
 *
 * `keepAudio` rides DeviceSettings like every other device preference; the
 * folder button goes through the capability port, which takes NO path — main
 * opens the one directory it owns.
 */
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen } from 'lucide-react';
import { useDesktopCapabilities, useDeviceSettings } from '@prismical/app-client';
import { Button } from '@prismical/app-ui/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@prismical/app-ui/ui/card';
import { Label } from '@prismical/app-ui/ui/label';
import { Switch } from '@prismical/app-ui/ui/switch';

export function RecordingAudioSetting() {
  const { t } = useTranslation();
  const caps = useDesktopCapabilities();
  const { settings, set } = useDeviceSettings();

  // Same gate as the engine card beside it: this is a recording preference, so
  // it belongs wherever on-device transcription does.
  if (!caps.has('transcription-engine')) return null;

  return (
    <Card data-testid="recording-audio" className="mt-6">
      <CardHeader>
        <CardTitle>{t('desktop.recordingAudio.title')}</CardTitle>
        <CardDescription>{t('desktop.recordingAudio.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="recording-keep-audio" className="text-sm font-medium text-foreground">
              {t('desktop.recordingAudio.keepLabel')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('desktop.recordingAudio.keepDescription')}
            </p>
          </div>
          <Switch
            id="recording-keep-audio"
            checked={settings.keepAudio}
            onCheckedChange={checked => void set({ keepAudio: checked })}
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void caps.revealAudio()}
          data-testid="recording-audio-reveal"
        >
          <FolderOpen className="size-4" />
          {t('desktop.recordingAudio.reveal')}
        </Button>
      </CardContent>
    </Card>
  );
}
