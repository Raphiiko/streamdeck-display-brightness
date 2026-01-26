export interface BrightnessSettings {
  selectedMonitors?: string[];
  stepSize?: number;
  // Index signature required by Stream Deck SDK's JsonObject constraint
  [key: string]: string[] | number | undefined;
}

export interface BrightnessButtonSettings {
  /** Array of monitor IDs to control */
  selectedMonitors?: string[];

  /** Operation mode: what happens when button is pressed */
  operationMode?: 'increase' | 'decrease' | 'set' | 'toggle' | 'cycle';

  /** Step size for increase/decrease modes (1-100, default: 10) */
  stepSize?: number;

  /** Target brightness for 'set' mode (0-100, default: 100) */
  setValue?: number;

  /** First value for 'toggle' mode (0-100, default: 0) */
  toggleValue1?: number;

  /** Second value for 'toggle' mode (0-100, default: 100) */
  toggleValue2?: number;

  /** Array of values for 'cycle' mode (default: [0, 25, 50, 75, 100]) */
  cycleValues?: number[];

  // Index signature required by Stream Deck SDK's JsonObject constraint
  [key: string]: string | number | string[] | number[] | undefined;
}

export interface GlobalSettings {
  ddcWriteThrottleMs?: number;
  enforcementDurationMs?: number;
  enforcementIntervalMs?: number;
  brightnessPollIntervalMs?: number;
  monitorPollIntervalMs?: number;
  // Index signature required by Stream Deck SDK's JsonObject constraint
  [key: string]: number | undefined;
}

export interface MonitorInfo {
  /** Stable unique identifier (based on EDID/serial when available, fallback to index-based) */
  id: string;
  /** Current runtime index from ddc-node (may change between reboots) */
  runtimeIndex: number;
  /** Display name for UI */
  name: string;
  brightness: number;
  maxBrightness: number;
  available: boolean;
  /** Backend used to detect this monitor (winapi, nvapi, etc.) */
  backend: string;
  /** Serial number if available (most reliable identifier) */
  serialNumber?: string;
  /** Model name if available */
  modelName?: string;
  /** Manufacturer ID if available */
  manufacturerId?: string;
}
