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
  setImage(image: string): Promise<void>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendToPropertyInspector?(payload: any): Promise<void>;
}

@action({ UUID: 'co.raphii.streamdeck-display-brightness.button' })
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

  private getBrightnessIcon(): string {
    // Inline SVG icon (scaled down from 512x512 to fit in the button)
    const iconSize = 64;
    const scale = iconSize / 512;

    return `
      <g transform="translate(${72 - 256 * scale}, ${72 - 256 * scale}) scale(${scale})">
        <defs>
          <mask id="brightness-cutout">
            <rect width="512" height="512" fill="white"/>
            <g fill="black" transform="translate(256, 220)">
              <circle cx="0" cy="0" r="32" />
              <g stroke="black" stroke-width="14" stroke-linecap="round">
                <line x1="0" y1="-55" x2="0" y2="-75" />
                <line x1="38.89" y1="-38.89" x2="53.03" y2="-53.03" />
                <line x1="55" y1="0" x2="75" y2="0" />
                <line x1="38.89" y1="38.89" x2="53.03" y2="53.03" />
                <line x1="0" y1="55" x2="0" y2="75" />
                <line x1="-38.89" y1="38.89" x2="-53.03" y2="53.03" />
                <line x1="-55" y1="0" x2="-75" y2="0" />
                <line x1="-38.89" y1="-38.89" x2="-53.03" y2="-53.03" />
              </g>
            </g>
          </mask>
        </defs>
        <g fill="#ffffff" mask="url(#brightness-cutout)">
          <rect x="56" y="80" width="400" height="280" rx="30" />
          <rect x="226" y="360" width="60" height="25" />
          <rect x="156" y="385" width="200" height="30" rx="4" />
        </g>
      </g>
    `;
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

  private createBrightnessSvg(percentage: number): string {
    const size = 144;
    const percentageFontSize = 24;

    const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#000000" rx="0"/>

      <!-- Percentage at top -->
      <text x="${size / 2}" y="20" text-anchor="middle" dominant-baseline="hanging"
            font-family="Arial, sans-serif" font-size="${percentageFontSize}" font-weight="bold"
            fill="#ffffff">${percentage}%</text>

      <!-- Brightness icon in center -->
      ${this.getBrightnessIcon()}
    </svg>`;

    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }

  private async updateDisplayWithValue(
    ev: { action: KeyActionMethods; payload: { settings: BrightnessButtonSettings } },
    settings: BrightnessButtonSettings,
    brightness: number
  ): Promise<void> {
    const percentage = Math.round(brightness);
    const svg = this.createBrightnessSvg(percentage);
    await ev.action.setImage(svg);
  }
}
