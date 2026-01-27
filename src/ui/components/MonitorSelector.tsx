import { h } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Monitor } from '../shared-types';
import { onMonitorList } from '../streamdeck';

interface MonitorSelectorProps {
  selectedMonitors: string[];
  onMonitorsChange(monitors: string[]): void;
}

type MonitorListItem = Monitor & { isPlaceholder: boolean };

function MonitorUndetectedIcon() {
  return h(
    'svg',
    {
      width: 14,
      height: 14,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      focusable: 'false',
    },
    h('rect', { x: 3, y: 4, width: 18, height: 12, rx: 2, ry: 2 }),
    h('path', { d: 'M7 20h10' }),
    h('path', { d: 'M9 16v4' }),
    h('path', { d: 'M15 16v4' }),
    h('path', { d: 'M4 5l16 14' })
  );
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

  const normalizedSelectedMonitors = useMemo(() => {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of selectedMonitors ?? []) {
      const normalized = (id ?? '').trim();
      if (!normalized) continue;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(normalized);
    }
    return unique;
  }, [selectedMonitors]);

  const handleCheckboxChange = useCallback(
    (monitorId: string, checked: boolean) => {
      const normalizedId = (monitorId ?? '').trim();
      if (!normalizedId) return;
      if (checked) {
        const next = Array.from(new Set([...normalizedSelectedMonitors, normalizedId]));
        onMonitorsChange(next);
      } else {
        onMonitorsChange(normalizedSelectedMonitors.filter((id) => id !== normalizedId));
      }
    },
    [normalizedSelectedMonitors, onMonitorsChange]
  );

  const visibleMonitors = useMemo<MonitorListItem[]>(() => {
    const selectedSet = new Set(normalizedSelectedMonitors);
    const byId = new Map(monitors.map((m) => [m.id, m]));

    const items: MonitorListItem[] = [];

    // Always show detected/available monitors, and keep selected-but-unavailable monitors visible.
    for (const monitor of monitors) {
      if (monitor.available || selectedSet.has(monitor.id)) {
        items.push({ ...monitor, isPlaceholder: false });
      }
    }

    // If settings target monitors that aren't currently being reported, show placeholders
    // so users can unselect them.
    for (const id of normalizedSelectedMonitors) {
      if (byId.has(id)) continue;
      items.push({
        id,
        name: id,
        brightness: 0,
        available: false,
        isPlaceholder: true,
      });
    }

    return items.sort((a, b) => {
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
  }, [monitors, normalizedSelectedMonitors]);

  if (!hasReceivedData) {
    return h(
      'div',
      { className: 'monitor-container' },
      h('div', { className: 'no-monitors' }, 'Loading displays...')
    );
  }

  if (visibleMonitors.length === 0) {
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
      visibleMonitors.map((monitor) =>
        h(
          'label',
          {
            className: `monitor-item${monitor.available ? '' : ' monitor-item--undetected'}`,
            key: monitor.id,
          },
          h('input', {
            type: 'checkbox',
            checked: normalizedSelectedMonitors.includes(monitor.id),
            onChange: (e: Event) => {
              const target = e.target as HTMLInputElement;
              handleCheckboxChange(monitor.id, target.checked);
            },
          }),
          h('span', { className: 'monitor-name' }, monitor.name?.trim() || monitor.id),
          !monitor.available
            ? h(
                'span',
                {
                  className: 'monitor-status-icon',
                  title: monitor.isPlaceholder
                    ? 'Display is currently not detected (saved from this action)'
                    : 'Display is currently not detected',
                },
                h(MonitorUndetectedIcon, null)
              )
            : null
        )
      )
    )
  );
}
