import streamDeck from '@elgato/streamdeck';
import {
  DisplayManager,
  VCPFeatureCode,
  VcpValueType,
  type Continuous,
  type NonContinuous,
  type Table,
  type Display,
} from '@raphiiko/ddc-node';
import {
  Subject,
  Observable,
  interval,
  from,
  EMPTY,
  Subscription,
  defer,
  BehaviorSubject,
  shareReplay,
  take,
  timer,
} from 'rxjs';
import { tap, finalize, exhaustMap } from 'rxjs/operators';

import {
  DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS,
  DEFAULT_MONITOR_POLL_INTERVAL_MS,
} from '../globals.js';
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

/**
 * Check if displayId from ddc-hi v0.5.x contains a stable Windows identifier.
 * Stable IDs start with prefixes like:
 * - "si:iid:" (SetupAPI Device Instance ID)
 * - "si:hw:" (SetupAPI Hardware ID)
 * - "mon:" (Monitor device ID)
 * - "displayid:" (NvAPI display ID)
 *
 * Unstable IDs are:
 * - "Generic PnP Monitor" (old WinAPI fallback)
 * - "index:" prefixed IDs
 * - "hmoni:" prefixed IDs (HMONITOR index-based)
 */
function isDisplayIdStable(displayId: string): boolean {
  const stablePrefixes = ['si:iid:', 'si:hw:', 'mon:', 'displayid:'];
  const unstablePatterns = ['Generic PnP Monitor', 'index:', 'hmoni:'];

  // Check for unstable patterns first
  if (unstablePatterns.some((pattern) => displayId.includes(pattern))) {
    return false;
  }

  // Check for stable prefixes
  return stablePrefixes.some((prefix) => displayId.startsWith(prefix));
}

/**
 * Generate a stable identifier for a display based on available data.
 * Priority: ddc-hi displayId (if stable) > serialNumber > EDID-derived > composite key > fallback
 */
function generateStableId(display: Display): string {
  // Best case: ddc-hi v0.5.x provides a stable displayId from Windows SetupAPI
  if (display.displayId && isDisplayIdStable(display.displayId)) {
    return display.displayId;
  }

  // Second: human-readable serial number is unique and stable
  if (display.serialNumber) {
    return `serial:${display.serialNumber}`;
  }

  // Third: combine manufacturer, model, and numeric serial
  if (display.manufacturerId && display.modelName && display.serial) {
    return `composite:${display.manufacturerId}:${display.modelName}:${display.serial}`;
  }

  // Fourth: EDID hash if available (EDID contains unique monitor data)
  if (display.edidData && display.edidData.length > 0) {
    // Use first 18 bytes which contain manufacturer, product code, serial
    const edidHeader = Array.from(display.edidData.slice(0, 18))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return `edid:${edidHeader}`;
  }

  // Fifth: composite without serial
  if (display.manufacturerId && display.modelName) {
    return `composite:${display.manufacturerId}:${display.modelName}`;
  }

  // Fallback: use backend and displayId (less stable but better than just index)
  // This can still happen if ddc-hi couldn't get SetupAPI data
  return `fallback:${display.backend}:${display.displayId}:${display.index}`;
}

/**
 * Check if a stable ID is truly stable (not index-based fallback)
 */
function isStableId(id: string): boolean {
  // IDs are stable if they don't start with 'fallback:' and don't contain index-based patterns
  if (id.startsWith('fallback:')) {
    return false;
  }
  // Also check if it's one of the known stable ddc-hi prefixes or our own stable prefixes
  const stablePatterns = [
    'si:iid:',
    'si:hw:',
    'mon:',
    'displayid:',
    'serial:',
    'composite:',
    'edid:',
  ];
  return stablePatterns.some((pattern) => id.startsWith(pattern));
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
  // Map from stable ID to runtime index for quick lookups
  private idToIndex: Map<string, number> = new Map();
  private displayManager: DisplayManager;

  // Configurable timing
  private brightnessPollIntervalMs = DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS;
  private monitorPollIntervalMs = DEFAULT_MONITOR_POLL_INTERVAL_MS;

  // Observables
  private pollResults$ = new Subject<MonitorPollResult>();
  private monitorsChanged$ = new Subject<MonitorInfo[]>();
  private errors$ = new Subject<{ error: Error; monitorId?: string }>();

  // Polling and refresh
  private brightnessPollSub: Subscription | null = null;
  private monitorPollSub: Subscription | null = null;
  private ddcLocks = new Map<string, boolean>();
  private lastMonitorRefreshAt: number | null = null;

  // Observable-based refresh with replay for late subscribers
  private refreshInProgress$ = new BehaviorSubject<boolean>(false);
  private currentRefresh$: Observable<MonitorInfo[]> | null = null;

  static getInstance(): MonitorManager {
    if (!MonitorManager.instance) {
      MonitorManager.instance = new MonitorManager();
    }
    return MonitorManager.instance;
  }

  private constructor() {
    this.displayManager = new DisplayManager();
  }

  private getMonitorPollTimeoutMs(): number {
    return Math.max(0, this.monitorPollIntervalMs - 500);
  }

  /**
   * Configure timing settings
   */
  configure(options: { brightnessPollIntervalMs?: number; monitorPollIntervalMs?: number }): void {
    if (options.brightnessPollIntervalMs !== undefined) {
      this.brightnessPollIntervalMs = Math.max(
        10,
        Math.min(5000, options.brightnessPollIntervalMs)
      );
      // Restart polling if already running to apply new interval
      if (this.brightnessPollSub) {
        this.stopBrightnessPolling();
        this.startBrightnessPolling();
      }
    }
    if (options.monitorPollIntervalMs !== undefined) {
      this.monitorPollIntervalMs = Math.max(5000, Math.min(60000, options.monitorPollIntervalMs));
      // Restart refresh interval if already running
      if (this.monitorPollSub) {
        this.stopMonitorPolling();
        this.startMonitorPolling();
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

  /**
   * Observable that emits true when refresh is in progress
   */
  get isRefreshing$(): Observable<boolean> {
    return this.refreshInProgress$.asObservable();
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
      // Do initial refresh synchronously
      await this.refreshMonitorsInternal(this.getMonitorPollTimeoutMs());
    } catch (err) {
      this.errors$.next({ error: err as Error });
    }
  }

  /**
   * Refresh monitors - returns an Observable that completes when refresh is done.
   * Multiple calls while a refresh is in progress will share the same Observable.
   * This ensures only one refresh happens at a time.
   */
  refreshMonitors(options: { timeoutMs?: number } = {}): Observable<MonitorInfo[]> {
    // If refresh is already in progress, return the existing observable
    if (this.currentRefresh$) {
      streamDeck.logger.debug('Refresh already in progress, returning existing observable');
      return this.currentRefresh$;
    }

    // Create new refresh observable
    this.currentRefresh$ = defer(() => from(this.refreshMonitorsInternal(options.timeoutMs))).pipe(
      shareReplay(1),
      take(1)
    );

    return this.currentRefresh$;
  }

  /**
   * Internal refresh implementation
   */
  private async refreshMonitorsInternal(timeoutMs?: number): Promise<MonitorInfo[]> {
    streamDeck.logger.info('[MonitorManager] refreshMonitorsInternal called');

    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null;
    const buildTimeoutError = (label: string, ms: number): Error => {
      const err = new Error(`[MonitorManager] ${label} timed out after ${ms}ms`);
      err.name = 'MonitorRefreshTimeout';
      return err;
    };
    const isTimeoutError = (err: unknown): boolean =>
      err instanceof Error && err.name === 'MonitorRefreshTimeout';
    const runWithTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => {
      if (deadline === null) {
        return promise;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw buildTimeoutError(`Monitor refresh (${label})`, 0);
      }

      return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(buildTimeoutError(label, remainingMs));
        }, remainingMs);

        promise
          .then((value) => {
            clearTimeout(timeoutId);
            resolve(value);
          })
          .catch((err) => {
            clearTimeout(timeoutId);
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    };

    let didAcquireLock = false;

    try {
      // Wait for all locks
      while (this.ddcLocks.size > 0) {
        if (deadline !== null && Date.now() >= deadline) {
          throw new Error('[MonitorManager] Monitor refresh timed out waiting for DDC locks');
        }

        streamDeck.logger.debug(
          `[MonitorManager] Waiting for ${this.ddcLocks.size} locks to release...`
        );
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (!this.acquireLock()) {
        streamDeck.logger.warn(
          '[MonitorManager] Could not acquire lock, returning cached monitors'
        );
        return this.getMonitors();
      }

      didAcquireLock = true;
      this.lastMonitorRefreshAt = Date.now();
      this.refreshInProgress$.next(true);
      streamDeck.logger.info('[MonitorManager] Starting monitor refresh...');

      streamDeck.logger.info('[MonitorManager] Calling displayManager.collect()...');
      const displays = await runWithTimeout(
        this.displayManager.collect(),
        'displayManager.collect()'
      );
      streamDeck.logger.info(
        `[MonitorManager] displayManager.collect() returned ${displays.length} display(s)`
      );

      // Log details about each display found
      for (const display of displays) {
        streamDeck.logger.info(
          `[MonitorManager] Display ${display.index}: backend=${display.backend}, modelName=${display.modelName}, manufacturerId=${display.manufacturerId}, displayId=${display.displayId}`
        );
      }

      // Query VCP features in parallel for all displays
      streamDeck.logger.info('[MonitorManager] Querying VCP features for all displays...');
      const displayResults = await Promise.allSettled(
        displays.map(async (display) => {
          const stableId = generateStableId(display);
          streamDeck.logger.info(
            `[MonitorManager] Display ${display.index}: generated stableId=${stableId}`
          );

          try {
            streamDeck.logger.info(
              `[MonitorManager] Display ${display.index}: calling getVcpFeature(Luminance)...`
            );
            const feature = await runWithTimeout(
              display.getVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance),
              `getVcpFeature(${display.index})`
            );
            streamDeck.logger.info(
              `[MonitorManager] Display ${display.index}: getVcpFeature returned type=${feature.type}`
            );

            const value = getFeatureValue(feature);
            const maxValue = getFeatureMaxValue(feature);
            streamDeck.logger.info(
              `[MonitorManager] Display ${display.index}: brightness value=${value}, max=${maxValue}`
            );

            if (value !== null) {
              return {
                display,
                stableId,
                brightness: value,
                maxBrightness: maxValue,
                success: true as const,
              };
            } else {
              streamDeck.logger.warn(
                `[MonitorManager] Display ${display.index}: could not read brightness value (value is null)`
              );
              return { display, stableId, success: false as const };
            }
          } catch (err) {
            if (isTimeoutError(err)) {
              throw err;
            }
            const errorMsg = err instanceof Error ? err.message : String(err);
            const errorStack = err instanceof Error ? err.stack : '';
            streamDeck.logger.error(
              `[MonitorManager] Display ${display.index} DDC error: ${errorMsg}`
            );
            streamDeck.logger.error(
              `[MonitorManager] Display ${display.index} DDC error stack: ${errorStack}`
            );
            return { display, stableId, success: false as const };
          }
        })
      );

      const timeoutResult = displayResults.find(
        (result) => result.status === 'rejected' && isTimeoutError(result.reason)
      );
      if (timeoutResult && timeoutResult.status === 'rejected') {
        throw timeoutResult.reason;
      }

      // Process results
      streamDeck.logger.info(
        `[MonitorManager] Processing ${displayResults.length} display results...`
      );
      const newMonitors: MonitorInfo[] = [];
      const newDisplays = new Map<string, Display>();
      const newIdToIndex = new Map<string, number>();

      for (let i = 0; i < displayResults.length; i++) {
        const result = displayResults[i];
        streamDeck.logger.info(`[MonitorManager] Result ${i}: status=${result.status}`);

        if (result.status === 'rejected') {
          streamDeck.logger.warn(
            `[MonitorManager] Result ${i}: rejected with reason=${result.reason}`
          );
          continue;
        }

        const { display, stableId, success } = result.value;
        streamDeck.logger.info(
          `[MonitorManager] Result ${i}: success=${success}, stableId=${stableId}`
        );

        if (!success || !('brightness' in result.value)) {
          streamDeck.logger.info(
            `[MonitorManager] Result ${i}: skipping (success=${success}, hasBrightness=${'brightness' in result.value})`
          );
          continue;
        }

        const { brightness, maxBrightness } = result.value;

        // Store display by stable ID
        newDisplays.set(stableId, display);
        newIdToIndex.set(stableId, display.index);

        const isStable = isStableId(stableId);
        if (!isStable) {
          streamDeck.logger.warn(
            `Display ${display.index} has unstable ID (${stableId}). ` +
              `This monitor may not be reliably identified after reboot.`
          );
        }

        const monitor: MonitorInfo = {
          id: stableId,
          runtimeIndex: display.index,
          name: this.getDisplayName(display, stableId),
          brightness,
          maxBrightness,
          available: true,
          backend: display.backend,
          serialNumber: display.serialNumber ?? undefined,
          modelName: display.modelName ?? undefined,
          manufacturerId: display.manufacturerId ?? undefined,
        };

        this.monitors.set(stableId, monitor);
        newMonitors.push(monitor);

        // Emit poll result for initial brightness
        this.pollResults$.next({
          monitorId: stableId,
          brightness,
          maxBrightness,
        });
      }

      // Update caches
      this.displays = newDisplays;
      this.idToIndex = newIdToIndex;

      // Mark monitors that are no longer present as unavailable, but keep them in the cache
      // so actions that target them can still show them in the UI and users can unselect them.
      for (const [existingId, cached] of this.monitors.entries()) {
        if (!newDisplays.has(existingId)) {
          cached.available = false;
        }
      }

      streamDeck.logger.info(
        `[MonitorManager] Successfully detected ${newMonitors.length} DDC-compatible monitor(s)`
      );

      // Always emit the monitors changed event, even if empty
      streamDeck.logger.info(
        `[MonitorManager] Emitting monitorsChanged$ with ${this.monitors.size} cached monitor(s)`
      );
      this.monitorsChanged$.next(this.getMonitors());

      return newMonitors;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      streamDeck.logger.error(`Error refreshing monitors: ${errorMsg}`);
      this.errors$.next({ error: err as Error });
      return [];
    } finally {
      this.refreshInProgress$.next(false);
      this.currentRefresh$ = null;
      if (didAcquireLock) {
        this.releaseLock();
      }
    }
  }

  getMonitors(): MonitorInfo[] {
    return Array.from(this.monitors.values());
  }

  /**
   * Get a monitor by its stable ID
   */
  getMonitor(id: string): MonitorInfo | undefined {
    return this.monitors.get(id);
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

  /**
   * Start periodic polling for brightness values
   */
  startBrightnessPolling(): void {
    if (this.brightnessPollSub) return;

    streamDeck.logger.info(`Starting brightness polling every ${this.brightnessPollIntervalMs}ms`);

    this.brightnessPollSub = interval(this.brightnessPollIntervalMs).subscribe(() => {
      void this.pollMonitors();
    });
  }

  /**
   * Stop periodic polling
   */
  stopBrightnessPolling(): void {
    if (this.brightnessPollSub) {
      this.brightnessPollSub.unsubscribe();
      this.brightnessPollSub = null;
      streamDeck.logger.info('Stopped brightness polling');
    }
  }

  /**
   * Start periodic refresh to detect new monitors (useful after boot when drivers initialize slowly)
   */
  startMonitorPolling(): void {
    if (this.monitorPollSub) return;

    streamDeck.logger.info(`Starting monitor refresh every ${this.monitorPollIntervalMs}ms`);

    const timeoutMs = this.getMonitorPollTimeoutMs();
    const now = Date.now();
    const lastRefreshAt = this.lastMonitorRefreshAt ?? now;
    const initialDelay = Math.max(0, this.monitorPollIntervalMs - (now - lastRefreshAt));

    this.monitorPollSub = timer(initialDelay, this.monitorPollIntervalMs)
      .pipe(exhaustMap(() => this.refreshMonitors({ timeoutMs })))
      .subscribe({
        next: (monitors) => {
          streamDeck.logger.debug(
            `Periodic refresh complete: ${monitors.length} monitor(s) detected`
          );
        },
        error: (err) => {
          streamDeck.logger.warn(`Periodic refresh error: ${err}`);
        },
      });
  }

  /**
   * Stop periodic refresh
   */
  stopMonitorPolling(): void {
    if (this.monitorPollSub) {
      this.monitorPollSub.unsubscribe();
      this.monitorPollSub = null;
      streamDeck.logger.info('Stopped periodic monitor refresh');
    }
  }

  private async pollMonitors(): Promise<void> {
    if (this.refreshInProgress$.value || !this.acquireLock()) {
      return;
    }

    try {
      // Poll all monitors in parallel
      const pollPromises = Array.from(this.displays.entries()).map(async ([monitorId, display]) => {
        // Skip if monitor is locked by write operation
        if (this.ddcLocks.get(monitorId)) {
          return;
        }

        const cached = this.monitors.get(monitorId);
        if (!cached) return;

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
      });

      await Promise.allSettled(pollPromises);
    } catch (err) {
      streamDeck.logger.debug('Error during poll:', err);
    } finally {
      this.releaseLock();
    }
  }

  dispose(): void {
    this.stopBrightnessPolling();
    this.stopMonitorPolling();
    this.monitors.clear();
    this.displays.clear();
    this.idToIndex.clear();
    this.pollResults$.complete();
    this.monitorsChanged$.complete();
    this.errors$.complete();
    this.refreshInProgress$.complete();
  }

  private getDisplayName(
    display: { modelName?: string; manufacturerId?: string; index: number },
    stableId: string
  ): string {
    const components = [];
    if (display.manufacturerId) components.push(display.manufacturerId);
    if (display.modelName) components.push(display.modelName);
    else if (isStableId(stableId)) {
      // If we have a stable ID but no model name, extract something meaningful
      components.push(`Display ${display.index}`);
    } else {
      components.push(`Display ${display.index} (Generic)`);
    }
    return components.join(' ');
  }
}
