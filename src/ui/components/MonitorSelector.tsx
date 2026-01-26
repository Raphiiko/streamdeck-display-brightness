import { h } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Monitor } from '../shared-types';
import { onMonitorList } from '../streamdeck';

interface MonitorSelectorProps {
  selectedMonitors: string[];
  onMonitorsChange(monitors: string[]): void;
}

export function MonitorSelector({ selectedMonitors, onMonitorsChange }: MonitorSelectorProps) {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [hasReceivedData, setHasReceivedData] = useState(false);

  useEffect(() => {
    const unsubscribe = onMonitorList((payload) => {
      const data = payload as { monitors?: Monitor[] };
      setHasReceivedData(true);
      setMonitors(data?.monitors ?? []);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleCheckboxChange = useCallback(
    (monitorId: string, checked: boolean) => {
      if (checked) {
        onMonitorsChange([...selectedMonitors, monitorId]);
      } else {
        onMonitorsChange(selectedMonitors.filter((id) => id !== monitorId));
      }
    },
    [onMonitorsChange, selectedMonitors]
  );

  const sortedMonitors = useMemo(() => {
    return [...monitors].sort((a, b) => {
      const nameA = a.name?.trim() || a.id;
      const nameB = b.name?.trim() || b.id;
      const nameCompare = nameA.localeCompare(nameB, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
      if (nameCompare !== 0) {
        return nameCompare;
      }
      return a.id.localeCompare(b.id, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [monitors]);

  if (!hasReceivedData) {
    return h(
      'div',
      { className: 'monitor-container' },
      h('div', { className: 'no-monitors' }, 'Loading displays...')
    );
  }

  if (monitors.length === 0) {
    return h(
      'div',
      { className: 'monitor-container' },
      h('div', { className: 'no-monitors' }, 'No DDC/CI compatible monitors found')
    );
  }

  return h(
    'div',
    { className: 'monitor-container' },
    h(
      'div',
      { className: 'monitor-list' },
      sortedMonitors.map((monitor) =>
        h(
          'label',
          { className: 'monitor-item', key: monitor.id },
          h('input', {
            type: 'checkbox',
            checked: selectedMonitors.includes(monitor.id),
            onChange: (e: Event) => {
              const target = e.target as HTMLInputElement;
              handleCheckboxChange(monitor.id, target.checked);
            },
          }),
          h('span', null, monitor.name)
        )
      )
    )
  );
}
