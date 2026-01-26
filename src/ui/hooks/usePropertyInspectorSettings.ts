import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { BrightnessButtonSettings, GlobalSettings } from '../../types/settings';
import type { DialSettings } from '../shared-types';
import { dispatchMonitorList, onStreamDeckMessage, requestMonitors } from '../streamdeck';

interface UsePropertyInspectorSettingsReturn<TSettings> {
  settings: TSettings;
  updateSettings(updates: Partial<TSettings>): void;
  globalSettings: GlobalSettings;
  updateGlobalSetting(key: keyof GlobalSettings, value: number): void;
  isReady: boolean;
}

type PropertyInspectorSettings = BrightnessButtonSettings | DialSettings;

export function usePropertyInspectorSettings<TSettings extends PropertyInspectorSettings>(
  initialSettings: TSettings,
  initialGlobalSettings: GlobalSettings
): UsePropertyInspectorSettingsReturn<TSettings> {
  const [settings, setSettings] = useState<TSettings>(initialSettings);
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(initialGlobalSettings);
  const [isReady, setIsReady] = useState(false);
  const hasReceivedSettingsRef = useRef(false);
  const monitorPollIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    const pollMonitors = () => {
      if (!hasReceivedSettingsRef.current) {
        requestMonitors();
      }
    };

    // Ensure we don't miss the settings events if they arrived before listeners mounted.
    window.streamDeck?.getSettings?.();
    window.streamDeck?.getGlobalSettings?.();

    pollMonitors();
    monitorPollIntervalRef.current = window.setInterval(pollMonitors, 1000);

    return () => {
      if (monitorPollIntervalRef.current !== null) {
        window.clearInterval(monitorPollIntervalRef.current);
        monitorPollIntervalRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return onStreamDeckMessage((msg) => {
      if (msg.event === 'didReceiveSettings') {
        const incomingSettings = msg.payload?.settings as Partial<TSettings> | undefined;
        if (incomingSettings) {
          setSettings((prev) => ({ ...prev, ...incomingSettings }));
        }
        hasReceivedSettingsRef.current = true;
        setIsReady(true);
        if (monitorPollIntervalRef.current !== null) {
          window.clearInterval(monitorPollIntervalRef.current);
          monitorPollIntervalRef.current = null;
        }
        requestMonitors();
        return;
      }

      if (msg.event === 'didReceiveGlobalSettings') {
        const incomingSettings = msg.payload?.settings as GlobalSettings | undefined;
        if (!incomingSettings) {
          return;
        }

        setGlobalSettings((prev) => ({ ...prev, ...incomingSettings }));
        return;
      }

      if (msg.event === 'sendToPropertyInspector' && msg.payload?.event === 'monitorList') {
        dispatchMonitorList(msg.payload);
      }
    });
  }, []);

  const updateSettings = useCallback((updates: Partial<TSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...updates } as TSettings;
      window.streamDeck?.setSettings(next);
      return next;
    });
  }, []);

  const updateGlobalSetting = useCallback((key: keyof GlobalSettings, value: number) => {
    setGlobalSettings((prev) => {
      const next = { ...prev, [key]: value };
      window.streamDeck?.setGlobalSettings(next);
      return next;
    });
  }, []);

  return {
    settings,
    updateSettings,
    globalSettings,
    updateGlobalSetting,
    isReady,
  };
}
