export interface BrightnessSettings {
  selectedMonitors?: string[];
  stepSize?: number;
  // Index signature required by Stream Deck SDK's JsonObject constraint
  [key: string]: string[] | number | undefined;
}

export interface GlobalSettings {
  ddcWriteThrottleMs?: number;
  enforcementDurationMs?: number;
  enforcementIntervalMs?: number;
  pollIntervalMs?: number;
  // Index signature required by Stream Deck SDK's JsonObject constraint
  [key: string]: number | undefined;
}

export interface MonitorInfo {
  id: string;
  name: string;
  brightness: number;
  maxBrightness: number;
  available: boolean;
}
