import { Display, DisplayManager, VCPFeatureCode, VcpValueType } from '@raphiiko/ddc-node';
import { Subject, Observable, from, EMPTY } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS, DEFAULT_MONITOR_POLL_INTERVAL_MS } from '../globals';
import { MonitorInfo } from '../types/settings';
import {
  getPhysicalMonitorMapping,
  getRegistryMonitorInfo,
  PhysicalMonitorEntry,
  RegistryMonitorEntry,
} from './win32-ffi';

/**
 * Internal representation of a resolved monitor, combining ddc-node Display
 * with registry-based identification data.
 */
interface ResolvedMonitor {
  /** Stable identifier that survives reboots */
  id: string;
  /** Human-readable name */
  name: string;
  /** The ddc-node Display object for DDC/CI operations */
  display: Display;
  /** Backend (winapi, nvapi, etc.) */
  backend: string;
  /** Serial number if known */
  serialNumber?: string;
  /** Model name if known */
  modelName?: string;
  /** Manufacturer ID if known */
  manufacturerId?: string;
}

export class MonitorManager {
  private static instance: MonitorManager;

  private monitors: ResolvedMonitor[] = [];
  private monitorInfoCache: MonitorInfo[] = [];

  private brightnessPollIntervalMs = DEFAULT_BRIGHTNESS_POLL_INTERVAL_MS;
  private monitorPollIntervalMs = DEFAULT_MONITOR_POLL_INTERVAL_MS;

  private brightnessPollTimer: ReturnType<typeof setInterval> | null = null;
  private monitorPollTimer: ReturnType<typeof setInterval> | null = null;

  private pollResultSubject = new Subject<{
    monitorId: string;
    brightness: number;
    maxBrightness: number;
  }>();
  private monitorsChangedSubject = new Subject<MonitorInfo[]>();
  private errorSubject = new Subject<{ error: Error; monitorId?: string }>();

  public onPollResult$: Observable<{
    monitorId: string;
    brightness: number;
    maxBrightness: number;
  }>;
  public onMonitorsChanged$: Observable<MonitorInfo[]>;
  public onError$: Observable<{ error: Error; monitorId?: string }>;

  static getInstance(): MonitorManager {
    if (!MonitorManager.instance) {
      MonitorManager.instance = new MonitorManager();
    }
    return MonitorManager.instance;
  }

  private constructor() {
    this.onPollResult$ = this.pollResultSubject.asObservable();
    this.onMonitorsChanged$ = this.monitorsChangedSubject.asObservable();
    this.onError$ = this.errorSubject.asObservable();
  }

  configure(options: { brightnessPollIntervalMs?: number; monitorPollIntervalMs?: number }): void {
    if (options.brightnessPollIntervalMs !== undefined) {
      this.brightnessPollIntervalMs = Math.max(500, options.brightnessPollIntervalMs);
    }
    if (options.monitorPollIntervalMs !== undefined) {
      this.monitorPollIntervalMs = Math.max(2000, options.monitorPollIntervalMs);
    }

    // Restart polling with new intervals if already running
    if (this.brightnessPollTimer) {
      this.stopBrightnessPolling();
      this.startBrightnessPolling();
    }
    if (this.monitorPollTimer) {
      this.stopMonitorPolling();
      this.startMonitorPolling();
    }
  }

  async initialize(): Promise<void> {
    await this.refreshMonitors();
  }

  getMonitors(): MonitorInfo[] {
    return this.monitorInfoCache;
  }

  startBrightnessPolling(): void {
    if (this.brightnessPollTimer) return;
    this.brightnessPollTimer = setInterval(() => {
      void this.pollBrightness();
    }, this.brightnessPollIntervalMs);
  }

  stopBrightnessPolling(): void {
    if (this.brightnessPollTimer) {
      clearInterval(this.brightnessPollTimer);
      this.brightnessPollTimer = null;
    }
  }

  startMonitorPolling(): void {
    if (this.monitorPollTimer) return;
    this.monitorPollTimer = setInterval(() => {
      void this.refreshMonitors();
    }, this.monitorPollIntervalMs);
  }

  stopMonitorPolling(): void {
    if (this.monitorPollTimer) {
      clearInterval(this.monitorPollTimer);
      this.monitorPollTimer = null;
    }
  }

  writeBrightness(monitorId: string, rawValue: number): Observable<void> {
    const monitor = this.monitors.find((m) => m.id === monitorId);
    if (!monitor) {
      return EMPTY;
    }

    return from(
      monitor.display
        .setVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance, rawValue)
        .catch((err: Error) => {
          this.errorSubject.next({ error: err, monitorId });
        })
    ).pipe(
      catchError((err: Error) => {
        this.errorSubject.next({ error: err, monitorId });
        return EMPTY;
      })
    );
  }

  dispose(): void {
    this.stopBrightnessPolling();
    this.stopMonitorPolling();
    this.pollResultSubject.complete();
    this.monitorsChangedSubject.complete();
    this.errorSubject.complete();
  }

  // ─── Private Methods ────────────────────────────────────────────────

  /**
   * Refresh the full monitor list. Enumerates monitors from ddc-node,
   * correlates WinAPI monitors with registry EDID data, tests each for brightness
   * support, then deduplicates preferring the one that actually works.
   *
   * Previously-known monitors that temporarily fail brightness reads are
   * kept in the list (marked unavailable) rather than being removed. This
   * prevents UI churn from transient DDC/CI communication failures.
   */
  private async refreshMonitors(): Promise<void> {
    try {
      const resolved = await this.enumerateAll();

      // Test each monitor for brightness support BEFORE deduplication.
      // This is critical because a monitor might appear in both WinAPI and NVAPI,
      // and only one backend may actually be able to communicate with it.
      const tested: { monitor: ResolvedMonitor; info: MonitorInfo }[] = [];
      for (const monitor of resolved) {
        const info = await this.testMonitor(monitor);
        if (info) {
          tested.push({ monitor, info });
        }
      }

      // Deduplicate: when the same stable ID appears multiple times (e.g. WinAPI + NVAPI),
      // prefer the one that successfully read brightness.
      const deduped = new Map<string, { monitor: ResolvedMonitor; info: MonitorInfo }>();
      for (const entry of tested) {
        const existing = deduped.get(entry.info.id);
        if (!existing) {
          deduped.set(entry.info.id, entry);
          continue;
        }
        // Both work - prefer the one with native EDID data (richer metadata)
        if (entry.monitor.display.edidData?.length && !existing.monitor.display.edidData?.length) {
          deduped.set(entry.info.id, entry);
        }
      }

      // Merge with previously-known monitors. If a monitor we've seen before
      // is not in this enumeration, keep it but mark it unavailable. This
      // avoids dropping monitors from the UI due to transient DDC/CI failures.
      for (const prev of this.monitors) {
        if (!deduped.has(prev.id)) {
          const cachedInfo = this.monitorInfoCache.find((m) => m.id === prev.id);
          if (cachedInfo) {
            deduped.set(prev.id, {
              monitor: prev,
              info: { ...cachedInfo, available: false, brightness: 0 },
            });
          }
        }
      }

      const entries = [...deduped.values()];
      const monitors = entries.map((e) => e.monitor);
      const monitorInfos = entries.map((e) => e.info);

      const changed = this.hasMonitorListChanged(monitorInfos);

      this.monitors = monitors;
      this.monitorInfoCache = monitorInfos;

      if (changed) {
        this.monitorsChangedSubject.next([...monitorInfos]);
      }
    } catch (err) {
      this.errorSubject.next({
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  /**
   * Enumerate all displays from ddc-node and resolve stable IDs using registry data.
   * Does NOT deduplicate - returns all monitors including duplicates so that
   * brightness testing can determine which backend actually works.
   */
  private async enumerateAll(): Promise<ResolvedMonitor[]> {
    const dm = new DisplayManager();
    const displays = await dm.collect();

    const { physicalMapping, registryInfo } = this.getWinApiEnrichmentData();

    return displays.map((display) => this.resolveDisplay(display, physicalMapping, registryInfo));
  }

  /**
   * Fetch physical monitor mapping + registry EDID data used to enrich WinAPI monitors.
   * Returns empty defaults if the native calls fail.
   */
  private getWinApiEnrichmentData(): {
    physicalMapping: PhysicalMonitorEntry[];
    registryInfo: Map<string, RegistryMonitorEntry>;
  } {
    try {
      return {
        physicalMapping: getPhysicalMonitorMapping(),
        registryInfo: getRegistryMonitorInfo(),
      };
    } catch (err) {
      this.errorSubject.next({
        error: new Error(
          `Monitor enumeration failed, WinAPI monitors will have unstable IDs: ${err instanceof Error ? err.message : String(err)}`
        ),
      });
      return { physicalMapping: [], registryInfo: new Map() };
    }
  }

  /**
   * Resolve a ddc-node Display into a ResolvedMonitor with a stable ID.
   */
  private resolveDisplay(
    display: Display,
    physicalMapping: PhysicalMonitorEntry[],
    registryInfo: Map<string, RegistryMonitorEntry>
  ): ResolvedMonitor {
    const hasEdid = display.edidData != null && display.edidData.length > 0;

    // WinAPI without EDID: correlate via physical monitor mapping + registry
    if (display.backend === 'winapi' && !hasEdid) {
      const resolved = this.resolveWinApiViaRegistry(display, physicalMapping, registryInfo);
      if (resolved) return resolved;
    }

    // NVAPI and other backends with EDID data: use EDID-derived identification
    if (hasEdid) {
      return this.resolveFromEdid(display);
    }

    // Fallback: use whatever ddc-node provides
    return this.resolveFallback(display);
  }

  /**
   * Resolve a display that has EDID data (typically NVAPI).
   */
  private resolveFromEdid(display: Display): ResolvedMonitor {
    const id = this.generateStableIdFromEdid(display);
    const name = display.modelName || `Display (${display.backend})`;

    return {
      id,
      name,
      display,
      backend: display.backend,
      serialNumber: display.serialNumber || undefined,
      modelName: display.modelName || undefined,
      manufacturerId: display.manufacturerId || undefined,
    };
  }

  /**
   * Resolve a WinAPI display by correlating with registry EDID data via the
   * physical monitor handle ordering.
   */
  private resolveWinApiViaRegistry(
    display: Display,
    physicalMapping: PhysicalMonitorEntry[],
    registryInfo: Map<string, RegistryMonitorEntry>
  ): ResolvedMonitor | null {
    const physEntry = physicalMapping.find((p) => p.globalIndex === display.index);
    if (!physEntry) return null;

    const key = `${physEntry.modelCode}|${physEntry.instancePath}`;
    const regEntry = registryInfo.get(key);
    if (!regEntry) return null;

    const id = regEntry.serialNumber
      ? `${regEntry.modelCode}:${regEntry.serialNumber}`
      : `${regEntry.modelCode}:${physEntry.instancePath}`;

    return {
      id,
      name: regEntry.friendlyName || `${regEntry.modelCode} Display`,
      display,
      backend: display.backend,
      serialNumber: regEntry.serialNumber || undefined,
      modelName: regEntry.friendlyName || undefined,
      manufacturerId: regEntry.modelCode.substring(0, 3) || undefined,
    };
  }

  /**
   * Fallback resolution when no EDID or registry data is available.
   */
  private resolveFallback(display: Display): ResolvedMonitor {
    const id = `fallback:${display.backend}:${display.index}`;
    const name = display.modelName || display.displayId || `Display ${display.index}`;

    return {
      id,
      name,
      display,
      backend: display.backend,
      serialNumber: display.serialNumber || undefined,
      modelName: display.modelName || undefined,
      manufacturerId: display.manufacturerId || undefined,
    };
  }

  /**
   * Generate a stable ID from EDID data on the display.
   * Needs to produce the same ID as the registry-based approach for deduplication.
   *
   * Registry uses modelCode (e.g. "GSM774D") + serial. NVAPI gives us
   * manufacturerId (e.g. "GSM"), modelId (e.g. 30541 = 0x774D), and serialNumber.
   */
  private generateStableIdFromEdid(display: Display): string {
    if (display.manufacturerId && display.modelId !== undefined) {
      const modelCode =
        display.manufacturerId + display.modelId.toString(16).toUpperCase().padStart(4, '0');
      const serial = display.serialNumber || display.serial;
      if (serial) {
        return `${modelCode}:${serial}`;
      }
    }

    // EDID header fallback when manufacturer/model/serial are unavailable
    if (display.edidData && display.edidData.length >= 18) {
      const edidHeader = Array.from(display.edidData.slice(8, 18))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return `edid:${edidHeader}`;
    }

    return `${display.backend}:${display.displayId}:${display.index}`;
  }

  /**
   * Test a monitor for DDC/CI brightness support.
   * Returns MonitorInfo if the monitor supports brightness, null otherwise.
   */
  private async testMonitor(monitor: ResolvedMonitor): Promise<MonitorInfo | null> {
    try {
      const feature = await monitor.display.getVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance);
      if (feature.type === VcpValueType.Continuous) {
        return {
          id: monitor.id,
          runtimeIndex: monitor.display.index,
          name: monitor.name,
          brightness: feature.currentValue,
          maxBrightness: feature.maximumValue,
          available: true,
          backend: monitor.backend,
          serialNumber: monitor.serialNumber,
          modelName: monitor.modelName,
          manufacturerId: monitor.manufacturerId,
        };
      }
    } catch {
      // Monitor doesn't support brightness or DDC/CI communication failed
    }
    return null;
  }

  /**
   * Poll brightness for all known monitors.
   */
  private async pollBrightness(): Promise<void> {
    for (const monitor of this.monitors) {
      const cached = this.monitorInfoCache.find((m) => m.id === monitor.id);

      try {
        const feature = await monitor.display.getVcpFeature(
          VCPFeatureCode.ImageAdjustment.Luminance
        );
        if (feature.type === VcpValueType.Continuous) {
          this.pollResultSubject.next({
            monitorId: monitor.id,
            brightness: feature.currentValue,
            maxBrightness: feature.maximumValue,
          });
          if (cached) {
            cached.brightness = feature.currentValue;
            cached.maxBrightness = feature.maximumValue;
            cached.available = true;
          }
        }
      } catch (err) {
        this.errorSubject.next({
          error: err instanceof Error ? err : new Error(String(err)),
          monitorId: monitor.id,
        });
        if (cached) {
          cached.available = false;
        }
      }
    }
  }

  /**
   * Check if the monitor list has changed compared to the current cache.
   */
  private hasMonitorListChanged(newInfos: MonitorInfo[]): boolean {
    if (newInfos.length !== this.monitorInfoCache.length) return true;

    const cachedIds = new Set(this.monitorInfoCache.map((m) => m.id));
    return newInfos.some((m) => !cachedIds.has(m.id));
  }
}
