/** How this device reaches the NAS, kept on the device (the token is the device's own key: never shown again). */
export type NasConfig = {
  url: string;
  token: string;
  deviceId: string;
  deviceName: string;
  userName: string;
};

const KEY = 'partymix.nas';

export function loadNasConfig(store: Storage | undefined): NasConfig | undefined {
  try {
    const j = JSON.parse(store?.getItem(KEY) ?? '') as Partial<NasConfig>;
    if (typeof j.url !== 'string' || typeof j.token !== 'string' || !j.url || !j.token) return undefined;
    return { url: j.url, token: j.token, deviceId: String(j.deviceId ?? ''), deviceName: String(j.deviceName ?? ''), userName: String(j.userName ?? '') };
  } catch {
    return undefined;
  }
}

export function saveNasConfig(store: Storage | undefined, c: NasConfig | undefined): void {
  try {
    if (c) store?.setItem(KEY, JSON.stringify(c)); else store?.removeItem(KEY);
  } catch { /* storage unavailable */ }
}
