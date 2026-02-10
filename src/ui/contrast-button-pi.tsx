import { h } from 'preact';
import { useCallback } from 'preact/hooks';
import { AdvancedSettings, CreatorHeader, MonitorSelector } from './components';
import {
  DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS,
  DEFAULT_DDC_WRITE_THROTTLE_MS,
  DEFAULT_ENFORCEMENT_DURATION_MS,
  DEFAULT_ENFORCEMENT_INTERVAL_MS,
} from '../globals';
import type { BrightnessButtonSettings, GlobalSettings } from '../types/settings';
import { usePropertyInspectorSettings } from './hooks/usePropertyInspectorSettings';
import { openUrl, registerPropertyInspector } from './streamdeck';

const DEFAULT_SETTINGS: Required<BrightnessButtonSettings> = {
  selectedMonitors: [],
  operationMode: 'cycle',
  stepSize: 10,
  setValue: 100,
  toggleValue1: 0,
  toggleValue2: 100,
  cycleValues: [0, 25, 50, 75, 100],
};

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  ddcWriteThrottleMs: DEFAULT_DDC_WRITE_THROTTLE_MS,
  enforcementDurationMs: DEFAULT_ENFORCEMENT_DURATION_MS,
  enforcementIntervalMs: DEFAULT_ENFORCEMENT_INTERVAL_MS,
  pollIntervalMs: DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS,
};

const OPERATION_MODE_OPTIONS = [
  { value: 'increase', label: 'Increase Contrast' },
  { value: 'decrease', label: 'Decrease Contrast' },
  { value: 'set', label: 'Set to Value' },
  { value: 'toggle', label: 'Toggle Between Two Values' },
  { value: 'cycle', label: 'Cycle Through Values' },
] as const;

registerPropertyInspector();

function ContrastButtonPI() {
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

  const handleOperationModeChange = useCallback(
    (mode: BrightnessButtonSettings['operationMode']) => {
      updateSettings({ operationMode: mode });
    },
    [updateSettings]
  );

  const handleStepSizeChange = useCallback(
    (value: number) => {
      updateSettings({ stepSize: value });
    },
    [updateSettings]
  );

  const handleSetValueChange = useCallback(
    (value: number) => {
      updateSettings({ setValue: value });
    },
    [updateSettings]
  );

  const handleToggleValue1Change = useCallback(
    (value: number) => {
      updateSettings({ toggleValue1: value });
    },
    [updateSettings]
  );

  const handleToggleValue2Change = useCallback(
    (value: number) => {
      updateSettings({ toggleValue2: value });
    },
    [updateSettings]
  );

  const renderRangeControl = (
    value: number,
    onInput: (event: Event) => void,
    options: { min?: number; max?: number; step?: number } = {}
  ) =>
    h(
      'div',
      { className: 'sdpi-item-value' },
      h('input', {
        type: 'range',
        min: options.min ?? 0,
        max: options.max ?? 100,
        step: options.step ?? 1,
        value,
        onInput,
      }),
      h('span', { className: 'sdpi-item-value' }, `${value}%`)
    );

  const renderRangeSetting = (
    label: string,
    value: number,
    onInput: (event: Event) => void,
    options: { id?: string; className?: string; min?: number; max?: number; step?: number } = {}
  ) =>
    h(
      'div',
      { id: options.id, className: options.className ?? 'sdpi-item' },
      h('div', { className: 'sdpi-item-label' }, label),
      renderRangeControl(value, onInput, options)
    );

  const renderModeSettings = () => {
    switch (resolvedSettings.operationMode) {
      case 'set':
        return renderRangeSetting(
          'Target Contrast',
          resolvedSettings.setValue,
          (e: Event) => {
            const target = e.target as HTMLInputElement;
            handleSetValueChange(parseInt(target.value, 10));
          },
          { id: 'set-value-container', className: 'sdpi-item mode-setting' }
        );
      case 'toggle':
        return h(
          'div',
          { id: 'toggle-settings-container', className: 'mode-setting' },
          renderRangeSetting('Value 1', resolvedSettings.toggleValue1, (e: Event) => {
            const target = e.target as HTMLInputElement;
            handleToggleValue1Change(parseInt(target.value, 10));
          }),
          renderRangeSetting('Value 2', resolvedSettings.toggleValue2, (e: Event) => {
            const target = e.target as HTMLInputElement;
            handleToggleValue2Change(parseInt(target.value, 10));
          })
        );
      case 'cycle':
        return h(
          'div',
          { id: 'cycle-settings-container', className: 'mode-setting' },
          h(
            'div',
            { className: 'sdpi-item' },
            h('div', { className: 'sdpi-item-label' }, 'Cycle Values'),
            h(
              'div',
              { className: 'sdpi-item-value' },
              h(
                'div',
                { className: 'cycle-values-list' },
                (resolvedSettings.cycleValues || DEFAULT_SETTINGS.cycleValues).map((val, idx) =>
                  h(
                    'div',
                    { className: 'cycle-value-item', key: idx },
                    h('input', {
                      type: 'range',
                      min: 0,
                      max: 100,
                      value: val,
                      disabled: true,
                    }),
                    h('span', null, `${val}%`)
                  )
                )
              )
            )
          )
        );
      default:
        return renderRangeSetting(
          'Step Size',
          resolvedSettings.stepSize,
          (e: Event) => {
            const target = e.target as HTMLInputElement;
            handleStepSizeChange(parseInt(target.value, 10));
          },
          { id: 'step-size-container', className: 'sdpi-item mode-setting', min: 1, max: 100 }
        );
    }
  };

  return h(
    'div',
    { className: 'pi-container' },
    h(CreatorHeader, { onOpenUrl: openUrl }),
    h(
      'div',
      { className: 'sdpi-item' },
      h('div', { className: 'sdpi-item-label' }, 'Displays'),
      h(MonitorSelector, {
        selectedMonitors: resolvedSettings.selectedMonitors || [],
        onMonitorsChange: handleMonitorChange,
      })
    ),
    h(
      'div',
      { className: 'sdpi-item' },
      h('div', { className: 'sdpi-item-label' }, 'Mode'),
      h(
        'div',
        { className: 'sdpi-item-value' },
        h(
          'select',
          {
            id: 'operation-mode',
            className: 'sdpi-item-value select',
            value: resolvedSettings.operationMode,
            onChange: (e: Event) => {
              const target = e.target as HTMLSelectElement;
              handleOperationModeChange(target.value as BrightnessButtonSettings['operationMode']);
            },
          },
          OPERATION_MODE_OPTIONS.map((option) =>
            h('option', { value: option.value, key: option.value }, option.label)
          )
        )
      )
    ),
    renderModeSettings(),
    h(AdvancedSettings, {
      settings: globalSettings,
      onSettingChange: updateGlobalSetting,
    })
  );
}

const container = document.getElementById('pi-container');
if (container) {
  import('preact').then(({ render }) => {
    render(h(ContrastButtonPI, null), container);
  });
}

export {};
