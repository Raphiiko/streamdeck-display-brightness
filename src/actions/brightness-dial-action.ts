import streamDeck, {
  action,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  DialRotateEvent,
  DialDownEvent,
  DidReceiveSettingsEvent,
  SendToPluginEvent,
  TouchTapEvent,
} from '@elgato/streamdeck';
import { Subscription } from 'rxjs';
import { BrightnessSettings } from '../types/settings';
import { MonitorManager } from '../services/monitor-manager';
import { BrightnessStore } from '../services/brightness-store';

interface ActionInstanceMethods {
  id: string;
  showAlert(): Promise<void>;
  setFeedback?(settings: {
    title: string;
    value: string;
    indicator: { value: number };
  }): Promise<void>;
}

@action({ UUID: 'co.raphii.streamdeck-display-brightness.dial' })
export class BrightnessDialAction extends SingletonAction<BrightnessSettings> {
  private monitorManager = MonitorManager.getInstance();
  private brightnessStore = BrightnessStore.getInstance();
  // Map of action context ID to subscription - each dial needs its own subscription
  private brightnessSubscriptions = new Map<string, Subscription>();

  override async onWillAppear(ev: WillAppearEvent<BrightnessSettings>): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;

    // Subscribe to average brightness changes for selected monitors
    this.subscribeToBrightness(ev, selectedMonitors);
    await this.updateDisplay(ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<BrightnessSettings>): void {
    const contextId = ev.action.id;
    const subscription = this.brightnessSubscriptions.get(contextId);
    if (subscription) {
      subscription.unsubscribe();
      this.brightnessSubscriptions.delete(contextId);
    }
  }

  override async onDialRotate(ev: DialRotateEvent<BrightnessSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const { selectedMonitors = [], stepSize = 5 } = settings;

    if (selectedMonitors.length === 0) return;

    // Get current dial brightness (average of virtual brightness for selected monitors)
    const currentDialBrightness =
      this.brightnessStore.getAverageVirtualBrightness(selectedMonitors);

    // Calculate new brightness
    const delta = ev.payload.ticks * stepSize;
    const newBrightness = Math.max(0, Math.min(100, currentDialBrightness + delta));

    // Set virtual brightness for all selected monitors to the new value
    // This will:
    // 1. Update the store immediately (responsive UI)
    // 2. Mark the timestamp so polling won't overwrite for 3 seconds
    // 3. Emit to the throttled DDC write stream
    for (const monitorId of selectedMonitors) {
      this.brightnessStore.setVirtualBrightness(monitorId, newBrightness);
    }

    // Update display immediately with the new value
    await this.updateDisplayWithValue(ev, newBrightness);
  }

  override async onDialDown(ev: DialDownEvent<BrightnessSettings>): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    if (selectedMonitors.length === 0) return;

    const currentDialBrightness =
      this.brightnessStore.getAverageVirtualBrightness(selectedMonitors);
    const newBrightness = currentDialBrightness >= 100 ? 0 : 100;

    await this.setBrightnessForMonitors(ev, selectedMonitors, newBrightness);
  }

  override async onTouchTap(ev: TouchTapEvent<BrightnessSettings>): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    if (selectedMonitors.length === 0) return;

    const newBrightness = ev.payload.hold ? 0 : 100;
    await this.setBrightnessForMonitors(ev, selectedMonitors, newBrightness);
  }

  private async setBrightnessForMonitors(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    monitorIds: string[],
    brightness: number
  ): Promise<void> {
    for (const monitorId of monitorIds) {
      this.brightnessStore.setVirtualBrightness(monitorId, brightness);
    }
    await this.updateDisplayWithValue(ev, brightness);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<BrightnessSettings>
  ): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;

    // Re-subscribe with new monitor selection
    this.subscribeToBrightness(ev, selectedMonitors);
    await this.updateDisplay(ev);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override async onSendToPlugin(ev: SendToPluginEvent<any, BrightnessSettings>): Promise<void> {
    const payload = ev.payload as { event: string };
    streamDeck.logger.info(`[DialAction] onSendToPlugin received: ${JSON.stringify(payload)}`);

    switch (payload.event) {
      case 'getMonitors':
      case 'refreshMonitors': {
        streamDeck.logger.info(`[DialAction] Received ${payload.event} request`);
        const monitors = this.monitorManager.getMonitors();
        streamDeck.logger.info(`[DialAction] Cached monitors: ${monitors.length}`);

        streamDeck.logger.info(
          `[DialAction] Sending monitorList to PI with ${monitors.length} monitors`
        );
        await streamDeck.ui.sendToPropertyInspector({
          event: 'monitorList',
          monitors: monitors.map((m) => ({
            id: m.id,
            name: m.name,
            brightness: m.brightness,
            available: m.available,
          })),
        });
        streamDeck.logger.info('[DialAction] monitorList sent to PI');
        break;
      }
    }
  }

  private subscribeToBrightness(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    monitorIds: string[]
  ): void {
    const contextId = ev.action.id;

    // Clean up existing subscription for this specific dial
    const existingSubscription = this.brightnessSubscriptions.get(contextId);
    if (existingSubscription) {
      existingSubscription.unsubscribe();
      this.brightnessSubscriptions.delete(contextId);
    }

    if (monitorIds.length === 0) return;

    // Subscribe to average virtual brightness for the selected monitors
    const subscription = this.brightnessStore
      .getAverageVirtualBrightness$(monitorIds)
      .subscribe((avgBrightness) => {
        void this.updateDisplayWithValue(ev, avgBrightness);
      });

    this.brightnessSubscriptions.set(contextId, subscription);
  }

  private async updateDisplay(ev: {
    action: ActionInstanceMethods;
    payload: { settings: BrightnessSettings };
  }): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;

    if (selectedMonitors.length === 0) {
      await this.setFeedback(ev, 'Select Monitor', '--', 0);
      return;
    }

    const availableMonitors = selectedMonitors.filter((id) => {
      const monitor = this.monitorManager.getMonitors().find((m) => m.id === id);
      return monitor?.available;
    });

    if (availableMonitors.length === 0) {
      await this.setFeedback(ev, 'Unavailable', 'ERR', 0);
      await ev.action.showAlert();
      return;
    }

    const avgBrightness = this.brightnessStore.getAverageVirtualBrightness(selectedMonitors);
    await this.updateDisplayWithValue(ev, avgBrightness);
  }

  private async updateDisplayWithValue(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    brightness: number
  ): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;

    if (selectedMonitors.length === 0) {
      await this.setFeedback(ev, 'Select Monitor', '--', 0);
      return;
    }

    const displayName = this.getDisplayName(selectedMonitors);
    await this.setFeedback(ev, displayName, `${Math.round(brightness)}%`, brightness);
  }

  private async setFeedback(
    ev: { action: ActionInstanceMethods },
    title: string,
    value: string,
    indicator: number
  ): Promise<void> {
    if (ev.action.setFeedback) {
      await ev.action.setFeedback({
        title,
        value,
        indicator: { value: indicator },
      });
    }
  }

  private getDisplayName(selectedMonitors: string[]): string {
    if (selectedMonitors.length !== 1) {
      return `${selectedMonitors.length} Monitors`;
    }

    const monitorId = selectedMonitors[0];
    const monitor = this.monitorManager.getMonitors().find((m) => m.id === monitorId);
    if (monitor) {
      return monitor.name;
    }

    const match = monitorId.match(/DISPLAY(\d+)/i);
    return match ? `Display ${match[1]}` : monitorId;
  }
}
