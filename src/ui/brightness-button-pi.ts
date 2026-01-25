/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */

import type { BrightnessButtonSettings, GlobalSettings } from '../types/settings';
import type { StreamDeck, Monitor } from './shared-types';
import {
  DEFAULT_DDC_WRITE_THROTTLE_MS,
  DEFAULT_ENFORCEMENT_DURATION_MS,
  DEFAULT_ENFORCEMENT_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
} from '../globals';

let currentSettings: BrightnessButtonSettings = {
  selectedMonitors: [],
  operationMode: 'increase',
  stepSize: 10,
  setValue: 100,
  toggleValue1: 0,
  toggleValue2: 100,
  cycleValues: [0, 25, 50, 75, 100],
};

let globalSettings: GlobalSettings = {
  ddcWriteThrottleMs: DEFAULT_DDC_WRITE_THROTTLE_MS,
  enforcementDurationMs: DEFAULT_ENFORCEMENT_DURATION_MS,
  enforcementIntervalMs: DEFAULT_ENFORCEMENT_INTERVAL_MS,
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
};

let availableMonitors: Monitor[] = [];
let isInitialized = false;
let advancedExpanded = false;

function connectElgatoStreamDeckSocket(
  inPort: string,
  inUUID: string,
  inRegisterEvent: string,
  _inInfo: string,
  inActionInfo: string
): void {
  const actionInfo = JSON.parse(inActionInfo) as {
    action: string;
    payload?: { settings?: BrightnessButtonSettings };
  };
  const uuid = inUUID;
  const action = actionInfo.action;

  if (actionInfo.payload?.settings) {
    currentSettings = { ...currentSettings, ...actionInfo.payload.settings };
  }

  const streamDeck: StreamDeck = {
    websocket: new WebSocket(`ws://127.0.0.1:${inPort}`),
    uuid: uuid,
    action: action,
    send: function (payload: unknown): void {
      this.websocket.send(JSON.stringify(payload));
    },
    getSettings: function (): void {
      this.send({ event: 'getSettings', context: uuid });
    },
    setSettings: function (payload: BrightnessButtonSettings): void {
      this.send({ event: 'setSettings', context: uuid, payload });
    },
    getGlobalSettings: function (): void {
      this.send({ event: 'getGlobalSettings', context: uuid });
    },
    setGlobalSettings: function (payload: GlobalSettings): void {
      this.send({ event: 'setGlobalSettings', context: uuid, payload });
    },
    sendToPlugin: function (payload: { event: string }): void {
      this.send({ event: 'sendToPlugin', action: action, payload: payload, context: uuid });
    },
  };

  streamDeck.websocket.onopen = function (): void {
    console.log('PI WebSocket connected');
    streamDeck.send({ event: inRegisterEvent, uuid: uuid });
    streamDeck.getSettings();
    streamDeck.getGlobalSettings();

    isInitialized = true;
    setTimeout(() => {
      console.log('Requesting initial monitor list...');
      requestMonitorList();
    }, 100);
  };

  streamDeck.websocket.onmessage = function (evt: MessageEvent): void {
    const msg = JSON.parse(evt.data as string) as {
      event: string;
      payload?: {
        settings?: BrightnessButtonSettings | GlobalSettings;
        event?: string;
        monitors?: Monitor[];
      };
    };
    console.log('PI received message:', msg.event);

    if (msg.event === inRegisterEvent) {
      streamDeck.uuid = uuid;
    } else if (msg.event === 'didReceiveSettings' && msg.payload?.settings) {
      currentSettings = {
        ...currentSettings,
        ...(msg.payload.settings as BrightnessButtonSettings),
      };
      updateUI();
      if (isInitialized) {
        requestMonitorList();
      }
    } else if (msg.event === 'didReceiveGlobalSettings' && msg.payload?.settings) {
      globalSettings = { ...globalSettings, ...(msg.payload.settings as GlobalSettings) };
      updateAdvancedSettingsUI();
    } else if (msg.event === 'sendToPropertyInspector' && msg.payload?.event === 'monitorList') {
      console.log('Received monitor list:', msg.payload.monitors);
      availableMonitors = msg.payload.monitors || [];
      renderMonitorList();
    }
  };

  streamDeck.websocket.onerror = function (error: Event): void {
    console.error('PI WebSocket error:', error);
  };

  window.streamDeck = streamDeck;
}

function requestMonitorList(): void {
  if (window.streamDeck && window.streamDeck.websocket.readyState === WebSocket.OPEN) {
    console.log('Sending getMonitors request...');
    window.streamDeck.sendToPlugin({ event: 'getMonitors' });
  } else {
    console.warn('WebSocket not ready, retrying in 100ms...');
    setTimeout(requestMonitorList, 100);
  }
}

function updateUI() {
  const modeSelect = document.getElementById('operation-mode') as HTMLSelectElement;
  if (modeSelect) {
    modeSelect.value = currentSettings.operationMode ?? 'increase';
  }

  updateModeSettingsVisibility();

  const stepSizeSlider = document.getElementById('step-size') as HTMLInputElement;
  const stepSizeValue = document.getElementById('step-size-value');
  if (stepSizeSlider && stepSizeValue) {
    stepSizeSlider.value = String(currentSettings.stepSize ?? 10);
    stepSizeValue.textContent = String(currentSettings.stepSize ?? 10);
  }

  const setValueSlider = document.getElementById('set-value') as HTMLInputElement;
  const setValueDisplay = document.getElementById('set-value-display');
  if (setValueSlider && setValueDisplay) {
    setValueSlider.value = String(currentSettings.setValue ?? 100);
    setValueDisplay.textContent = String(currentSettings.setValue ?? 100);
  }

  const toggleValue1Slider = document.getElementById('toggle-value-1') as HTMLInputElement;
  const toggleValue1Display = document.getElementById('toggle-value-1-display');
  if (toggleValue1Slider && toggleValue1Display) {
    toggleValue1Slider.value = String(currentSettings.toggleValue1 ?? 0);
    toggleValue1Display.textContent = String(currentSettings.toggleValue1 ?? 0);
  }

  const toggleValue2Slider = document.getElementById('toggle-value-2') as HTMLInputElement;
  const toggleValue2Display = document.getElementById('toggle-value-2-display');
  if (toggleValue2Slider && toggleValue2Display) {
    toggleValue2Slider.value = String(currentSettings.toggleValue2 ?? 100);
    toggleValue2Display.textContent = String(currentSettings.toggleValue2 ?? 100);
  }

  renderCycleValuesList();
}

function updateAdvancedSettingsUI() {
  const ddcThrottleSlider = document.getElementById('ddc-write-throttle') as HTMLInputElement;
  const ddcThrottleValue = document.getElementById('ddc-write-throttle-value');
  if (ddcThrottleSlider && ddcThrottleValue) {
    ddcThrottleSlider.value = String(
      globalSettings.ddcWriteThrottleMs ?? DEFAULT_DDC_WRITE_THROTTLE_MS
    );
    ddcThrottleValue.textContent = String(
      globalSettings.ddcWriteThrottleMs ?? DEFAULT_DDC_WRITE_THROTTLE_MS
    );
  }

  const enforcementDurationSlider = document.getElementById(
    'enforcement-duration'
  ) as HTMLInputElement;
  const enforcementDurationValue = document.getElementById('enforcement-duration-value');
  if (enforcementDurationSlider && enforcementDurationValue) {
    enforcementDurationSlider.value = String(
      globalSettings.enforcementDurationMs ?? DEFAULT_ENFORCEMENT_DURATION_MS
    );
    enforcementDurationValue.textContent = String(
      globalSettings.enforcementDurationMs ?? DEFAULT_ENFORCEMENT_DURATION_MS
    );
  }

  const enforcementIntervalSlider = document.getElementById(
    'enforcement-interval'
  ) as HTMLInputElement;
  const enforcementIntervalValue = document.getElementById('enforcement-interval-value');
  if (enforcementIntervalSlider && enforcementIntervalValue) {
    enforcementIntervalSlider.value = String(
      globalSettings.enforcementIntervalMs ?? DEFAULT_ENFORCEMENT_INTERVAL_MS
    );
    enforcementIntervalValue.textContent = String(
      globalSettings.enforcementIntervalMs ?? DEFAULT_ENFORCEMENT_INTERVAL_MS
    );
  }

  const pollIntervalSlider = document.getElementById('poll-interval') as HTMLInputElement;
  const pollIntervalValue = document.getElementById('poll-interval-value');
  if (pollIntervalSlider && pollIntervalValue) {
    pollIntervalSlider.value = String(globalSettings.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    pollIntervalValue.textContent = String(
      globalSettings.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    );
  }
}

function updateModeSettingsVisibility() {
  const mode = currentSettings.operationMode ?? 'increase';

  const stepSizeContainer = document.getElementById('step-size-container');
  const setValueContainer = document.getElementById('set-value-container');
  const toggleSettingsContainer = document.getElementById('toggle-settings-container');
  const cycleSettingsContainer = document.getElementById('cycle-settings-container');

  if (stepSizeContainer) stepSizeContainer.style.display = 'none';
  if (setValueContainer) setValueContainer.style.display = 'none';
  if (toggleSettingsContainer) toggleSettingsContainer.style.display = 'none';
  if (cycleSettingsContainer) cycleSettingsContainer.style.display = 'none';

  if (mode === 'increase' || mode === 'decrease') {
    if (stepSizeContainer) stepSizeContainer.style.display = 'block';
  } else if (mode === 'set') {
    if (setValueContainer) setValueContainer.style.display = 'block';
  } else if (mode === 'toggle') {
    if (toggleSettingsContainer) toggleSettingsContainer.style.display = 'block';
  } else if (mode === 'cycle') {
    if (cycleSettingsContainer) cycleSettingsContainer.style.display = 'block';
  }
}

function renderMonitorList(): void {
  const container = document.getElementById('monitor-container');

  if (!container || !availableMonitors || availableMonitors.length === 0) {
    if (container) {
      container.innerHTML = '<div class="no-monitors">No DDC/CI compatible monitors found</div>';
    }
    return;
  }

  const selectedMonitors = currentSettings.selectedMonitors ?? [];

  container.innerHTML =
    '<div class="monitor-list">' +
    availableMonitors
      .map((monitor) => {
        const checkboxId = `monitor-${monitor.id}`;
        return `
				<label class="monitor-item">
					<input
						type="checkbox"
						id="${checkboxId}"
						value="${monitor.id}"
						${selectedMonitors.includes(monitor.id) ? 'checked' : ''}
					/>
					<span>${monitor.name}</span>
				</label>
			`;
      })
      .join('') +
    '</div>';

  attachMonitorCheckboxListeners();
}

function openUrl(url: string): void {
  if (window.streamDeck) {
    window.streamDeck.send({ event: 'openUrl', payload: { url } });
  }
}

function attachMonitorCheckboxListeners(): void {
  availableMonitors.forEach((monitor) => {
    const checkbox = document.getElementById(`monitor-${monitor.id}`) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.addEventListener('change', function (this: HTMLInputElement): void {
        const monitorId = this.value;
        if (!currentSettings.selectedMonitors) {
          currentSettings.selectedMonitors = [];
        }
        if (this.checked) {
          if (!currentSettings.selectedMonitors.includes(monitorId)) {
            currentSettings.selectedMonitors.push(monitorId);
          }
        } else {
          currentSettings.selectedMonitors = currentSettings.selectedMonitors.filter(
            (id) => id !== monitorId
          );
        }
        if (window.streamDeck) {
          window.streamDeck.setSettings(currentSettings);
        }
      });
    }
  });
}

function renderCycleValuesList() {
  const cycleValuesListContainer = document.getElementById('cycle-values-list');
  if (!cycleValuesListContainer) return;

  const cycleValues = currentSettings.cycleValues ?? [0, 25, 50, 75, 100];

  cycleValuesListContainer.innerHTML = '';

  cycleValues.forEach((value, index) => {
    const cycleValueItem = document.createElement('div');
    cycleValueItem.className = 'cycle-value-item';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(value);
    slider.addEventListener('input', () => handleCycleValueChange(index, parseInt(slider.value)));

    const display = document.createElement('span');
    display.className = 'cycle-value-display';
    display.textContent = `${value}%`;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'cycle-value-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => handleRemoveCycleValue(index));

    cycleValueItem.appendChild(slider);
    cycleValueItem.appendChild(display);
    cycleValueItem.appendChild(removeBtn);

    cycleValuesListContainer.appendChild(cycleValueItem);

    slider.addEventListener('input', () => {
      display.textContent = `${slider.value}%`;
    });
  });
}

function handleAddCycleValue() {
  const cycleValues = currentSettings.cycleValues ?? [0, 25, 50, 75, 100];
  cycleValues.push(50);
  currentSettings.cycleValues = cycleValues;
  renderCycleValuesList();
  if (window.streamDeck) {
    window.streamDeck.setSettings(currentSettings);
  }
}

function handleRemoveCycleValue(index: number) {
  const cycleValues = currentSettings.cycleValues ?? [0, 25, 50, 75, 100];

  if (cycleValues.length <= 1) {
    return;
  }

  cycleValues.splice(index, 1);
  currentSettings.cycleValues = cycleValues;
  renderCycleValuesList();
  if (window.streamDeck) {
    window.streamDeck.setSettings(currentSettings);
  }
}

function handleCycleValueChange(index: number, newValue: number) {
  const cycleValues = currentSettings.cycleValues ?? [0, 25, 50, 75, 100];
  cycleValues[index] = newValue;
  currentSettings.cycleValues = cycleValues;
  if (window.streamDeck) {
    window.streamDeck.setSettings(currentSettings);
  }
}

document.addEventListener('DOMContentLoaded', function (): void {
  // Operation mode
  const operationModeSelect = document.getElementById('operation-mode') as HTMLSelectElement | null;
  if (operationModeSelect) {
    operationModeSelect.addEventListener('change', function (): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      currentSettings.operationMode = this.value as any;
      updateModeSettingsVisibility();
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  // Step size
  const stepSizeInput = document.getElementById('step-size') as HTMLInputElement | null;
  if (stepSizeInput) {
    stepSizeInput.addEventListener('input', function (): void {
      const value = parseInt(this.value);
      currentSettings.stepSize = value;
      const display = document.getElementById('step-size-value');
      if (display) display.textContent = String(value);
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  // Set value
  const setValueInput = document.getElementById('set-value') as HTMLInputElement | null;
  if (setValueInput) {
    setValueInput.addEventListener('input', function (): void {
      const value = parseInt(this.value);
      currentSettings.setValue = value;
      const display = document.getElementById('set-value-display');
      if (display) display.textContent = String(value);
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  // Toggle value 1
  const toggleValue1Input = document.getElementById('toggle-value-1') as HTMLInputElement | null;
  if (toggleValue1Input) {
    toggleValue1Input.addEventListener('input', function (): void {
      const value = parseInt(this.value);
      currentSettings.toggleValue1 = value;
      const display = document.getElementById('toggle-value-1-display');
      if (display) display.textContent = String(value);
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  // Toggle value 2
  const toggleValue2Input = document.getElementById('toggle-value-2') as HTMLInputElement | null;
  if (toggleValue2Input) {
    toggleValue2Input.addEventListener('input', function (): void {
      const value = parseInt(this.value);
      currentSettings.toggleValue2 = value;
      const display = document.getElementById('toggle-value-2-display');
      if (display) display.textContent = String(value);
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  // Add cycle value
  const addCycleValueBtn = document.getElementById('add-cycle-value-btn');
  if (addCycleValueBtn) {
    addCycleValueBtn.addEventListener('click', handleAddCycleValue);
  }

  // Refresh monitors
  const refreshBtn = document.getElementById('refresh-monitors-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', function (): void {
      const monitorContainer = document.getElementById('monitor-container');
      if (monitorContainer) {
        monitorContainer.innerHTML = '<div class="no-monitors">Refreshing...</div>';
      }
      if (window.streamDeck) {
        window.streamDeck.sendToPlugin({ event: 'refreshMonitors' });
        setTimeout(requestMonitorList, 1000);
      }
    });
  }

  // Advanced settings - global
  const ddcWriteInput = document.getElementById('ddc-write-throttle') as HTMLInputElement | null;
  if (ddcWriteInput) {
    ddcWriteInput.addEventListener('input', function (): void {
      globalSettings.ddcWriteThrottleMs = parseInt(this.value, 10);
      const display = document.getElementById('ddc-write-throttle-value');
      if (display) display.textContent = String(globalSettings.ddcWriteThrottleMs) + 'ms';
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const enforcementDurationInput = document.getElementById(
    'enforcement-duration'
  ) as HTMLInputElement | null;
  if (enforcementDurationInput) {
    enforcementDurationInput.addEventListener('input', function (): void {
      globalSettings.enforcementDurationMs = parseInt(this.value, 10);
      const display = document.getElementById('enforcement-duration-value');
      if (display) display.textContent = String(globalSettings.enforcementDurationMs) + 'ms';
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const enforcementIntervalInput = document.getElementById(
    'enforcement-interval'
  ) as HTMLInputElement | null;
  if (enforcementIntervalInput) {
    enforcementIntervalInput.addEventListener('input', function (): void {
      globalSettings.enforcementIntervalMs = parseInt(this.value, 10);
      const display = document.getElementById('enforcement-interval-value');
      if (display) display.textContent = String(globalSettings.enforcementIntervalMs) + 'ms';
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const pollIntervalInput = document.getElementById('poll-interval') as HTMLInputElement | null;
  if (pollIntervalInput) {
    pollIntervalInput.addEventListener('input', function (): void {
      globalSettings.pollIntervalMs = parseInt(this.value, 10);
      const display = document.getElementById('poll-interval-value');
      if (display) display.textContent = String(globalSettings.pollIntervalMs) + 'ms';
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  // Advanced toggle
  const advancedHeader = document.getElementById('advanced-header');
  if (advancedHeader) {
    advancedHeader.addEventListener('click', function (): void {
      advancedExpanded = !advancedExpanded;
      const section = document.getElementById('advancedSection');
      const toggle = document.getElementById('advancedToggle');
      if (section && toggle) {
        if (advancedExpanded) {
          section.classList.remove('collapsed');
          section.style.maxHeight = section.scrollHeight + 'px';
          toggle.classList.remove('collapsed');
        } else {
          section.classList.add('collapsed');
          section.style.maxHeight = '0';
          toggle.classList.add('collapsed');
        }
      }
    });
  }

  // Creator links
  const creatorLinks = document.querySelectorAll('.creator-links a');
  creatorLinks.forEach((link) => {
    link.addEventListener('click', function (this: HTMLAnchorElement, e: Event): void {
      e.preventDefault();
      const url = this.getAttribute('data-url');
      if (url) {
        openUrl(url);
      }
    });
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

export {};
