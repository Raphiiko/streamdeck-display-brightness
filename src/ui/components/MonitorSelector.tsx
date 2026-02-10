import { h } from 'preact';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { Monitor } from '../shared-types';
import { onMonitorList, onStreamDeckMessage } from '../streamdeck';

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
  const [expandedDebugMonitorIds, setExpandedDebugMonitorIds] = useState<string[]>([]);
  const [showDebugModal, setShowDebugModal] = useState(false);
  const [debugExportText, setDebugExportText] = useState('');
  const [isExporting, setIsExporting] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState('');

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

  useEffect(() => {
    return onStreamDeckMessage((msg) => {
      if (msg.event !== 'sendToPropertyInspector') return;
      if (msg.payload?.event !== 'monitorDebugInfo') return;

      const debugText =
        typeof msg.payload?.debugText === 'string'
          ? msg.payload.debugText
          : 'No debug payload returned.';
      setDebugExportText(debugText);
      setShowDebugModal(true);
      setIsExporting(false);
    });
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

    // Always show all currently-detected monitor identities, including unavailable ones.
    for (const monitor of monitors) {
      items.push({ ...monitor, isPlaceholder: false });
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

  const buildFallbackDebugText = useCallback((): string => {
    const lines: string[] = [];
    lines.push('sd-brightness monitor debug report (property inspector fallback)');
    lines.push(`generatedAt: ${new Date().toISOString()}`);
    lines.push(
      'note: plugin debug payload not received yet; this fallback only contains the current monitor list from the property inspector.'
    );
    lines.push('');

    lines.push(`monitors (${monitors.length})`);
    if (monitors.length === 0) {
      lines.push('- none');
    } else {
      for (const monitor of monitors) {
        lines.push(
          `- id=${monitor.id} | name=${monitor.name} | backend=${monitor.backend ?? '-'} | runtimeIndex=${monitor.runtimeIndex ?? '-'} | available=${monitor.available} | brightness=${monitor.brightness}`
        );
        lines.push(
          `  manufacturerId=${monitor.manufacturerId ?? '-'} | modelName=${monitor.modelName ?? '-'} | serialNumber=${monitor.serialNumber ?? '-'}`
        );
      }
    }

    return lines.join('\n');
  }, [monitors]);

  const handleExportDebugInfo = useCallback(() => {
    setCopyFeedback('');
    setIsExporting(true);
    setShowDebugModal(true);
    setDebugExportText(buildFallbackDebugText());
    window.streamDeck?.sendToPlugin({ event: 'exportMonitorDebugInfo' });
  }, [buildFallbackDebugText]);

  const handleCopyDebugText = useCallback(async () => {
    if (!debugExportText) return;

    try {
      await navigator.clipboard.writeText(debugExportText);
      setCopyFeedback('Copied');
      return;
    } catch {
      // ignore and try fallback
    }

    const textarea = document.createElement('textarea');
    textarea.value = debugExportText;
    textarea.style.position = 'fixed';
    textarea.style.left = '-1000px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    setCopyFeedback(copied ? 'Copied' : 'Copy failed');
  }, [debugExportText]);

  const isMonitorDebugExpanded = useCallback(
    (monitorId: string) => expandedDebugMonitorIds.includes(monitorId),
    [expandedDebugMonitorIds]
  );

  const toggleMonitorDebug = useCallback((monitorId: string) => {
    setExpandedDebugMonitorIds((current) =>
      current.includes(monitorId)
        ? current.filter((id) => id !== monitorId)
        : [...current, monitorId]
    );
  }, []);

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
      h('div', { className: 'no-monitors' }, 'No DDC/CI compatible monitors found'),
      h(
        'div',
        { className: 'monitor-debug-actions' },
        h(
          'button',
          {
            type: 'button',
            className: 'monitor-debug-export-button',
            onClick: handleExportDebugInfo,
          },
          isExporting ? 'Exporting Debug Info...' : 'Export Debug Info'
        )
      )
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
          'div',
          {
            className: `monitor-item${monitor.available ? '' : ' monitor-item--undetected'}`,
            key: monitor.id,
          },
          h(
            'div',
            { className: 'monitor-item-header' },
            h(
              'label',
              { className: 'monitor-item-toggle' },
              h('input', {
                type: 'checkbox',
                checked: normalizedSelectedMonitors.includes(monitor.id),
                onChange: (e: Event) => {
                  const target = e.target as HTMLInputElement;
                  handleCheckboxChange(monitor.id, target.checked);
                },
              }),
              h('span', { className: 'monitor-name' }, monitor.name?.trim() || monitor.id),
              monitor.backend
                ? h(
                    'span',
                    { className: 'monitor-backend', title: 'Detected backend' },
                    monitor.backend
                  )
                : null
            ),
            h(
              'button',
              {
                type: 'button',
                className: `monitor-row-debug-toggle${isMonitorDebugExpanded(monitor.id) ? ' monitor-row-debug-toggle--open' : ''}`,
                onClick: () => toggleMonitorDebug(monitor.id),
                title: isMonitorDebugExpanded(monitor.id) ? 'Hide debug info' : 'Show debug info',
              },
              h('span', { className: 'monitor-row-debug-toggle-caret', 'aria-hidden': 'true' }, '▾')
            ),
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
          ),
          isMonitorDebugExpanded(monitor.id)
            ? h(
                'div',
                { className: 'monitor-debug-panel' },
                h(
                  'dl',
                  { className: 'monitor-debug-grid' },
                  h('dt', null, 'Stable ID'),
                  h('dd', null, monitor.id),
                  h('dt', null, 'API/backend'),
                  h('dd', null, monitor.backend ?? '-'),
                  h('dt', null, 'Runtime index'),
                  h('dd', null, String(monitor.runtimeIndex ?? '-')),
                  h('dt', null, 'Model'),
                  h('dd', null, monitor.modelName ?? '-'),
                  h('dt', null, 'Manufacturer'),
                  h('dd', null, monitor.manufacturerId ?? '-'),
                  h('dt', null, 'Serial'),
                  h('dd', null, monitor.serialNumber ?? '-'),
                  h('dt', null, 'Status'),
                  h('dd', null, monitor.available ? 'Detected' : 'Unavailable')
                )
              )
            : null
        )
      )
    ),
    h(
      'div',
      { className: 'monitor-debug-actions' },
      h(
        'button',
        {
          type: 'button',
          className: 'monitor-debug-export-button',
          onClick: handleExportDebugInfo,
        },
        isExporting ? 'Exporting Debug Info...' : 'Export Debug Info'
      )
    ),
    showDebugModal
      ? h(
          'div',
          { className: 'monitor-debug-modal-overlay' },
          h(
            'div',
            { className: 'monitor-debug-modal' },
            h('div', { className: 'monitor-debug-modal-title' }, 'Monitor Debug Info'),
            h('textarea', {
              className: 'monitor-debug-textarea',
              readOnly: true,
              value: debugExportText,
            }),
            h(
              'div',
              { className: 'monitor-debug-modal-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'monitor-debug-modal-button',
                  onClick: () => {
                    setShowDebugModal(false);
                    setIsExporting(false);
                  },
                },
                'Close'
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'monitor-debug-modal-button monitor-debug-modal-button--primary',
                  onClick: () => {
                    void handleCopyDebugText();
                  },
                },
                copyFeedback || 'Copy to Clipboard'
              )
            )
          )
        )
      : null
  );
}
