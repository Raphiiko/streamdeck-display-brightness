import {
  BehaviorSubject,
  Subject,
  Observable,
  combineLatest,
  map,
  distinctUntilChanged,
  interval,
  Subscription,
} from 'rxjs';
import {
  DEFAULT_DDC_WRITE_THROTTLE_MS,
  DEFAULT_ENFORCEMENT_DURATION_MS,
  DEFAULT_ENFORCEMENT_INTERVAL_MS,
} from '../globals';

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// All brightness values are normalized to 0-100 scale
export interface MonitorBrightnessState {
  realBrightness: number; // From polling
  virtualBrightness: number; // Used for display and writes
  lastUserUpdate: number; // Timestamp of last user-initiated change
  maxBrightness: number; // Max value from DDC (for scaling)
}

// Enforcement state for a monitor - periodically retries writing target brightness
interface EnforcementState {
  targetBrightness: number;
  startTime: number;
  subscription: Subscription;
}

export class BrightnessStore {
  private static instance: BrightnessStore;

  // Configurable timing values
  private ddcWriteThrottleMs = DEFAULT_DDC_WRITE_THROTTLE_MS;
  private enforcementDurationMs = DEFAULT_ENFORCEMENT_DURATION_MS;
  private enforcementIntervalMs = DEFAULT_ENFORCEMENT_INTERVAL_MS;

  // State per monitor
  private monitorStates = new Map<string, BehaviorSubject<MonitorBrightnessState>>();

  // Enforcement state per monitor - tracks ongoing brightness enforcement
  private enforcementStates = new Map<string, EnforcementState>();

  // Per-monitor throttle tracking (last write time)
  private lastWriteTime = new Map<string, number>();

  // Subject for DDC write requests (not throttled here - throttling is per-monitor)
  private ddcWriteRequests = new Subject<{ monitorId: string; brightness: number }>();

  // Observable of DDC write requests
  public ddcWriteRequests$: Observable<{ monitorId: string; brightness: number }>;

  static getInstance(): BrightnessStore {
    if (!BrightnessStore.instance) {
      BrightnessStore.instance = new BrightnessStore();
    }
    return BrightnessStore.instance;
  }

  private constructor() {
    this.ddcWriteRequests$ = this.ddcWriteRequests.asObservable();
  }

  /**
   * Configure timing settings
   */
  configure(options: {
    ddcWriteThrottleMs?: number;
    enforcementDurationMs?: number;
    enforcementIntervalMs?: number;
  }): void {
    if (options.ddcWriteThrottleMs !== undefined) {
      this.ddcWriteThrottleMs = clamp(options.ddcWriteThrottleMs, 10, 5000);
    }
    if (options.enforcementDurationMs !== undefined) {
      this.enforcementDurationMs = clamp(options.enforcementDurationMs, 1000, 30000);
    }
    if (options.enforcementIntervalMs !== undefined) {
      this.enforcementIntervalMs = clamp(options.enforcementIntervalMs, 100, 5000);
    }
  }

  /**
   * Get or create the state subject for a monitor
   */
  private getOrCreateMonitorState(monitorId: string): BehaviorSubject<MonitorBrightnessState> {
    let state$ = this.monitorStates.get(monitorId);
    if (!state$) {
      state$ = new BehaviorSubject<MonitorBrightnessState>({
        realBrightness: 0,
        virtualBrightness: 0,
        lastUserUpdate: 0,
        maxBrightness: 100,
      });
      this.monitorStates.set(monitorId, state$);
    }
    return state$;
  }

  /**
   * Called when polling returns a new real brightness value from a monitor.
   * Updates virtual brightness only if no enforcement is active for this monitor.
   */
  updateRealBrightness(monitorId: string, brightness: number, maxBrightness: number = 100): void {
    const state$ = this.getOrCreateMonitorState(monitorId);
    const current = state$.getValue();

    // Normalize to 0-100 scale
    const normalizedBrightness =
      maxBrightness > 0 ? (brightness / maxBrightness) * 100 : brightness;

    // Check if enforcement is active and the real brightness matches the target
    const enforcement = this.enforcementStates.get(monitorId);
    if (
      enforcement &&
      Math.round(normalizedBrightness) === Math.round(enforcement.targetBrightness)
    ) {
      this.stopEnforcement(monitorId);
    }

    // Don't update virtual brightness if enforcement is active
    // (we're trying to force a target value)
    const isEnforcing = this.enforcementStates.has(monitorId);
    const shouldUpdateVirtual = !isEnforcing;

    state$.next({
      ...current,
      realBrightness: normalizedBrightness,
      maxBrightness,
      virtualBrightness: shouldUpdateVirtual ? normalizedBrightness : current.virtualBrightness,
    });
  }

  /**
   * Called when user rotates a dial. Sets virtual brightness and marks timestamp.
   * This will trigger a per-monitor throttled DDC write and start enforcement.
   */
  setVirtualBrightness(monitorId: string, brightness: number): void {
    const state$ = this.getOrCreateMonitorState(monitorId);
    const current = state$.getValue();
    const now = Date.now();

    const clampedBrightness = clamp(brightness, 0, 100);

    state$.next({
      ...current,
      virtualBrightness: clampedBrightness,
      lastUserUpdate: now,
    });

    // Per-monitor throttling: check if enough time has passed since last write
    const lastWrite = this.lastWriteTime.get(monitorId) ?? 0;
    const shouldWriteNow = now - lastWrite >= this.ddcWriteThrottleMs;

    if (shouldWriteNow) {
      // Emit DDC write request immediately
      this.lastWriteTime.set(monitorId, now);
      this.ddcWriteRequests.next({ monitorId, brightness: clampedBrightness });
    }

    // Start or update enforcement for this monitor
    this.startEnforcement(monitorId, clampedBrightness);
  }

  /**
   * Start or update brightness enforcement for a monitor.
   * This periodically retries writing the target brightness to ensure
   * monitors that take time to respond eventually reach the target value.
   */
  private startEnforcement(monitorId: string, targetBrightness: number): void {
    const now = Date.now();

    // If enforcement already exists, just update the target
    const existing = this.enforcementStates.get(monitorId);
    if (existing) {
      existing.targetBrightness = targetBrightness;
      existing.startTime = now; // Reset the enforcement duration
      return;
    }

    // Create new enforcement subscription
    const subscription = interval(this.enforcementIntervalMs).subscribe(() => {
      const enforcement = this.enforcementStates.get(monitorId);
      if (!enforcement) {
        subscription.unsubscribe();
        return;
      }

      const elapsed = Date.now() - enforcement.startTime;

      // Stop enforcement after duration expires
      if (elapsed >= this.enforcementDurationMs) {
        this.stopEnforcement(monitorId);
        return;
      }

      // Emit a write request for the target brightness
      this.ddcWriteRequests.next({
        monitorId,
        brightness: enforcement.targetBrightness,
      });
    });

    this.enforcementStates.set(monitorId, {
      targetBrightness,
      startTime: now,
      subscription,
    });
  }

  /**
   * Stop enforcement for a monitor
   */
  private stopEnforcement(monitorId: string): void {
    const enforcement = this.enforcementStates.get(monitorId);
    if (enforcement) {
      enforcement.subscription.unsubscribe();
      this.enforcementStates.delete(monitorId);
    }
  }

  /**
   * Check if a monitor is currently under enforcement
   */
  isEnforcing(monitorId: string): boolean {
    return this.enforcementStates.has(monitorId);
  }

  /**
   * Get the current virtual brightness for a monitor
   */
  getVirtualBrightness(monitorId: string): number {
    const state$ = this.monitorStates.get(monitorId);
    return state$?.getValue().virtualBrightness ?? 0;
  }

  /**
   * Get observable of virtual brightness changes for a monitor
   */
  getVirtualBrightness$(monitorId: string): Observable<number> {
    return this.getOrCreateMonitorState(monitorId).pipe(
      map((state) => state.virtualBrightness),
      distinctUntilChanged()
    );
  }

  /**
   * Get the average virtual brightness for multiple monitors.
   * This is what should be displayed on a dial that controls multiple monitors.
   */
  getAverageVirtualBrightness(monitorIds: string[]): number {
    if (monitorIds.length === 0) return 0;

    const values = monitorIds
      .map((id) => this.monitorStates.get(id)?.getValue().virtualBrightness)
      .filter((v): v is number => v !== undefined);

    return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  }

  /**
   * Get observable of average virtual brightness for multiple monitors.
   * Emits whenever any of the monitored monitors' virtual brightness changes.
   */
  getAverageVirtualBrightness$(monitorIds: string[]): Observable<number> {
    if (monitorIds.length === 0) {
      return new BehaviorSubject(0).asObservable();
    }

    const observables = monitorIds.map((id) =>
      this.getOrCreateMonitorState(id).pipe(map((state) => state.virtualBrightness))
    );

    return combineLatest(observables).pipe(
      map((values) => {
        const sum = values.reduce((acc, val) => acc + val, 0);
        return values.length > 0 ? sum / values.length : 0;
      }),
      distinctUntilChanged()
    );
  }

  /**
   * Convert virtual brightness (0-100) to raw DDC value for a specific monitor
   */
  virtualToRaw(monitorId: string, virtualBrightness: number): number {
    const state$ = this.monitorStates.get(monitorId);
    const maxBrightness = state$?.getValue().maxBrightness ?? 100;
    return Math.round((virtualBrightness / 100) * maxBrightness);
  }

  /**
   * Check if a monitor exists in the store
   */
  hasMonitor(monitorId: string): boolean {
    return this.monitorStates.has(monitorId);
  }

  /**
   * Remove a monitor from the store
   */
  removeMonitor(monitorId: string): void {
    const state$ = this.monitorStates.get(monitorId);
    if (state$) {
      state$.complete();
      this.monitorStates.delete(monitorId);
    }
  }

  /**
   * Clean up all subscriptions
   */
  dispose(): void {
    // Stop all enforcement subscriptions
    for (const enforcement of this.enforcementStates.values()) {
      enforcement.subscription.unsubscribe();
    }
    this.enforcementStates.clear();

    for (const state$ of this.monitorStates.values()) {
      state$.complete();
    }
    this.monitorStates.clear();
    this.ddcWriteRequests.complete();
  }
}
