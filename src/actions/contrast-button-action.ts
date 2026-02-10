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
import { ContrastStore } from '../services/contrast-store';

interface KeyActionMethods {
  id: string;
  setImage(image: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToPropertyInspector?(payload: any): Promise<void>;
}

@action({ UUID: 'co.raphii.streamdeck-display-brightness.contrast-button' })
export class ContrastButtonAction extends SingletonAction<BrightnessButtonSettings> {
  private monitorManager = MonitorManager.getInstance();
  private contrastStore = ContrastStore.getInstance();
  private subscriptions = new Map<string, Subscription>();
  private cycleIndices = new Map<string, number>();

  override async onWillAppear(ev: WillAppearEvent<BrightnessButtonSettings>): Promise<void> {
    const settings = ev.payload.settings;
    this.setupContrastSubscription(ev, settings);
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
    this.setupContrastSubscription(ev, settings);
    await this.updateDisplay(ev, settings);
  }

  override async onKeyDown(ev: KeyDownEvent<BrightnessButtonSettings>): Promise<void> {
    const settings = ev.payload.settings;
    const monitorIds = settings.selectedMonitors ?? [];

    if (monitorIds.length === 0) {
      return;
    }

    const currentContrast = await this.getCurrentContrast(monitorIds);
    const newContrast = this.calculateNewContrast(ev.action.id, settings, currentContrast);

    for (const monitorId of monitorIds) {
      this.contrastStore.setVirtualContrast(monitorId, newContrast);
    }
  }

  override async onSendToPlugin(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ev: SendToPluginEvent<any, BrightnessButtonSettings>
  ): Promise<void> {
    const payload = ev.payload as { event: string };

    if (payload.event === 'getMonitors' || payload.event === 'refreshMonitors') {
      streamDeck.logger.info(`[ContrastButtonAction] Received ${payload.event} request`);
      const monitors = this.monitorManager.getMonitors();
      streamDeck.logger.info(`[ContrastButtonAction] Cached monitors: ${monitors.length}`);

      streamDeck.logger.info(
        `[ContrastButtonAction] Sending monitorList to PI with ${monitors.length} monitors`
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
      streamDeck.logger.info('[ContrastButtonAction] monitorList sent to PI');
      return;
    }

    if (payload.event === 'exportMonitorDebugInfo') {
      streamDeck.logger.info('[ContrastButtonAction] Preparing monitor debug export payload');
      await streamDeck.ui.sendToPropertyInspector({
        event: 'monitorDebugInfo',
        debugText: this.monitorManager.getDebugInfoText(),
      });
      streamDeck.logger.info('[ContrastButtonAction] monitorDebugInfo sent to PI');
    }
  }

  private setupContrastSubscription(
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

    const subscription = this.contrastStore
      .getAverageVirtualContrast$(monitorIds)
      .subscribe((value) => {
        void this.updateDisplayWithValue(ev, settings, value);
      });

    this.subscriptions.set(contextId, subscription);
  }

  private async getCurrentContrast(monitorIds: string[]): Promise<number> {
    return new Promise((resolve) => {
      this.contrastStore
        .getAverageVirtualContrast$(monitorIds)
        .subscribe((value) => {
          resolve(value);
        })
        .unsubscribe();
    });
  }

  private calculateNewContrast(
    contextId: string,
    settings: BrightnessButtonSettings,
    currentContrast: number
  ): number {
    const mode = settings.operationMode ?? 'cycle';

    switch (mode) {
      case 'increase': {
        const stepSize = settings.stepSize ?? 10;
        return Math.min(100, currentContrast + stepSize);
      }

      case 'decrease': {
        const stepSize = settings.stepSize ?? 10;
        return Math.max(0, currentContrast - stepSize);
      }

      case 'set': {
        return settings.setValue ?? 100;
      }

      case 'toggle': {
        const value1 = settings.toggleValue1 ?? 0;
        const value2 = settings.toggleValue2 ?? 100;
        const dist1 = Math.abs(currentContrast - value1);
        const dist2 = Math.abs(currentContrast - value2);
        return dist1 > dist2 ? value1 : value2;
      }

      case 'cycle': {
        const values = settings.cycleValues ?? [0, 25, 50, 75, 100];
        if (values.length === 0) {
          return currentContrast;
        }

        let currentIndex = this.cycleIndices.get(contextId) ?? -1;
        currentIndex = (currentIndex + 1) % values.length;
        this.cycleIndices.set(contextId, currentIndex);

        return values[currentIndex];
      }

      default:
        return currentContrast;
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

    const value = await this.getCurrentContrast(monitorIds);
    await this.updateDisplayWithValue(ev, settings, value);
  }

  private async updateDisplayPlaceholder(ev: { action: KeyActionMethods }): Promise<void> {
    const size = 144;
    const fontSize = 20;
    const lineHeight = 24;

    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#000000" rx="0"/>
      <text x="${size / 2}" y="${size / 2 - lineHeight / 2}" text-anchor="middle" dominant-baseline="middle"
            font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="normal"
            fill="#888888">Select</text>
      <text x="${size / 2}" y="${size / 2 + lineHeight / 2}" text-anchor="middle" dominant-baseline="middle"
            font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="normal"
            fill="#888888">Monitor</text>
    </svg>`;

    const imageData = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await ev.action.setImage(imageData);
  }

  private createContrastSvg(percentage: number): string {
    const size = 144;
    const percentageFontSize = 24;
    const iconSize = 64;
    const scale = iconSize / 512;

    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#000000" rx="0"/>
      <text x="${size / 2}" y="20" text-anchor="middle" dominant-baseline="hanging"
            font-family="Arial, sans-serif" font-size="${percentageFontSize}" font-weight="bold"
            fill="#ffffff">${percentage}%</text>
      <g transform="translate(${72 - 256 * scale}, ${72 - 256 * scale}) scale(${scale})">
        <defs>
          <mask id="contrast-cutout">
            <rect width="512" height="512" fill="white"/>
            <g transform="translate(256, 220)">
              <circle cx="0" cy="0" r="66" fill="none" stroke="black" stroke-width="12"/>
              <path d="M 0 -60 A 60 60 0 0 0 0 60 Z" fill="black"/>
              <line x1="0" y1="-60" x2="0" y2="60" stroke="black" stroke-width="6" stroke-linecap="round"/>
            </g>
          </mask>
        </defs>
        <g fill="#ffffff" mask="url(#contrast-cutout)">
          <rect x="56" y="80" width="400" height="280" rx="30" />
          <rect x="226" y="360" width="60" height="25" />
          <rect x="156" y="385" width="200" height="30" rx="4" />
        </g>
      </g>
    </svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private async updateDisplayWithValue(
    ev: { action: KeyActionMethods; payload: { settings: BrightnessButtonSettings } },
    settings: BrightnessButtonSettings,
    contrast: number
  ): Promise<void> {
    const percentage = Math.round(contrast);
    const svg = this.createContrastSvg(percentage);
    await ev.action.setImage(svg);
  }
}
