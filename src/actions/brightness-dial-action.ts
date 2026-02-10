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
import { Observable, Subscription } from 'rxjs';
import { BrightnessSettings } from '../types/settings';
import { MonitorManager } from '../services/monitor-manager';
import { BrightnessStore } from '../services/brightness-store';
import { ContrastStore } from '../services/contrast-store';

type ControlMode = 'brightness' | 'contrast';

interface ActionInstanceMethods {
  id: string;
  showAlert(): Promise<void>;
  setSettings?(settings: BrightnessSettings): Promise<void>;
  setFeedback?(settings: Record<string, unknown>): Promise<void>;
  setFeedbackLayout?(layout: string): Promise<void>;
}

@action({ UUID: 'co.raphii.streamdeck-display-brightness.dial' })
export class BrightnessDialAction extends SingletonAction<BrightnessSettings> {
  private static readonly DIAL_LAYOUT_PATH = 'layouts/dial-control.json';
  private static readonly BRIGHTNESS_ICON_PATH = 'imgs/actions/brightness/icon.png';
  private static readonly CONTRAST_ICON_PATH = 'imgs/actions/contrast/icon.png';

  private monitorManager = MonitorManager.getInstance();
  private brightnessStore = BrightnessStore.getInstance();
  private contrastStore = ContrastStore.getInstance();
  private subscriptions = new Map<string, Subscription>();
  private contextsWithCustomLayout = new Set<string>();

  override async onWillAppear(ev: WillAppearEvent<BrightnessSettings>): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    this.subscribeToActiveControl(ev, selectedMonitors);
    await this.updateDisplay(ev);
  }

  override onWillDisappear(ev: WillDisappearEvent<BrightnessSettings>): void {
    const contextId = ev.action.id;
    const subscription = this.subscriptions.get(contextId);
    if (subscription) {
      subscription.unsubscribe();
      this.subscriptions.delete(contextId);
    }
    this.contextsWithCustomLayout.delete(contextId);
  }

  override async onDialRotate(ev: DialRotateEvent<BrightnessSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const { selectedMonitors = [], stepSize = 5 } = settings;
    const mode = this.getControlMode(settings);

    if (selectedMonitors.length === 0) return;

    const currentValue = this.getAverageControlValue(mode, selectedMonitors);
    const delta = ev.payload.ticks * stepSize;
    const newValue = Math.max(0, Math.min(100, currentValue + delta));

    for (const monitorId of selectedMonitors) {
      this.setVirtualControlValue(mode, monitorId, newValue);
    }

    await this.updateDisplayWithValue(ev, newValue, mode);
  }

  override async onDialDown(ev: DialDownEvent<BrightnessSettings>): Promise<void> {
    const nextMode: ControlMode =
      this.getControlMode(ev.payload.settings) === 'brightness' ? 'contrast' : 'brightness';
    const nextSettings: BrightnessSettings = { ...ev.payload.settings, controlMode: nextMode };

    await ev.action.setSettings?.(nextSettings);

    const selectedMonitors = nextSettings.selectedMonitors ?? [];
    this.subscribeToActiveControl(
      {
        action: ev.action,
        payload: { settings: nextSettings },
      },
      selectedMonitors
    );

    if (selectedMonitors.length === 0) {
      await this.updateDisplay({ action: ev.action, payload: { settings: nextSettings } });
      return;
    }

    const currentValue = this.getAverageControlValue(nextMode, selectedMonitors);
    await this.updateDisplayWithValue(
      { action: ev.action, payload: { settings: nextSettings } },
      currentValue,
      nextMode
    );
  }

  override async onTouchTap(ev: TouchTapEvent<BrightnessSettings>): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    if (selectedMonitors.length === 0) return;

    const mode = this.getControlMode(ev.payload.settings);
    const newValue = ev.payload.hold ? 0 : 100;
    await this.setControlForMonitors(ev, selectedMonitors, newValue, mode);
  }

  override async onDidReceiveSettings(
    ev: DidReceiveSettingsEvent<BrightnessSettings>
  ): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    this.subscribeToActiveControl(ev, selectedMonitors);
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
            backend: m.backend,
            runtimeIndex: m.runtimeIndex,
            serialNumber: m.serialNumber,
            modelName: m.modelName,
            manufacturerId: m.manufacturerId,
          })),
        });
        streamDeck.logger.info('[DialAction] monitorList sent to PI');
        break;
      }
      case 'exportMonitorDebugInfo': {
        streamDeck.logger.info('[DialAction] Preparing monitor debug export payload');
        await streamDeck.ui.sendToPropertyInspector({
          event: 'monitorDebugInfo',
          debugText: this.monitorManager.getDebugInfoText(),
        });
        streamDeck.logger.info('[DialAction] monitorDebugInfo sent to PI');
        break;
      }
    }
  }

  private async setControlForMonitors(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    monitorIds: string[],
    value: number,
    mode: ControlMode
  ): Promise<void> {
    for (const monitorId of monitorIds) {
      this.setVirtualControlValue(mode, monitorId, value);
    }
    await this.updateDisplayWithValue(ev, value, mode);
  }

  private subscribeToActiveControl(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    monitorIds: string[]
  ): void {
    const contextId = ev.action.id;

    const existingSubscription = this.subscriptions.get(contextId);
    if (existingSubscription) {
      existingSubscription.unsubscribe();
      this.subscriptions.delete(contextId);
    }

    if (monitorIds.length === 0) return;

    const mode = this.getControlMode(ev.payload.settings);
    const subscription = this.getAverageControlValue$(mode, monitorIds).subscribe((avgValue) => {
      void this.updateDisplayWithValue(ev, avgValue, mode);
    });

    this.subscriptions.set(contextId, subscription);
  }

  private getControlMode(settings: BrightnessSettings): ControlMode {
    return settings.controlMode === 'contrast' ? 'contrast' : 'brightness';
  }

  private getAverageControlValue(mode: ControlMode, monitorIds: string[]): number {
    if (mode === 'contrast') {
      return this.contrastStore.getAverageVirtualContrast(monitorIds);
    }
    return this.brightnessStore.getAverageVirtualBrightness(monitorIds);
  }

  private getAverageControlValue$(mode: ControlMode, monitorIds: string[]): Observable<number> {
    if (mode === 'contrast') {
      return this.contrastStore.getAverageVirtualContrast$(monitorIds);
    }
    return this.brightnessStore.getAverageVirtualBrightness$(monitorIds);
  }

  private setVirtualControlValue(mode: ControlMode, monitorId: string, value: number): void {
    if (mode === 'contrast') {
      this.contrastStore.setVirtualContrast(monitorId, value);
      return;
    }
    this.brightnessStore.setVirtualBrightness(monitorId, value);
  }

  private async updateDisplay(ev: {
    action: ActionInstanceMethods;
    payload: { settings: BrightnessSettings };
  }): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;
    const mode = this.getControlMode(ev.payload.settings);

    if (selectedMonitors.length === 0) {
      await this.setFeedback(ev, 'Select Monitor', this.getModeLabel(mode), 0, mode);
      return;
    }

    const availableMonitors = selectedMonitors.filter((id) => {
      const monitor = this.monitorManager.getMonitors().find((m) => m.id === id);
      return monitor?.available;
    });

    if (availableMonitors.length === 0) {
      await this.setFeedback(ev, 'Unavailable', 'ERR', 0, mode);
      await ev.action.showAlert();
      return;
    }

    const avgValue = this.getAverageControlValue(mode, selectedMonitors);
    await this.updateDisplayWithValue(ev, avgValue, mode);
  }

  private async updateDisplayWithValue(
    ev: { action: ActionInstanceMethods; payload: { settings: BrightnessSettings } },
    value: number,
    mode: ControlMode
  ): Promise<void> {
    const { selectedMonitors = [] } = ev.payload.settings;

    if (selectedMonitors.length === 0) {
      await this.setFeedback(ev, 'Select Monitor', this.getModeLabel(mode), 0, mode);
      return;
    }

    const displayName = this.getDisplayName(selectedMonitors);
    const modeValueSuffix = mode === 'contrast' ? 'CT' : 'BR';
    await this.setFeedback(
      ev,
      displayName,
      `${Math.round(value)}% ${modeValueSuffix}`,
      value,
      mode
    );
  }

  private getModeLabel(mode: ControlMode): string {
    return mode === 'contrast' ? 'Contrast' : 'Brightness';
  }

  private async setFeedback(
    ev: { action: ActionInstanceMethods },
    title: string,
    value: string,
    indicator: number,
    mode: ControlMode
  ): Promise<void> {
    await this.ensureDialLayout(ev.action);

    if (ev.action.setFeedback) {
      await ev.action.setFeedback({
        icon: this.getModeIconPath(mode),
        title,
        value,
        indicator: { value: indicator },
      });
    }
  }

  private async ensureDialLayout(action: ActionInstanceMethods): Promise<void> {
    if (!action.setFeedbackLayout) {
      return;
    }

    if (this.contextsWithCustomLayout.has(action.id)) {
      return;
    }

    await action.setFeedbackLayout(BrightnessDialAction.DIAL_LAYOUT_PATH);
    this.contextsWithCustomLayout.add(action.id);
  }

  private getModeIconPath(mode: ControlMode): string {
    return mode === 'contrast'
      ? BrightnessDialAction.CONTRAST_ICON_PATH
      : BrightnessDialAction.BRIGHTNESS_ICON_PATH;
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
