type TauriInternals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
const tauri = () => (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;

export const hasNativeDisplays = () => !!tauri();

export async function listDisplays(): Promise<string[]> {
  const t = tauri();
  return t ? ((await t.invoke('list_displays')) as string[]) : [];
}

export async function openProjector(display?: string): Promise<void> {
  const t = tauri();
  if (t) await t.invoke('open_projector', { display });
  else window.open('/projector.html', 'partymix-projector', 'popup,width=1280,height=720');
}

export async function closeProjector(): Promise<void> {
  await tauri()?.invoke('close_projector');
}
