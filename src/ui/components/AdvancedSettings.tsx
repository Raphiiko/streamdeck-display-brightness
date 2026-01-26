import { h } from 'preact';
import { useState } from 'preact/hooks';
import {
  DEFAULT_DDC_WRITE_THROTTLE_MS,
  DEFAULT_ENFORCEMENT_DURATION_MS,
  DEFAULT_ENFORCEMENT_INTERVAL_MS,
  DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS,
} from '../../globals';
import type { GlobalSettings } from '../../types/settings';

interface AdvancedSettingsProps {
  settings: GlobalSettings;
  onSettingChange(key: keyof GlobalSettings, value: number): void;
}

export function AdvancedSettings({ settings, onSettingChange }: AdvancedSettingsProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const toggleSection = () => setIsExpanded((prev) => !prev);

  const sliderConfigs = [
    {
      label: 'DDC Write Throttle',
      settingKey: 'ddcWriteThrottleMs',
      min: 10,
      max: 5000,
      step: 10,
      defaultValue: DEFAULT_DDC_WRITE_THROTTLE_MS,
      description: `Minimum time between DDC write commands (default: ${DEFAULT_DDC_WRITE_THROTTLE_MS}ms).`,
    },
    {
      label: 'Enforcement Duration',
      settingKey: 'enforcementDurationMs',
      min: 1000,
      max: 30000,
      step: 500,
      defaultValue: DEFAULT_ENFORCEMENT_DURATION_MS,
      description: `Duration to keep retrying brightness writes after user input (default: ${DEFAULT_ENFORCEMENT_DURATION_MS}ms).`,
    },
    {
      label: 'Enforcement Interval',
      settingKey: 'enforcementIntervalMs',
      min: 100,
      max: 5000,
      step: 100,
      defaultValue: DEFAULT_ENFORCEMENT_INTERVAL_MS,
      description: `Interval between retry attempts when enforcing brightness (default: ${DEFAULT_ENFORCEMENT_INTERVAL_MS}ms).`,
    },
    {
      label: 'Brightness Poll Interval',
      settingKey: 'pollIntervalMs',
      min: 10,
      max: 10000,
      step: 10,
      defaultValue: DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS,
      description: `Interval for polling monitor brightness (default: ${DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS}ms).`,
    },
  ] satisfies Array<{
    label: string;
    settingKey: keyof GlobalSettings;
    min: number;
    max: number;
    step: number;
    defaultValue: number;
    description: string;
  }>;

  const renderSlider = (
    label: string,
    settingKey: keyof GlobalSettings,
    min: number,
    max: number,
    step: number,
    defaultValue: number,
    description: string
  ) => {
    const value = settings[settingKey] ?? defaultValue;

    return h(
      'div',
      { className: 'sdpi-item', key: settingKey },
      h('div', { className: 'sdpi-item-label' }, label),
      h(
        'div',
        { className: 'slider-container' },
        h('input', {
          type: 'range',
          min,
          max,
          step,
          value,
          onInput: (e: Event) => {
            const target = e.target as HTMLInputElement;
            onSettingChange(settingKey, parseInt(target.value, 10));
          },
        }),
        h('span', { className: 'slider-value' }, `${value}ms`)
      ),
      h('div', { className: 'sdpi-info' }, description)
    );
  };

  return h(
    'div',
    null,
    h(
      'div',
      {
        className: 'sdpi-item section-header',
        id: 'advanced-header',
        onClick: toggleSection,
      },
      h(
        'span',
        {
          className: `section-toggle ${isExpanded ? '' : 'collapsed'}`,
        },
        '▼'
      ),
      h('span', null, 'Advanced Settings')
    ),
    h(
      'div',
      {
        id: 'advancedSection',
        className: `section-content ${isExpanded ? '' : 'collapsed'}`,
        style: isExpanded ? { maxHeight: '1000px' } : { maxHeight: '0', overflow: 'hidden' },
      },
      sliderConfigs.map((config) =>
        renderSlider(
          config.label,
          config.settingKey,
          config.min,
          config.max,
          config.step,
          config.defaultValue,
          config.description
        )
      )
    )
  );
}
