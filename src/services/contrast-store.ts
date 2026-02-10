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

export interface MonitorContrastState {
  realContrast: number;
  virtualContrast: number;
  lastUserUpdate: number;
  maxContrast: number;
}

interface EnforcementState {
  targetContrast: number;
  startTime: number;
  subscription: Subscription;
}

export class ContrastStore {
  private static instance: ContrastStore;

  private ddcWriteThrottleMs = DEFAULT_DDC_WRITE_THROTTLE_MS;
  private enforcementDurationMs = DEFAULT_ENFORCEMENT_DURATION_MS;
  private enforcementIntervalMs = DEFAULT_ENFORCEMENT_INTERVAL_MS;

  private monitorStates = new Map<string, BehaviorSubject<MonitorContrastState>>();
  private enforcementStates = new Map<string, EnforcementState>();
  private lastWriteTime = new Map<string, number>();

  private ddcWriteRequests = new Subject<{ monitorId: string; contrast: number }>();
  public ddcWriteRequests$: Observable<{ monitorId: string; contrast: number }>;

  static getInstance(): ContrastStore {
    if (!ContrastStore.instance) {
      ContrastStore.instance = new ContrastStore();
    }
    return ContrastStore.instance;
  }

  private constructor() {
    this.ddcWriteRequests$ = this.ddcWriteRequests.asObservable();
  }

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

  private getOrCreateMonitorState(monitorId: string): BehaviorSubject<MonitorContrastState> {
    let state$ = this.monitorStates.get(monitorId);
    if (!state$) {
      state$ = new BehaviorSubject<MonitorContrastState>({
        realContrast: 0,
        virtualContrast: 0,
        lastUserUpdate: 0,
        maxContrast: 100,
      });
      this.monitorStates.set(monitorId, state$);
    }
    return state$;
  }

  updateRealContrast(monitorId: string, contrast: number, maxContrast: number = 100): void {
    const state$ = this.getOrCreateMonitorState(monitorId);
    const current = state$.getValue();

    const normalizedContrast = maxContrast > 0 ? (contrast / maxContrast) * 100 : contrast;

    const enforcement = this.enforcementStates.get(monitorId);
    if (enforcement && Math.round(normalizedContrast) === Math.round(enforcement.targetContrast)) {
      this.stopEnforcement(monitorId);
    }

    const isEnforcing = this.enforcementStates.has(monitorId);
    const shouldUpdateVirtual = !isEnforcing;

    state$.next({
      ...current,
      realContrast: normalizedContrast,
      maxContrast,
      virtualContrast: shouldUpdateVirtual ? normalizedContrast : current.virtualContrast,
    });
  }

  setVirtualContrast(monitorId: string, contrast: number): void {
    const state$ = this.getOrCreateMonitorState(monitorId);
    const current = state$.getValue();
    const now = Date.now();

    const clampedContrast = clamp(contrast, 0, 100);

    state$.next({
      ...current,
      virtualContrast: clampedContrast,
      lastUserUpdate: now,
    });

    const lastWrite = this.lastWriteTime.get(monitorId) ?? 0;
    const shouldWriteNow = now - lastWrite >= this.ddcWriteThrottleMs;

    if (shouldWriteNow) {
      this.lastWriteTime.set(monitorId, now);
      this.ddcWriteRequests.next({ monitorId, contrast: clampedContrast });
    }

    this.startEnforcement(monitorId, clampedContrast);
  }

  private startEnforcement(monitorId: string, targetContrast: number): void {
    const now = Date.now();

    const existing = this.enforcementStates.get(monitorId);
    if (existing) {
      existing.targetContrast = targetContrast;
      existing.startTime = now;
      return;
    }

    const subscription = interval(this.enforcementIntervalMs).subscribe(() => {
      const enforcement = this.enforcementStates.get(monitorId);
      if (!enforcement) {
        subscription.unsubscribe();
        return;
      }

      const elapsed = Date.now() - enforcement.startTime;
      if (elapsed >= this.enforcementDurationMs) {
        this.stopEnforcement(monitorId);
        return;
      }

      this.ddcWriteRequests.next({
        monitorId,
        contrast: enforcement.targetContrast,
      });
    });

    this.enforcementStates.set(monitorId, {
      targetContrast,
      startTime: now,
      subscription,
    });
  }

  private stopEnforcement(monitorId: string): void {
    const enforcement = this.enforcementStates.get(monitorId);
    if (enforcement) {
      enforcement.subscription.unsubscribe();
      this.enforcementStates.delete(monitorId);
    }
  }

  getAverageVirtualContrast(monitorIds: string[]): number {
    if (monitorIds.length === 0) return 0;

    const values = monitorIds
      .map((id) => this.monitorStates.get(id)?.getValue().virtualContrast)
      .filter((v): v is number => v !== undefined);

    return values.length > 0 ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
  }

  getAverageVirtualContrast$(monitorIds: string[]): Observable<number> {
    if (monitorIds.length === 0) {
      return new BehaviorSubject(0).asObservable();
    }

    const observables = monitorIds.map((id) =>
      this.getOrCreateMonitorState(id).pipe(map((state) => state.virtualContrast))
    );

    return combineLatest(observables).pipe(
      map((values) => {
        const sum = values.reduce((acc, val) => acc + val, 0);
        return values.length > 0 ? sum / values.length : 0;
      }),
      distinctUntilChanged()
    );
  }

  virtualToRaw(monitorId: string, virtualContrast: number): number {
    const state$ = this.monitorStates.get(monitorId);
    const maxContrast = state$?.getValue().maxContrast ?? 100;
    return Math.round((virtualContrast / 100) * maxContrast);
  }

  dispose(): void {
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
