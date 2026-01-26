import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import { AdvancedSettings, CreatorHeader, MonitorSelector } from './components';
import type { GlobalSettings } from '../types/settings';
import type { DialSettings } from './shared-types';
import { usePropertyInspectorSettings } from './hooks/usePropertyInspectorSettings';
import { openUrl, registerPropertyInspector } from './streamdeck';

const DEFAULT_SETTINGS: DialSettings = {
  selectedMonitors: [],
  stepSize: 5,
};

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {};

registerPropertyInspector();

function BrightnessDialPI() {
  const { settings, updateSettings, globalSettings, updateGlobalSetting, isReady } =
    usePropertyInspectorSettings(DEFAULT_SETTINGS, DEFAULT_GLOBAL_SETTINGS);

  if (!isReady) {
    return h(
      'div',
      { className: 'pi-container' },
      h('div', { className: 'pi-loading' }, 'Loading...')
    );
  }

  const resolvedSettings = { ...DEFAULT_SETTINGS, ...settings };

  const handleMonitorChange = useCallback(
    (monitors: string[]) => {
      updateSettings({ selectedMonitors: monitors });
    },
    [updateSettings]
  );

  const handleStepSizeChange = useCallback(
    (value: number) => {
      updateSettings({ stepSize: value });
    },
    [updateSettings]
  );

  return h(
    'div',
    { className: 'pi-container' },
    h(CreatorHeader, { onOpenUrl: openUrl }),
    h(
      'div',
      { className: 'sdpi-item' },
      h('div', { className: 'sdpi-item-label' }, 'Displays'),
      h(MonitorSelector, {
        selectedMonitors: resolvedSettings.selectedMonitors,
        onMonitorsChange: handleMonitorChange,
      })
    ),
    h(
      'div',
      { className: 'sdpi-item' },
      h('div', { className: 'sdpi-item-label' }, 'Step Size'),
      h(
        'div',
        { className: 'sdpi-item-group' },
        h('input', {
          type: 'range',
          className: 'sdpi-item-value',
          min: 1,
          max: 20,
          value: resolvedSettings.stepSize,
          onInput: (e: Event) => {
            const target = e.target as HTMLInputElement;
            handleStepSizeChange(parseInt(target.value, 10));
          },
        }),
        h('span', { className: 'sdpi-item-value' }, resolvedSettings.stepSize)
      ),
      h(
        'div',
        { className: 'sdpi-info' },
        'Step size determines how much of brightness changes per dial tick.'
      )
    ),
    h(AdvancedSettings, {
      settings: globalSettings,
      onSettingChange: updateGlobalSetting,
    })
  );
}

const container = document.getElementById('pi-container');
if (container) {
  import('preact').then(({ render }) => {
    render(h(BrightnessDialPI, null), container);
  });
}

export {};
