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

interface TestMonitorResult {
  info: MonitorInfo | null;
  errorMessage?: string;
}

interface MonitorDebugEntry {
  stableId: string;
  runtimeIndex: number;
  backend: string;
  name: string;
  displayId: string;
  available: boolean;
  brightness: number;
  maxBrightness: number;
  hasEdid: boolean;
  manufacturerId?: string;
  modelId?: number;
  modelName?: string;
  serialNumber?: string;
  serial?: number;
  manufactureWeek?: number;
  manufactureYear?: number;
  errorMessage?: string;
}

interface MonitorDebugSnapshot {
  generatedAtIso: string;
  physicalMapping: PhysicalMonitorEntry[];
  registryEntries: RegistryMonitorEntry[];
  resolvedBeforeTest: MonitorDebugEntry[];
  testedMonitors: MonitorDebugEntry[];
  dedupedMonitors: MonitorDebugEntry[];
  keptUnavailableIds: string[];
}

export class MonitorManager {
  private static instance: MonitorManager;

  private static readonly AVAILABILITY_FAILURE_THRESHOLD = 3;

  private monitors: ResolvedMonitor[] = [];
  private monitorInfoCache: MonitorInfo[] = [];
  private lastDebugSnapshot: MonitorDebugSnapshot | null = null;
  private recentErrors: Array<{ timestampIso: string; monitorId?: string; message: string }> = [];
  private consecutiveReadFailures = new Map<string, number>();

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

  getDebugInfoText(): string {
    const nowIso = new Date().toISOString();
    const snapshot = this.lastDebugSnapshot;
    const lines: string[] = [];

    lines.push('sd-brightness monitor debug report');
    lines.push(`generatedAt: ${nowIso}`);
    lines.push(`knownMonitors: ${this.monitorInfoCache.length}`);
    lines.push('');

    lines.push('Known monitors (current cache)');
    if (this.monitorInfoCache.length === 0) {
      lines.push('- none');
    } else {
      for (const monitor of this.monitorInfoCache) {
        lines.push(
          `- id=${monitor.id} | name=${monitor.name} | backend=${monitor.backend} | runtimeIndex=${monitor.runtimeIndex} | available=${monitor.available} | brightness=${monitor.brightness}/${monitor.maxBrightness}`
        );
        lines.push(
          `  manufacturerId=${monitor.manufacturerId ?? '-'} | modelName=${monitor.modelName ?? '-'} | serialNumber=${monitor.serialNumber ?? '-'}`
        );
      }
    }
    lines.push('');

    if (snapshot) {
      lines.push(`Snapshot captured at: ${snapshot.generatedAtIso}`);
      lines.push('');

      lines.push(`WinAPI physical mapping (${snapshot.physicalMapping.length})`);
      if (snapshot.physicalMapping.length === 0) {
        lines.push('- none');
      } else {
        for (const entry of snapshot.physicalMapping) {
          lines.push(
            `- globalIndex=${entry.globalIndex} | modelCode=${entry.modelCode} | instancePath=${entry.instancePath}`
          );
        }
      }
      lines.push('');

      lines.push(`Registry entries (${snapshot.registryEntries.length})`);
      if (snapshot.registryEntries.length === 0) {
        lines.push('- none');
      } else {
        for (const entry of snapshot.registryEntries) {
          lines.push(
            `- modelCode=${entry.modelCode} | instanceName=${entry.instanceName} | friendlyName=${entry.friendlyName || '-'} | serialNumber=${entry.serialNumber || '-'}`
          );
        }
      }
      lines.push('');

      this.appendDebugEntries(
        lines,
        'Resolved before brightness test',
        snapshot.resolvedBeforeTest
      );
      this.appendDebugEntries(
        lines,
        'DDC luminance check passed (can read VCP 0x10)',
        snapshot.testedMonitors
      );
      this.appendDebugEntries(lines, 'Deduped active entries', snapshot.dedupedMonitors);

      lines.push(`Kept unavailable IDs (${snapshot.keptUnavailableIds.length})`);
      if (snapshot.keptUnavailableIds.length === 0) {
        lines.push('- none');
      } else {
        for (const id of snapshot.keptUnavailableIds) {
          lines.push(`- ${id}`);
        }
      }
      lines.push('');
    }

    lines.push(`Recent errors (${this.recentErrors.length})`);
    if (this.recentErrors.length === 0) {
      lines.push('- none');
    } else {
      for (const entry of this.recentErrors) {
        lines.push(
          `- ${entry.timestampIso}${entry.monitorId ? ` | monitorId=${entry.monitorId}` : ''} | ${entry.message}`
        );
      }
    }

    return lines.join('\n');
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
          this.emitError(err, monitorId);
        })
    ).pipe(
      catchError((err: Error) => {
        this.emitError(err, monitorId);
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
      const { resolved, physicalMapping, registryInfo } = await this.enumerateAll();
      const resolvedDebugEntries = resolved.map((monitor) =>
        this.toDebugEntry(monitor, null, undefined)
      );

      // Test each monitor for brightness support BEFORE deduplication.
      // This is critical because a monitor might appear in both WinAPI and NVAPI,
      // and only one backend may actually be able to communicate with it.
      const tested: { monitor: ResolvedMonitor; info: MonitorInfo }[] = [];
      const testedDebugEntries: MonitorDebugEntry[] = [];
      const successfulIds = new Set<string>();
      const failedIds = new Set<string>();
      const failedMonitorsById = new Map<string, ResolvedMonitor>();

      for (const monitor of resolved) {
        const result = await this.testMonitor(monitor);
        testedDebugEntries.push(this.toDebugEntry(monitor, result.info, result.errorMessage));

        if (result.info) {
          tested.push({ monitor, info: result.info });
          successfulIds.add(monitor.id);
          continue;
        }

        failedIds.add(monitor.id);
        const existingFailed = failedMonitorsById.get(monitor.id);
        if (!existingFailed) {
          failedMonitorsById.set(monitor.id, monitor);
          continue;
        }

        if (monitor.display.edidData?.length && !existingFailed.display.edidData?.length) {
          failedMonitorsById.set(monitor.id, monitor);
        }
      }

      for (const id of successfulIds) {
        this.registerReadSuccess(id);
      }

      for (const id of failedIds) {
        if (!successfulIds.has(id)) {
          this.registerReadFailure(id);
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

      // Keep currently-detected monitors visible even when their DDC check fails.
      // This helps users understand unstable enumeration instead of seeing monitors
      // disappear from the list.
      for (const [id, monitor] of failedMonitorsById) {
        if (deduped.has(id)) continue;

        const cachedInfo = this.monitorInfoCache.find((m) => m.id === id);
        const unavailable = this.hasReachedFailureThreshold(id);

        deduped.set(id, {
          monitor,
          info: cachedInfo
            ? {
                ...cachedInfo,
                runtimeIndex: monitor.display.index,
                backend: monitor.backend,
                serialNumber: monitor.serialNumber,
                modelName: monitor.modelName,
                manufacturerId: monitor.manufacturerId,
                available: unavailable ? false : cachedInfo.available,
                brightness: unavailable ? 0 : cachedInfo.brightness,
              }
            : {
                id,
                runtimeIndex: monitor.display.index,
                name: monitor.name,
                brightness: 0,
                maxBrightness: 100,
                available: false,
                backend: monitor.backend,
                serialNumber: monitor.serialNumber,
                modelName: monitor.modelName,
                manufacturerId: monitor.manufacturerId,
              },
        });
      }

      // Merge with previously-known monitors. If a monitor we've seen before
      // is not in this enumeration, keep it but mark it unavailable. This
      // avoids dropping monitors from the UI due to transient DDC/CI failures.
      const keptUnavailableIds: string[] = [];
      const resolvedIds = new Set(resolved.map((m) => m.id));
      for (const prev of this.monitors) {
        if (!resolvedIds.has(prev.id)) {
          this.registerReadFailure(prev.id);
        }

        if (!deduped.has(prev.id)) {
          const cachedInfo = this.monitorInfoCache.find((m) => m.id === prev.id);
          if (cachedInfo) {
            const unavailable = this.hasReachedFailureThreshold(prev.id);
            keptUnavailableIds.push(prev.id);
            deduped.set(prev.id, {
              monitor: prev,
              info: {
                ...cachedInfo,
                available: unavailable ? false : cachedInfo.available,
                brightness: unavailable ? 0 : cachedInfo.brightness,
              },
            });
          }
        }
      }

      const entries = [...deduped.values()];
      const monitors = entries.map((e) => e.monitor);
      const monitorInfos = entries.map((e) => e.info);
      const dedupedDebugEntries = entries.map((entry) =>
        this.toDebugEntry(entry.monitor, entry.info, undefined)
      );

      this.lastDebugSnapshot = {
        generatedAtIso: new Date().toISOString(),
        physicalMapping,
        registryEntries: [...registryInfo.values()],
        resolvedBeforeTest: resolvedDebugEntries,
        testedMonitors: testedDebugEntries,
        dedupedMonitors: dedupedDebugEntries,
        keptUnavailableIds,
      };

      const changed = this.hasMonitorListChanged(monitorInfos);

      this.monitors = monitors;
      this.monitorInfoCache = monitorInfos;

      if (changed) {
        this.monitorsChangedSubject.next([...monitorInfos]);
      }
    } catch (err) {
      this.emitError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Enumerate all displays from ddc-node and resolve stable IDs using registry data.
   * Does NOT deduplicate - returns all monitors including duplicates so that
   * brightness testing can determine which backend actually works.
   */
  private async enumerateAll(): Promise<{
    resolved: ResolvedMonitor[];
    physicalMapping: PhysicalMonitorEntry[];
    registryInfo: Map<string, RegistryMonitorEntry>;
  }> {
    const dm = new DisplayManager();
    const displays = await dm.collect();

    const { physicalMapping, registryInfo } = this.getWinApiEnrichmentData();

    return {
      resolved: displays.map((display) =>
        this.resolveDisplay(display, physicalMapping, registryInfo)
      ),
      physicalMapping,
      registryInfo,
    };
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
      this.emitError(
        new Error(
          `Monitor enumeration failed, WinAPI monitors will have unstable IDs: ${err instanceof Error ? err.message : String(err)}`
        )
      );
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
      return this.resolveFromEdid(display, physicalMapping);
    }

    // Fallback: use whatever ddc-node provides
    return this.resolveFallback(display);
  }

  /**
   * Resolve a display that has EDID data (typically NVAPI).
   */
  private resolveFromEdid(
    display: Display,
    physicalMapping: PhysicalMonitorEntry[]
  ): ResolvedMonitor {
    const id = this.generateStableIdFromEdid(display, physicalMapping);
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
  private generateStableIdFromEdid(
    display: Display,
    physicalMapping: PhysicalMonitorEntry[]
  ): string {
    if (display.manufacturerId && display.modelId !== undefined) {
      const modelCode =
        display.manufacturerId + display.modelId.toString(16).toUpperCase().padStart(4, '0');

      const serialNumber = display.serialNumber?.trim();
      if (serialNumber) {
        return `${modelCode}:${serialNumber}`;
      }

      const connectedInstancePath = this.resolveConnectedInstancePathForModelCode(
        modelCode,
        physicalMapping
      );
      if (connectedInstancePath) {
        return `${modelCode}:${connectedInstancePath}`;
      }

      if (display.serial !== undefined) {
        return `${modelCode}:${display.serial}`;
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
  private async testMonitor(monitor: ResolvedMonitor): Promise<TestMonitorResult> {
    try {
      const feature = await monitor.display.getVcpFeature(VCPFeatureCode.ImageAdjustment.Luminance);
      if (feature.type === VcpValueType.Continuous) {
        return {
          info: {
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
          },
        };
      }
    } catch {
      // Monitor doesn't support brightness or DDC/CI communication failed
      return { info: null, errorMessage: 'DDC read failed or unsupported luminance feature' };
    }
    return { info: null, errorMessage: 'Luminance VCP feature is not continuous' };
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
          this.registerReadSuccess(monitor.id);
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
        const failures = this.registerReadFailure(monitor.id);
        this.emitError(err instanceof Error ? err : new Error(String(err)), monitor.id);
        if (cached) {
          if (failures >= MonitorManager.AVAILABILITY_FAILURE_THRESHOLD) {
            cached.available = false;
          }
        }
      }
    }
  }

  private resolveConnectedInstancePathForModelCode(
    modelCode: string,
    physicalMapping: PhysicalMonitorEntry[]
  ): string | null {
    const instancePaths = new Set(
      physicalMapping
        .filter((entry) => entry.modelCode === modelCode)
        .map((entry) => entry.instancePath)
    );

    if (instancePaths.size === 1) {
      return [...instancePaths][0];
    }

    return null;
  }

  /**
   * Check if the monitor list has changed compared to the current cache.
   */
  private hasMonitorListChanged(newInfos: MonitorInfo[]): boolean {
    if (newInfos.length !== this.monitorInfoCache.length) return true;

    const cachedById = new Map(this.monitorInfoCache.map((m) => [m.id, m]));
    return newInfos.some((m) => {
      const cached = cachedById.get(m.id);
      if (!cached) return true;

      return (
        cached.available !== m.available ||
        cached.backend !== m.backend ||
        cached.runtimeIndex !== m.runtimeIndex ||
        cached.name !== m.name
      );
    });
  }

  private registerReadSuccess(monitorId: string): void {
    this.consecutiveReadFailures.delete(monitorId);
  }

  private registerReadFailure(monitorId: string): number {
    const next = (this.consecutiveReadFailures.get(monitorId) ?? 0) + 1;
    this.consecutiveReadFailures.set(monitorId, next);
    return next;
  }

  private hasReachedFailureThreshold(monitorId: string): boolean {
    return (
      (this.consecutiveReadFailures.get(monitorId) ?? 0) >=
      MonitorManager.AVAILABILITY_FAILURE_THRESHOLD
    );
  }

  private toDebugEntry(
    monitor: ResolvedMonitor,
    info: MonitorInfo | null,
    errorMessage?: string
  ): MonitorDebugEntry {
    return {
      stableId: monitor.id,
      runtimeIndex: monitor.display.index,
      backend: monitor.backend,
      name: monitor.name,
      displayId: monitor.display.displayId,
      available: info?.available ?? false,
      brightness: info?.brightness ?? 0,
      maxBrightness: info?.maxBrightness ?? 0,
      hasEdid: !!monitor.display.edidData?.length,
      manufacturerId: monitor.display.manufacturerId || monitor.manufacturerId,
      modelId: monitor.display.modelId,
      modelName: monitor.display.modelName || monitor.modelName,
      serialNumber: monitor.display.serialNumber || monitor.serialNumber,
      serial: monitor.display.serial,
      manufactureWeek: monitor.display.manufactureWeek,
      manufactureYear: monitor.display.manufactureYear,
      errorMessage,
    };
  }

  private appendDebugEntries(lines: string[], title: string, entries: MonitorDebugEntry[]): void {
    lines.push(`${title} (${entries.length})`);
    if (entries.length === 0) {
      lines.push('- none');
      lines.push('');
      return;
    }

    for (const entry of entries) {
      lines.push(
        `- stableId=${entry.stableId} | name=${entry.name} | backend=${entry.backend} | runtimeIndex=${entry.runtimeIndex} | available=${entry.available} | brightness=${entry.brightness}/${entry.maxBrightness}`
      );
      lines.push(
        `  displayId=${entry.displayId} | hasEdid=${entry.hasEdid} | manufacturerId=${entry.manufacturerId ?? '-'} | modelId=${entry.modelId ?? '-'} | modelName=${entry.modelName ?? '-'} | serialNumber=${entry.serialNumber ?? '-'} | serial=${entry.serial ?? '-'} | manufactureWeek=${entry.manufactureWeek ?? '-'} | manufactureYear=${entry.manufactureYear ?? '-'}`
      );
      if (entry.errorMessage) {
        lines.push(`  error=${entry.errorMessage}`);
      }
    }
    lines.push('');
  }

  private emitError(error: Error, monitorId?: string): void {
    this.errorSubject.next({ error, monitorId });
    this.recentErrors.push({
      timestampIso: new Date().toISOString(),
      monitorId,
      message: error.message,
    });
    if (this.recentErrors.length > 50) {
      this.recentErrors.splice(0, this.recentErrors.length - 50);
    }
  }
}
