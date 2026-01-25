import streamDeck from '@elgato/streamdeck';
import {
  DisplayManager,
  VCPFeatureCode,
  VcpValueType,
  type Continuous,
  type NonContinuous,
  type Table,
  type Display,
} from '@ddc-node/ddc-node';
import { Subject, Observable, interval, from, EMPTY, Subscription, defer } from 'rxjs';
import { tap, finalize } from 'rxjs/operators';

import { DEFAULT_POLL_INTERVAL_MS } from '../globals.js';
import { MonitorInfo } from '../types/settings.js';

type VCPFeature = Continuous | NonContinuous | Table;

function isContinuousFeature(feature: VCPFeature): feature is Continuous {
  return feature.type === VcpValueType.Continuous;
}

function getFeatureValue(feature: VCPFeature): number | null {
  if ('currentValue' in feature) {
    return feature.currentValue;
  }
  return null;
}

function getFeatureMaxValue(feature: VCPFeature): number {
  if (isContinuousFeature(feature)) {
    return feature.maximumValue;
  }
  return 100;
}

export interface MonitorPollResult {
  monitorId: string;
  brightness: number;
  maxBrightness: number;
}

export class MonitorManager {
  private static instance: MonitorManager;
  private monitors: Map<string, MonitorInfo> = new Map();
  private displays: Map<string, Display> = new Map();
  private displayManager: DisplayManager;

  // Configurable timing
  private pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;

  // Observables
  private pollResults$ = new Subject<MonitorPollResult>();
  private monitorsChanged$ = new Subject<MonitorInfo[]>();
  private errors$ = new Subject<{ error: Error; monitorId?: string }>();

  // Polling
  private pollSubscription: Subscription | null = null;
  private isRefreshing = false;
  private ddcLocks = new Map<string, boolean>();

  static getInstance(): MonitorManager {
    if (!MonitorManager.instance) {
      MonitorManager.instance = new MonitorManager();
    }
    return MonitorManager.instance;
  }

  private constructor() {
    this.displayManager = new DisplayManager();
  }

  /**
   * Configure timing settings
   */
  configure(options: { pollIntervalMs?: number }): void {
    if (options.pollIntervalMs !== undefined) {
      this.pollIntervalMs = Math.max(10, Math.min(5000, options.pollIntervalMs));
      // Restart polling if already running to apply new interval
      if (this.pollSubscription) {
        this.stopPolling();
        this.startPolling();
      }
    }
  }

  /**
   * Observable that emits whenever a monitor's real brightness is polled
   */
  get onPollResult$(): Observable<MonitorPollResult> {
    return this.pollResults$.asObservable();
  }

  /**
   * Observable that emits whenever the monitor list changes
   */
  get onMonitorsChanged$(): Observable<MonitorInfo[]> {
    return this.monitorsChanged$.asObservable();
  }

  /**
   * Observable for errors
   */
  get onError$(): Observable<{ error: Error; monitorId?: string }> {
    return this.errors$.asObservable();
  }

  private acquireLock(monitorId?: string): boolean {
    // Global lock check: ensure no monitors are locked
    if (monitorId === undefined) {
      return this.ddcLocks.size === 0 || ![...this.ddcLocks.values()].some(Boolean);
    }
    // Per-monitor lock
    if (this.ddcLocks.get(monitorId)) return false;
    this.ddcLocks.set(monitorId, true);
    return true;
  }

  private releaseLock(monitorId?: string): void {
    if (monitorId === undefined) {
      this.ddcLocks.clear();
    } else {
      this.ddcLocks.delete(monitorId);
    }
  }

  async initialize(): Promise<void> {
    try {
      await this.refreshMonitors();
    } catch (err) {
      this.errors$.next({ error: err as Error });
    }
  }

  async refreshMonitors(): Promise<MonitorInfo[]> {
    if (this.isRefreshing) {
      streamDeck.logger.debug('Refresh already in progress, skipping');
      return this.getMonitors();
    }

    // Wait for all locks
    while (this.ddcLocks.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (!this.acquireLock()) {
      return this.getMonitors();
    }

    this.isRefreshing = true;
    streamDeck.logger.info('Starting monitor refresh...');

    try {
      const displays = await this.displayManager.collect();
      streamDeck.logger.info(`Found ${displays.length} display(s)`);

      // Clear old caches
      this.displays.clear();
      const newMonitors: MonitorInfo[] = [];

      for (const display of displays) {
        const monitorId = display.index.toString();
        this.displays.set(monitorId, display);

        let brightness = 100;
        let maxBrightness = 100;

        try {
          streamDeck.logger.debug(`Querying display ${monitorId}...`);
          const feature = await display.getVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance);

          const value = getFeatureValue(feature);
          if (value !== null) {
            brightness = value;
            maxBrightness = getFeatureMaxValue(feature);
            streamDeck.logger.debug(
              `Display ${monitorId}: brightness=${brightness}, max=${maxBrightness}`
            );
          } else {
            streamDeck.logger.warn(`Display ${monitorId}: could not read brightness value`);
            continue;
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          streamDeck.logger.warn(`Display ${monitorId} DDC error: ${errorMsg}`);
          continue;
        }

        const monitor: MonitorInfo = {
          id: monitorId,
          name: this.getDisplayName(display, monitorId),
          brightness,
          maxBrightness,
          available: true,
        };

        this.monitors.set(monitorId, monitor);
        newMonitors.push(monitor);

        // Emit poll result for initial brightness
        this.pollResults$.next({
          monitorId,
          brightness,
          maxBrightness,
        });
      }

      streamDeck.logger.info(
        `Successfully detected ${newMonitors.length} DDC-compatible monitor(s)`
      );

      if (newMonitors.length > 0) {
        this.monitorsChanged$.next(newMonitors);
      }

      return newMonitors;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      streamDeck.logger.error(`Error refreshing monitors: ${errorMsg}`);
      this.errors$.next({ error: err as Error });
      return [];
    } finally {
      this.isRefreshing = false;
      this.releaseLock();
    }
  }

  getMonitors(): MonitorInfo[] {
    return Array.from(this.monitors.values());
  }

  /**
   * Write brightness to a monitor via DDC.
   * Value should be in raw DDC units (not 0-100 normalized).
   * Returns an Observable that can be cancelled via switchMap/takeUntil.
   */
  writeBrightness(monitorId: string, rawValue: number): Observable<void> {
    return defer(() => {
      const clampedValue = Math.round(Math.max(0, rawValue));

      if (!this.acquireLock(monitorId)) {
        return EMPTY;
      }

      const display = this.displays.get(monitorId);
      if (!display) {
        streamDeck.logger.warn(`Display ${monitorId} not found in cache`);
        this.releaseLock(monitorId);
        return EMPTY;
      }

      streamDeck.logger.debug(`Writing brightness for ${monitorId}: ${clampedValue}`);
      return from(
        display.setVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance, clampedValue)
      ).pipe(
        tap({
          next: () => {
            streamDeck.logger.debug(
              `Successfully wrote brightness for ${monitorId}: ${clampedValue}`
            );
            const cached = this.monitors.get(monitorId);
            if (cached) {
              cached.brightness = clampedValue;
            }
          },
          error: (err) => {
            const errorMsg = err instanceof Error ? err.message : String(err);
            streamDeck.logger.error(`Error writing brightness for ${monitorId}: ${errorMsg}`);
            this.errors$.next({ error: err as Error, monitorId });
          },
        }),
        finalize(() => {
          this.releaseLock(monitorId);
        })
      );
    });
  }

  startPolling(): void {
    if (this.pollSubscription) return;

    streamDeck.logger.info(`Starting brightness polling every ${this.pollIntervalMs}ms`);

    this.pollSubscription = interval(this.pollIntervalMs).subscribe(() => {
      void this.pollMonitors();
    });
  }

  stopPolling(): void {
    if (this.pollSubscription) {
      this.pollSubscription.unsubscribe();
      this.pollSubscription = null;
      streamDeck.logger.info('Stopped brightness polling');
    }
  }

  private async pollMonitors(): Promise<void> {
    if (this.isRefreshing || !this.acquireLock()) {
      return;
    }

    try {
      for (const [monitorId, display] of this.displays) {
        // Skip if monitor is locked by write operation
        if (this.ddcLocks.get(monitorId)) {
          continue;
        }

        const cached = this.monitors.get(monitorId);
        if (!cached) continue;

        try {
          const feature = await display.getVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance);
          const value = getFeatureValue(feature);
          const maxValue = getFeatureMaxValue(feature);

          if (value !== null) {
            cached.brightness = value;
            cached.maxBrightness = maxValue;
            cached.available = true;

            // Emit poll result
            this.pollResults$.next({
              monitorId,
              brightness: value,
              maxBrightness: maxValue,
            });
          }
        } catch {
          if (cached.available) {
            cached.available = false;
            streamDeck.logger.warn(`Display ${monitorId} became unavailable during poll`);
          }
        }
      }
    } catch (err) {
      streamDeck.logger.debug('Error during poll:', err);
    } finally {
      this.releaseLock();
    }
  }

  dispose(): void {
    this.stopPolling();
    this.monitors.clear();
    this.displays.clear();
    this.pollResults$.complete();
    this.monitorsChanged$.complete();
    this.errors$.complete();
  }

  private getDisplayName(
    display: { modelName?: string; manufacturerId?: string; index: number },
    monitorId: string
  ): string {
    const components = [];
    if (display.manufacturerId) components.push(display.manufacturerId);
    if (display.modelName) components.push(display.modelName);
    else components.push(`Display ${monitorId}`);
    return components.join(' ');
  }
}
