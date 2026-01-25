import type { GlobalSettings } from '../types/settings';
import type { StreamDeck, Monitor, DialSettings } from './shared-types';

let currentSettings: DialSettings = {
  selectedMonitors: [],
  stepSize: 5,
};
let globalSettings: GlobalSettings = {
  ddcWriteThrottleMs: 1000,
  enforcementDurationMs: 10000,
  enforcementIntervalMs: 1000,
  pollIntervalMs: 5000,
};
let availableMonitors: Monitor[] = [];
let isInitialized = false;
let advancedExpanded = false;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function connectElgatoStreamDeckSocket(
  inPort: string,
  inUUID: string,
  inRegisterEvent: string,
  _inInfo: string,
  inActionInfo: string
): void {
  const actionInfo = JSON.parse(inActionInfo) as { action: string };
  const uuid = inUUID;
  const action = actionInfo.action;

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
    setSettings: function (payload: DialSettings): void {
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
        settings?: DialSettings | GlobalSettings;
        event?: string;
        monitors?: Monitor[];
      };
    };
    console.log('PI received message:', msg.event);

    if (msg.event === inRegisterEvent) {
      streamDeck.uuid = uuid;
    } else if (msg.event === 'didReceiveSettings' && msg.payload?.settings) {
      currentSettings = { ...currentSettings, ...(msg.payload.settings as DialSettings) };
      updateStepSize();
      if (isInitialized) {
        requestMonitorList();
      }
    } else if (msg.event === 'didReceiveGlobalSettings' && msg.payload?.settings) {
      globalSettings = { ...globalSettings, ...(msg.payload.settings as GlobalSettings) };
      updateAdvancedSettings();
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

function updateStepSize(): void {
  const slider = document.getElementById('stepSize') as HTMLInputElement | null;
  if (slider && currentSettings.stepSize) {
    slider.value = currentSettings.stepSize.toString();
    const stepValue = document.getElementById('stepValue');
    if (stepValue) {
      stepValue.textContent = currentSettings.stepSize.toString();
    }
  }
}

function updateAdvancedSettings(): void {
  const ddcSlider = document.getElementById('ddcWriteThrottleMs') as HTMLInputElement | null;
  const enforcementDurationSlider = document.getElementById(
    'enforcementDurationMs'
  ) as HTMLInputElement | null;
  const enforcementIntervalSlider = document.getElementById(
    'enforcementIntervalMs'
  ) as HTMLInputElement | null;
  const pollSlider = document.getElementById('pollIntervalMs') as HTMLInputElement | null;

  if (ddcSlider && globalSettings.ddcWriteThrottleMs) {
    ddcSlider.value = globalSettings.ddcWriteThrottleMs.toString();
    const ddcValue = document.getElementById('ddcWriteValue');
    if (ddcValue) {
      ddcValue.textContent = globalSettings.ddcWriteThrottleMs.toString() + 'ms';
    }
  }
  if (enforcementDurationSlider && globalSettings.enforcementDurationMs) {
    enforcementDurationSlider.value = globalSettings.enforcementDurationMs.toString();
    const enforcementValue = document.getElementById('enforcementDurationValue');
    if (enforcementValue) {
      enforcementValue.textContent = globalSettings.enforcementDurationMs.toString() + 'ms';
    }
  }
  if (enforcementIntervalSlider && globalSettings.enforcementIntervalMs) {
    enforcementIntervalSlider.value = globalSettings.enforcementIntervalMs.toString();
    const intervalValue = document.getElementById('enforcementIntervalValue');
    if (intervalValue) {
      intervalValue.textContent = globalSettings.enforcementIntervalMs.toString() + 'ms';
    }
  }
  if (pollSlider && globalSettings.pollIntervalMs) {
    pollSlider.value = globalSettings.pollIntervalMs.toString();
    const pollValue = document.getElementById('pollValue');
    if (pollValue) {
      pollValue.textContent = globalSettings.pollIntervalMs.toString() + 'ms';
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function toggleAdvanced(): void {
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
}

function renderMonitorList(): void {
  const container = document.getElementById('monitor-container');

  if (!container || !availableMonitors || availableMonitors.length === 0) {
    if (container) {
      container.innerHTML = '<div class="no-monitors">No DDC/CI compatible monitors found</div>';
    }
    return;
  }

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
						${currentSettings.selectedMonitors.includes(monitor.id) ? 'checked' : ''}
					/>
					<span>${monitor.name}</span>
				</label>
			`;
      })
      .join('') +
    '</div>';

  attachMonitorCheckboxListeners();
}

function attachMonitorCheckboxListeners(): void {
  availableMonitors.forEach((monitor) => {
    const checkbox = document.getElementById(`monitor-${monitor.id}`) as HTMLInputElement | null;
    if (checkbox) {
      checkbox.addEventListener('change', function (this: HTMLInputElement): void {
        const monitorId = this.value;
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

document.addEventListener('DOMContentLoaded', function (): void {
  const stepSizeInput = document.getElementById('stepSize') as HTMLInputElement | null;
  if (stepSizeInput) {
    stepSizeInput.addEventListener('change', function (): void {
      currentSettings.stepSize = parseInt(this.value, 10);
      if (window.streamDeck) {
        window.streamDeck.setSettings(currentSettings);
      }
    });
  }

  const refreshBtn = document.getElementById('refresh-btn');
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
  const ddcWriteInput = document.getElementById('ddcWriteThrottleMs') as HTMLInputElement | null;
  if (ddcWriteInput) {
    ddcWriteInput.addEventListener('change', function (): void {
      globalSettings.ddcWriteThrottleMs = parseInt(this.value, 10);
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const enforcementDurationInput = document.getElementById(
    'enforcementDurationMs'
  ) as HTMLInputElement | null;
  if (enforcementDurationInput) {
    enforcementDurationInput.addEventListener('change', function (): void {
      globalSettings.enforcementDurationMs = parseInt(this.value, 10);
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const enforcementIntervalInput = document.getElementById(
    'enforcementIntervalMs'
  ) as HTMLInputElement | null;
  if (enforcementIntervalInput) {
    enforcementIntervalInput.addEventListener('change', function (): void {
      globalSettings.enforcementIntervalMs = parseInt(this.value, 10);
      if (window.streamDeck) {
        window.streamDeck.setGlobalSettings(globalSettings);
      }
    });
  }

  const pollIntervalInput = document.getElementById('pollIntervalMs') as HTMLInputElement | null;
  if (pollIntervalInput) {
    pollIntervalInput.addEventListener('change', function (): void {
      globalSettings.pollIntervalMs = parseInt(this.value, 10);
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
});

(window as any).connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;

export {};
