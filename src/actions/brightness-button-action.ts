import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
  WillDisappearEvent,
  DidReceiveSettingsEvent,
  SendToPluginEvent,
} from '@elgato/streamdeck';
import { Subscription } from 'rxjs';
import { BrightnessButtonSettings } from '../types/settings';
import { MonitorManager } from '../services/monitor-manager';
import { BrightnessStore } from '../services/brightness-store';

interface KeyActionMethods {
  id: string;
  setTitle(title: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToPropertyInspector?(payload: any): Promise<void>;
}

@action({ UUID: 'com.raphiiko.sdbrightness.button' })
export class BrightnessButtonAction extends SingletonAction<BrightnessButtonSettings> {
  private monitorManager = MonitorManager.getInstance();
  private brightnessStore = BrightnessStore.getInstance();
  private subscriptions = new Map<string, Subscription>();
  private cycleIndices = new Map<string, number>();

  override async onWillAppear(ev: WillAppearEvent<BrightnessButtonSettings>): Promise<void> {
    const settings = ev.payload.settings;
    this.setupBrightnessSubscription(ev, settings);
    await this.updateDisplay(ev, settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<BrightnessButtonSettings>): void {
    const contextId = ev.action.id;
    const subscription = this.subscriptions.get(contextId);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(contextId);
    }
    this.cycleIndices.delete(contextId);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<BrightnessButtonSettings>
  ): Promise<void> {
    const settings = ev.payload.settings;
    this.setupBrightnessSubscription(ev, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<BrightnessButtonSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const monitorIds = settings.selectedMonitors ?? [];

    if (monitorIds.length === 0) {
      return;
    }

    const currentBrightness = await this.getCurrentBrightness(monitorIds);
    const newBrightness = this.calculateNewBrightness(ev.action.id, settings, currentBrightness);

    for (const monitorId of monitorIds) {
      this.brightnessStore.setVirtualBrightness(monitorId, newBrightness);
    }
  }

  override async onSendToPlugin(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ev: SendToPluginEvent<any, BrightnessButtonSettings>
  ): Promise<void> {
    const payload = ev.payload as { event: string };

    if (payload.event === 'getMonitors') {
      const monitors = this.monitorManager.getMonitors();
      await streamDeck.ui.sendToPropertyInspector({
        event: 'monitorList',
        monitors: monitors.map((m) => ({
          id: m.id,
          name: m.name,
          brightness: m.brightness,
          available: m.available,
        })),
      });
    } else if (payload.event === 'refreshMonitors') {
      await this.monitorManager.refreshMonitors();
    }
  }

  private setupBrightnessSubscription(
    ev: { action: KeyActionMethods; payload: { settings: BrightnessButtonSettings } },
    settings: BrightnessButtonSettings
  ): void {
    const contextId = ev.action.id;

    const existingSubscription = this.subscriptions.get(contextId);
    if (existingSubscription) {
      existingSubscription.unsubscribe();
      this.subscriptions.delete(contextId);
    }

    const monitorIds = settings.selectedMonitors ?? [];

    if (monitorIds.length === 0) {
      void this.updateDisplayPlaceholder(ev);
      return;
    }

    const subscription = this.brightnessStore
      .getAverageVirtualBrightness$(monitorIds)
      .subscribe((brightness) => {
        void this.updateDisplayWithValue(ev, settings, brightness);
      });

    this.subscriptions.set(contextId, subscription);
  }

  private async getCurrentBrightness(monitorIds: string[]): Promise<number> {
    return new Promise((resolve) => {
      this.brightnessStore
        .getAverageVirtualBrightness$(monitorIds)
        .subscribe((brightness) => {
          resolve(brightness);
        })
        .unsubscribe();
    });
  }

  private calculateNewBrightness(
    contextId: string,
    settings: BrightnessButtonSettings,
    currentBrightness: number
  ): number {
    const mode = settings.operationMode ?? 'increase';

    switch (mode) {
      case 'increase': {
        const stepSize = settings.stepSize ?? 10;
        return Math.min(100, currentBrightness + stepSize);
      }

      case 'decrease': {
        const stepSize = settings.stepSize ?? 10;
        return Math.max(0, currentBrightness - stepSize);
      }

      case 'set': {
        return settings.setValue ?? 100;
      }

      case 'toggle': {
        const value1 = settings.toggleValue1 ?? 0;
        const value2 = settings.toggleValue2 ?? 100;
        const dist1 = Math.abs(currentBrightness - value1);
        const dist2 = Math.abs(currentBrightness - value2);
        return dist1 > dist2 ? value1 : value2;
      }

      case 'cycle': {
        const values = settings.cycleValues ?? [0, 25, 50, 75, 100];
        if (values.length === 0) {
          return currentBrightness;
        }

        let currentIndex = this.cycleIndices.get(contextId) ?? -1;
        currentIndex = (currentIndex + 1) % values.length;
        this.cycleIndices.set(contextId, currentIndex);

        return values[currentIndex];
      }

      default:
        return currentBrightness;
    }
  }

  private async updateDisplay(
    ev: { action: KeyActionMethods; payload: { settings: BrightnessButtonSettings } },
    settings: BrightnessButtonSettings
  ): Promise<void> {
    const monitorIds = settings.selectedMonitors ?? [];

    if (monitorIds.length === 0) {
      await this.updateDisplayPlaceholder(ev);
      return;
    }

    const brightness = await this.getCurrentBrightness(monitorIds);
    await this.updateDisplayWithValue(ev, settings, brightness);
  }

  private async updateDisplayPlaceholder(ev: { action: KeyActionMethods }): Promise<void> {
    await ev.action.setTitle('Select\nMonitor');
  }

  private async updateDisplayWithValue(
    ev: { action: KeyActionMethods; payload: { settings: BrightnessButtonSettings } },
    settings: BrightnessButtonSettings,
    brightness: number
  ): Promise<void> {
    const percentage = Math.round(brightness);
    await ev.action.setTitle(`${percentage}%`);
  }
}
