import streamDeck from '@elgato/streamdeck';
import { Subscription, mergeMap, groupBy, switchMap } from 'rxjs';
import { BrightnessDialAction } from './actions/brightness-dial-action';
import { BrightnessButtonAction } from './actions/brightness-button-action';
import { MonitorManager } from './services/monitor-manager';
import { BrightnessStore } from './services/brightness-store';
import { GlobalSettings } from './types/settings';

streamDeck.logger.setLevel('trace');

const monitorManager = MonitorManager.getInstance();
const brightnessStore = BrightnessStore.getInstance();
const subscriptions: Subscription[] = [];

function applyGlobalSettings(settings: GlobalSettings): void {
  brightnessStore.configure({
    ddcWriteThrottleMs: settings.ddcWriteThrottleMs,
    enforcementDurationMs: settings.enforcementDurationMs,
    enforcementIntervalMs: settings.enforcementIntervalMs,
  });
  monitorManager.configure({
    brightnessPollIntervalMs: settings.brightnessPollIntervalMs,
    monitorPollIntervalMs: settings.monitorPollIntervalMs,
  });
  streamDeck.logger.info(`Applied global settings: ${JSON.stringify(settings)}`);
}

void streamDeck.settings.getGlobalSettings<GlobalSettings>().then((settings) => {
  if (settings) {
    applyGlobalSettings(settings);
  }
});

streamDeck.settings.onDidReceiveGlobalSettings<GlobalSettings>((ev) => {
  applyGlobalSettings(ev.settings);
});

// Wire up MonitorManager poll results to BrightnessStore
// When polling returns a real brightness value, update the store
subscriptions.push(
  monitorManager.onPollResult$.subscribe(({ monitorId, brightness, maxBrightness }) => {
    brightnessStore.updateRealBrightness(monitorId, brightness, maxBrightness);
  })
);

// Wire up BrightnessStore DDC write requests to MonitorManager
// Throttling is now handled per-monitor in BrightnessStore
// Group by monitorId: different monitors process in parallel, same monitor cancels pending writes
subscriptions.push(
  brightnessStore.ddcWriteRequests$
    .pipe(
      groupBy(({ monitorId }) => monitorId),
      mergeMap((group$) =>
        group$.pipe(
          // switchMap ensures that if a new write comes in for the same monitor
          // while one is in progress, the old one is cancelled
          switchMap(({ monitorId, brightness }) => {
            const rawValue = brightnessStore.virtualToRaw(monitorId, brightness);
            return monitorManager.writeBrightness(monitorId, rawValue);
          })
        )
      )
    )
    .subscribe()
);

// Log and broadcast monitor changes to property inspectors
subscriptions.push(
  monitorManager.onMonitorsChanged$.subscribe((monitors) => {
    streamDeck.logger.info(`Monitors updated: ${monitors.map((m) => m.name).join(', ')}`);

    // Broadcast updated monitor list to all property inspectors
    void streamDeck.ui.sendToPropertyInspector({
      event: 'monitorList',
      monitors: monitors.map((m) => ({
        id: m.id,
        name: m.name,
        brightness: m.brightness,
        available: m.available,
      })),
    });
  })
);

// Log errors
subscriptions.push(
  monitorManager.onError$.subscribe(({ error, monitorId }) => {
    streamDeck.logger.warn(`Monitor error${monitorId ? ` (${monitorId})` : ''}: ${error.message}`);
  })
);

streamDeck.logger.info('[Plugin] Starting monitor manager initialization...');
monitorManager
  .initialize()
  .then(() => {
    const monitors = monitorManager.getMonitors();
    streamDeck.logger.info(
      `[Plugin] Monitor manager initialized successfully with ${monitors.length} monitors`
    );
    for (const m of monitors) {
      streamDeck.logger.info(
        `[Plugin] Monitor: id=${m.id}, name=${m.name}, brightness=${m.brightness}`
      );
    }
    monitorManager.startBrightnessPolling();
    // Start periodic refresh to detect monitors that initialize after boot
    monitorManager.startMonitorPolling();
  })
  .catch((err) => {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack : '';
    streamDeck.logger.error(`[Plugin] Failed to initialize monitor manager: ${errorMsg}`);
    streamDeck.logger.error(`[Plugin] Stack: ${errorStack}`);
  });

streamDeck.actions.registerAction(new BrightnessDialAction());
streamDeck.actions.registerAction(new BrightnessButtonAction());
void streamDeck.connect();

process.on('SIGTERM', () => {
  subscriptions.forEach((sub) => sub.unsubscribe());
  brightnessStore.dispose();
  monitorManager.dispose();
});
