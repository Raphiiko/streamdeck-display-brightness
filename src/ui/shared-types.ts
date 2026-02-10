import type { BrightnessButtonSettings } from '../types/settings';
import type { GlobalSettings } from '../types/settings';

export interface StreamDeck {
  websocket: WebSocket;
  uuid: string;
  action: string;
  send(payload: unknown): void;
  getSettings(): void;
  setSettings(payload: BrightnessButtonSettings | DialSettings): void;
  getGlobalSettings(): void;
  setGlobalSettings(payload: GlobalSettings): void;
  sendToPlugin(payload: { event: string }): void;
}

export interface DialSettings {
  selectedMonitors: string[];
  stepSize: number;
  controlMode?: 'brightness' | 'contrast';
}

export type ConnectElgatoStreamDeckSocket = (
  inPort: string,
  inUUID: string,
  inRegisterEvent: string,
  inInfo: string,
  inActionInfo: string
) => void;

declare global {
  interface Window {
    streamDeck?: StreamDeck;
    connectElgatoStreamDeckSocket?: ConnectElgatoStreamDeckSocket;
  }
}

export interface Monitor {
  id: string;
  name: string;
  brightness: number;
  available: boolean;
  backend?: string;
  runtimeIndex?: number;
  serialNumber?: string;
  modelName?: string;
  manufacturerId?: string;
}
