import type { ConnectElgatoStreamDeckSocket, StreamDeck } from './shared-types';

export const STREAMDECK_MESSAGE_EVENT = 'streamdeck-message';
export const MONITOR_LIST_EVENT = 'monitor-list';

export interface StreamDeckMessage {
  event: string;
  payload?: Record<string, unknown>;
  action?: string;
  context?: string;
}

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const isStreamDeckMessage = (value: unknown): value is StreamDeckMessage => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'event' in value && typeof (value as { event?: unknown }).event === 'string';
};

const isSocketOpen = (streamDeck?: StreamDeck) =>
  streamDeck?.websocket?.readyState === WebSocket.OPEN;

export const onStreamDeckMessage = (handler: (message: StreamDeckMessage) => void) => {
  const listener = (event: Event) => handler((event as CustomEvent).detail as StreamDeckMessage);
  window.addEventListener(STREAMDECK_MESSAGE_EVENT, listener as EventListener);
  return () => window.removeEventListener(STREAMDECK_MESSAGE_EVENT, listener as EventListener);
};

export const dispatchStreamDeckMessage = (message: StreamDeckMessage) => {
  window.dispatchEvent(new CustomEvent(STREAMDECK_MESSAGE_EVENT, { detail: message }));
};

export const onMonitorList = (handler: (payload: unknown) => void) => {
  const listener = (event: Event) => handler((event as CustomEvent).detail);
  window.addEventListener(MONITOR_LIST_EVENT, listener as EventListener);
  return () => window.removeEventListener(MONITOR_LIST_EVENT, listener as EventListener);
};

export const dispatchMonitorList = (payload: unknown) => {
  window.dispatchEvent(new CustomEvent(MONITOR_LIST_EVENT, { detail: payload }));
};

export const openUrl = (url: string) => {
  window.streamDeck?.send({ event: 'openUrl', payload: { url } });
};

export const requestMonitors = () => {
  if (isSocketOpen(window.streamDeck)) {
    window.streamDeck?.sendToPlugin({ event: 'getMonitors' });
  }
};

// Stream Deck requires this global entrypoint name for Property Inspectors.
export const registerPropertyInspector = () => {
  const connectElgatoStreamDeckSocket: ConnectElgatoStreamDeckSocket = (
    inPort,
    inUUID,
    inRegisterEvent,
    _inInfo,
    inActionInfo
  ) => {
    const parsedActionInfo = parseJson(inActionInfo);
    const actionInfo =
      parsedActionInfo && typeof parsedActionInfo === 'object'
        ? (parsedActionInfo as { action?: string })
        : {};
    const uuid = inUUID;
    const ws = new WebSocket(`ws://127.0.0.1:${inPort}`);

    const send = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    };

    ws.onopen = () => {
      console.log('PI WebSocket connected');
      ws.send(JSON.stringify({ event: inRegisterEvent, uuid }));
      send({ event: 'getSettings', context: uuid });
      send({ event: 'getGlobalSettings', context: uuid });
      // Note: getMonitors is requested by the UI once listeners are active.
    };

    ws.onmessage = (evt) => {
      if (typeof evt.data !== 'string') {
        console.warn('PI received non-string message');
        return;
      }
      const parsed = parseJson(evt.data);
      if (!isStreamDeckMessage(parsed)) {
        console.warn('PI received non-standard message');
        return;
      }
      console.log('PI received message:', parsed.event);
      dispatchStreamDeckMessage(parsed);
    };

    ws.onerror = (error) => {
      console.error('PI WebSocket error:', error);
    };

    window.streamDeck = {
      websocket: ws,
      uuid,
      action: actionInfo.action ?? '',
      send,
      setSettings: (settings) => send({ event: 'setSettings', context: uuid, payload: settings }),
      setGlobalSettings: (settings) =>
        send({ event: 'setGlobalSettings', context: uuid, payload: settings }),
      getSettings: () => send({ event: 'getSettings', context: uuid }),
      getGlobalSettings: () => send({ event: 'getGlobalSettings', context: uuid }),
      sendToPlugin: (payload) =>
        send({ event: 'sendToPlugin', action: actionInfo.action, payload, context: uuid }),
    };
  };

  window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
};
