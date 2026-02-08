/**
 * Win32 FFI bindings for physical monitor enumeration and EDID identification.
 * Uses koffi for direct native calls to correlate ddc-node WinAPI indices with
 * PNP Device IDs, then reads EDID data from the registry for stable identification.
 */
import koffi from 'koffi';

// ─── Exported Interfaces ────────────────────────────────────────────

/**
 * Mapping from physical monitor global index (matching ddc-node WinAPI index)
 * to a PNP device identifier.
 */
export interface PhysicalMonitorEntry {
  globalIndex: number;
  /** e.g. "GSM5BE1" */
  modelCode: string;
  /** e.g. "5&f876270&0&UID512" */
  instancePath: string;
}

/**
 * Monitor identification data read from registry EDID.
 * Always available for connected monitors, even when ddc-node's WinAPI
 * backend provides no EDID.
 */
export interface RegistryMonitorEntry {
  /** Friendly display name from EDID, e.g. "LG IPS QHD" */
  friendlyName: string;
  /** EDID serial number string, e.g. "304NTPC4A088" */
  serialNumber: string;
  /** Registry instance path, e.g. "DISPLAY\\GSM5BE1\\5&f876270&0&UID512" */
  instanceName: string;
  /** Manufacturer + model code, e.g. "GSM5BE1" */
  modelCode: string;
}

// ─── Koffi Struct Definitions ───────────────────────────────────────

const RECT = koffi.struct('RECT', {
  Left: 'long',
  Top: 'long',
  Right: 'long',
  Bottom: 'long',
});

const MONITORINFOEXW = koffi.struct('MONITORINFOEXW', {
  cbSize: 'uint32',
  rcMonitor: RECT,
  rcWork: RECT,
  dwFlags: 'uint32',
  szDevice: koffi.array('uint16', 32, 'Array'),
});

const DISPLAY_DEVICEW = koffi.struct('DISPLAY_DEVICEW', {
  cb: 'uint32',
  DeviceName: koffi.array('uint16', 32, 'Array'),
  DeviceString: koffi.array('uint16', 128, 'Array'),
  StateFlags: 'uint32',
  DeviceID: koffi.array('uint16', 128, 'Array'),
  DeviceKey: koffi.array('uint16', 128, 'Array'),
});

const PHYSICAL_MONITOR = koffi.struct('PHYSICAL_MONITOR', {
  hPhysicalMonitor: 'void *',
  szPhysicalMonitorDescription: koffi.array('uint16', 128, 'Array'),
});

const MonitorEnumProc = koffi.proto(
  'bool __stdcall MonitorEnumProc(void *hMonitor, void *hdcMonitor, void *lprcMonitor, long lParam)'
);

// ─── Lazy Win32 Function Bindings ───────────────────────────────────

type KoffiLib = ReturnType<typeof koffi.load>;
type Win32Fn = ReturnType<KoffiLib['func']>;

const dllCache = new Map<string, KoffiLib>();
const fnCache = new Map<string, Win32Fn>();

function loadDll(name: string): KoffiLib {
  let lib = dllCache.get(name);
  if (!lib) {
    lib = koffi.load(name);
    dllCache.set(name, lib);
  }
  return lib;
}

function bindWin32(dll: string, signature: string): Win32Fn {
  let fn = fnCache.get(signature);
  if (!fn) {
    fn = loadDll(dll).func(signature);
    fnCache.set(signature, fn);
  }
  return fn;
}

// Each getter lazily binds the Win32 function on first call, then returns the cached binding.
const win32 = {
  EnumDisplayMonitors: () =>
    bindWin32(
      'user32.dll',
      'bool __stdcall EnumDisplayMonitors(void *hdc, void *lprcClip, MonitorEnumProc *lpfnEnum, long dwData)'
    ),
  GetMonitorInfoW: () =>
    bindWin32(
      'user32.dll',
      'bool __stdcall GetMonitorInfoW(void *hMonitor, _Inout_ MONITORINFOEXW *lpmi)'
    ),
  EnumDisplayDevicesW: () =>
    bindWin32(
      'user32.dll',
      'bool __stdcall EnumDisplayDevicesW(str16 lpDevice, uint32 iDevNum, _Inout_ DISPLAY_DEVICEW *lpDisplayDevice, uint32 dwFlags)'
    ),
  GetNumberOfPhysicalMonitorsFromHMONITOR: () =>
    bindWin32(
      'dxva2.dll',
      'bool __stdcall GetNumberOfPhysicalMonitorsFromHMONITOR(void *hMonitor, _Out_ uint32 *pdwNumberOfPhysicalMonitors)'
    ),
  GetPhysicalMonitorsFromHMONITOR: () =>
    bindWin32(
      'dxva2.dll',
      'bool __stdcall GetPhysicalMonitorsFromHMONITOR(void *hMonitor, uint32 dwPhysicalMonitorArraySize, _Out_ PHYSICAL_MONITOR *pPhysicalMonitorArray)'
    ),
  DestroyPhysicalMonitors: () =>
    bindWin32(
      'dxva2.dll',
      'bool __stdcall DestroyPhysicalMonitors(uint32 dwPhysicalMonitorArraySize, PHYSICAL_MONITOR *pPhysicalMonitorArray)'
    ),
  RegOpenKeyExW: () =>
    bindWin32(
      'advapi32.dll',
      'long __stdcall RegOpenKeyExW(uintptr hKey, str16 lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ void **phkResult)'
    ),
  RegEnumKeyExW: () =>
    bindWin32(
      'advapi32.dll',
      'long __stdcall RegEnumKeyExW(void *hKey, uint32 dwIndex, void *lpName, _Inout_ uint32 *lpcchName, void *lpReserved, void *lpClass, void *lpcchClass, void *lpftLastWriteTime)'
    ),
  RegQueryValueExW: () =>
    bindWin32(
      'advapi32.dll',
      'long __stdcall RegQueryValueExW(void *hKey, str16 lpValueName, void *lpReserved, _Out_ uint32 *lpType, void *lpData, _Inout_ uint32 *lpcbData)'
    ),
  RegCloseKey: () => bindWin32('advapi32.dll', 'long __stdcall RegCloseKey(void *hKey)'),
};

// ─── Win32 Constants ────────────────────────────────────────────────

const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_READ = 0x20019;
const ERROR_SUCCESS = 0;
const EDD_GET_DEVICE_INTERFACE_NAME = 0x00000001;
const DISPLAY_DEVICE_ACTIVE = 0x00000001;

// ─── Struct Initialization Helpers ──────────────────────────────────

function createMonitorInfoEx(): Record<string, unknown> {
  return {
    cbSize: koffi.sizeof(MONITORINFOEXW),
    rcMonitor: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    rcWork: { Left: 0, Top: 0, Right: 0, Bottom: 0 },
    dwFlags: 0,
    szDevice: new Array(32).fill(0),
  };
}

function createDisplayDevice(): Record<string, unknown> {
  return {
    cb: koffi.sizeof(DISPLAY_DEVICEW),
    DeviceName: new Array(32).fill(0),
    DeviceString: new Array(128).fill(0),
    StateFlags: 0,
    DeviceID: new Array(128).fill(0),
    DeviceKey: new Array(128).fill(0),
  };
}

/** Decode a koffi uint16 array to a JS string, stopping at NUL. */
function decodeWcharArray(arr: number[]): string {
  const end = arr.indexOf(0);
  const chars = end >= 0 ? arr.slice(0, end) : arr;
  return String.fromCharCode(...chars);
}

// ─── Physical Monitor Mapping ───────────────────────────────────────

/**
 * Enumerate physical monitors via Win32 APIs and return the PNP Device ID
 * for each. The ordering matches ddc-node's WinAPI backend indices.
 *
 * Flow: EnumDisplayMonitors -> GetMonitorInfoW (device name) ->
 * EnumDisplayDevicesW (PNP ID) -> GetPhysicalMonitorsFromHMONITOR (count).
 */
export function getPhysicalMonitorMapping(): PhysicalMonitorEntry[] {
  const result: PhysicalMonitorEntry[] = [];
  let globalIndex = 0;

  const callback = koffi.register((hMon: unknown) => {
    const deviceName = getMonitorDeviceName(hMon);
    const deviceID = findActiveDisplayDeviceID(deviceName);

    const count = [0];
    if (win32.GetNumberOfPhysicalMonitorsFromHMONITOR()(hMon, count) && count[0] > 0) {
      const physMonsBuf = koffi.alloc(PHYSICAL_MONITOR, count[0]);
      if (win32.GetPhysicalMonitorsFromHMONITOR()(hMon, count[0], physMonsBuf)) {
        const pnpMatch = deviceID.match(/DISPLAY#([^#]+)#([^#]+)#/);
        for (let i = 0; i < count[0]; i++) {
          if (pnpMatch) {
            result.push({
              globalIndex,
              modelCode: pnpMatch[1],
              instancePath: pnpMatch[2],
            });
          }
          globalIndex++;
        }
      }
      win32.DestroyPhysicalMonitors()(count[0], physMonsBuf);
      koffi.free(physMonsBuf);
    }

    return true;
  }, koffi.pointer(MonitorEnumProc));

  try {
    win32.EnumDisplayMonitors()(null, null, callback, 0);
  } finally {
    koffi.unregister(callback);
  }

  return result;
}

/** Get the device name (e.g. "\\\\.\\DISPLAY1") for an HMONITOR. */
function getMonitorDeviceName(hMon: unknown): string {
  const mi = createMonitorInfoEx();
  win32.GetMonitorInfoW()(hMon, mi);
  return decodeWcharArray(mi.szDevice as number[]);
}

/** Find the active child display device and return its PNP Device ID. */
function findActiveDisplayDeviceID(deviceName: string): string {
  for (let i = 0; i < 10; i++) {
    const dd = createDisplayDevice();
    if (!win32.EnumDisplayDevicesW()(deviceName, i, dd, EDD_GET_DEVICE_INTERFACE_NAME)) {
      continue;
    }
    if ((dd.StateFlags as number) & DISPLAY_DEVICE_ACTIVE) {
      return decodeWcharArray(dd.DeviceID as number[]);
    }
  }
  return '';
}

// ─── EDID Parsing ───────────────────────────────────────────────────

interface EdidInfo {
  serialNumber: string;
  friendlyName: string;
  manufacturer: string;
}

/** PNP manufacturer ID from EDID bytes 8-9 (three 5-bit chars, A=1). */
function parseEdidManufacturer(edid: Buffer): string {
  const b1 = edid[8];
  const b2 = edid[9];
  return String.fromCharCode(
    ((b1 >> 2) & 0x1f) + 64,
    (((b1 & 0x03) << 3) | ((b2 >> 5) & 0x07)) + 64,
    (b2 & 0x1f) + 64
  );
}

/** Extract a string from an EDID descriptor block (bytes 5-17, strip padding). */
function parseEdidDescriptorString(descriptor: Buffer): string {
  const data = descriptor.subarray(5, 18);
  let str = '';
  for (const byte of data) {
    if (byte === 0x0a || byte === 0x00) break;
    str += String.fromCharCode(byte);
  }
  return str.trim();
}

/** Parse a 128+ byte EDID blob for serial number, friendly name, and manufacturer. */
function parseEdid(edid: Buffer): EdidInfo {
  const info: EdidInfo = {
    serialNumber: '',
    friendlyName: '',
    manufacturer: parseEdidManufacturer(edid),
  };

  // EDID has four 18-byte descriptor blocks starting at offset 54
  for (let i = 0; i < 4; i++) {
    const offset = 54 + i * 18;
    if (offset + 18 > edid.length) break;

    const descriptor = edid.subarray(offset, offset + 18);

    // Display descriptors have 0x00 in the first two bytes
    if (descriptor[0] !== 0 || descriptor[1] !== 0) continue;

    const tag = descriptor[3];
    if (tag === 0xff) {
      info.serialNumber = parseEdidDescriptorString(descriptor);
    } else if (tag === 0xfc) {
      info.friendlyName = parseEdidDescriptorString(descriptor);
    }
  }

  return info;
}

// ─── Registry EDID Reading ──────────────────────────────────────────

/**
 * Read monitor identification data from Windows registry EDID entries.
 * Registry path: HKLM\SYSTEM\CurrentControlSet\Enum\DISPLAY\{modelCode}\{instancePath}\Device Parameters\EDID
 *
 * Returns a map keyed by "{modelCode}|{instancePath}" for lookup by
 * physical monitor mapping results.
 */
export function getRegistryMonitorInfo(): Map<string, RegistryMonitorEntry> {
  const result = new Map<string, RegistryMonitorEntry>();
  const basePath = 'SYSTEM\\CurrentControlSet\\Enum\\DISPLAY';

  const displayKey = [null];
  if (
    win32.RegOpenKeyExW()(HKEY_LOCAL_MACHINE, basePath, 0, KEY_READ, displayKey) !== ERROR_SUCCESS
  ) {
    return result;
  }

  try {
    for (const modelCode of enumSubkeys(displayKey[0])) {
      readModelCodeEntries(basePath, modelCode, result);
    }
  } finally {
    win32.RegCloseKey()(displayKey[0]);
  }

  return result;
}

/** Read all instance entries under a single model code subkey. */
function readModelCodeEntries(
  basePath: string,
  modelCode: string,
  result: Map<string, RegistryMonitorEntry>
): void {
  const modelPath = `${basePath}\\${modelCode}`;
  const modelKey = [null];
  if (
    win32.RegOpenKeyExW()(HKEY_LOCAL_MACHINE, modelPath, 0, KEY_READ, modelKey) !== ERROR_SUCCESS
  ) {
    return;
  }

  try {
    for (const instancePath of enumSubkeys(modelKey[0])) {
      const edid = readEdidFromRegistry(modelPath, instancePath);
      if (!edid) continue;

      const parsed = parseEdid(edid);
      result.set(`${modelCode}|${instancePath}`, {
        friendlyName: parsed.friendlyName,
        serialNumber: parsed.serialNumber,
        instanceName: `DISPLAY\\${modelCode}\\${instancePath}`,
        modelCode,
      });
    }
  } finally {
    win32.RegCloseKey()(modelKey[0]);
  }
}

/** Enumerate subkey names under a registry key. */
function enumSubkeys(hKey: unknown): string[] {
  const names: string[] = [];
  const nameBuf = Buffer.alloc(512);

  for (let i = 0; ; i++) {
    const nameLen = [256];
    const status = win32.RegEnumKeyExW()(hKey, i, nameBuf, nameLen, null, null, null, null);
    if (status !== ERROR_SUCCESS) break;

    names.push(nameBuf.toString('utf16le', 0, nameLen[0] * 2));
  }

  return names;
}

/** Read EDID binary data from the registry for a given display device. */
function readEdidFromRegistry(modelPath: string, instancePath: string): Buffer | null {
  const devParamsPath = `${modelPath}\\${instancePath}\\Device Parameters`;
  const devParamsKey = [null];
  if (
    win32.RegOpenKeyExW()(HKEY_LOCAL_MACHINE, devParamsPath, 0, KEY_READ, devParamsKey) !==
    ERROR_SUCCESS
  ) {
    return null;
  }

  try {
    const dataSize = [0];
    const type = [0];

    if (
      win32.RegQueryValueExW()(devParamsKey[0], 'EDID', null, type, null, dataSize) !==
        ERROR_SUCCESS ||
      dataSize[0] === 0
    ) {
      return null;
    }

    const dataBuf = Buffer.alloc(dataSize[0]);
    if (
      win32.RegQueryValueExW()(devParamsKey[0], 'EDID', null, type, dataBuf, dataSize) !==
      ERROR_SUCCESS
    ) {
      return null;
    }

    return dataBuf;
  } finally {
    win32.RegCloseKey()(devParamsKey[0]);
  }
}
