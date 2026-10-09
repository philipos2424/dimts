import { Platform } from 'react-native';
import { fetchCallExport } from './api';

export type PreparedExport = { file: File; url: string; kind: 'notes' | 'audio' };

/**
 * Safari only lets a page save or share in direct response to a tap, and the
 * download takes longer than that allows. So the web fetches first, then a
 * second tap calls saveWebExport, which hands the file over synchronously.
 */
export async function prepareWebExport(id: string, kind: 'notes' | 'audio'): Promise<PreparedExport> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid call.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const bytes = await fetchCallExport(id, kind, controller.signal);
    const type = kind === 'audio' ? 'audio/mpeg' : 'text/plain';
    const file = new File([bytes as Uint8Array<ArrayBuffer>], `dimts-call-${id}.${kind === 'audio' ? 'mp3' : 'txt'}`, { type });
    return { file, url: URL.createObjectURL(file), kind };
  } finally { clearTimeout(timer); }
}

/** Call from a tap handler. iPhone shows the share sheet ("Save to Files"); desktops download. */
export function saveWebExport(prepared: PreparedExport): Promise<void> | void {
  const files = [prepared.file];
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files })) {
    return navigator.share({ files }).catch(err => { if (err?.name !== 'AbortError') throw err; });
  }
  const link = document.createElement('a');
  link.href = prepared.url; link.download = prepared.file.name;
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); }
}

export function releaseWebExport(prepared: PreparedExport | null) {
  // Delay so a download the browser just started can still read the file.
  if (prepared) setTimeout(() => URL.revokeObjectURL(prepared.url), 60_000);
}

export async function exportCall(id: string, kind: 'notes' | 'audio') {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid call.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const mimeType = kind === 'audio' ? 'audio/mpeg' : 'text/plain';
  const extension = kind === 'audio' ? 'mp3' : 'txt';
  try {
    if (Platform.OS === 'web') {
      const bytes = await fetchCallExport(id, kind, controller.signal);
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType }));
      const link = document.createElement('a');
      link.href = url; link.download = `dimts-call-${id}.${extension}`;
      document.body.appendChild(link);
      try { link.click(); } finally {
        link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      return;
    }
    const Sharing = await import('expo-sharing');
    if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is not available on this device.');
    const { Directory, File, Paths } = await import('expo-file-system');
    const folder = new Directory(Paths.cache, 'dimts-exports');
    folder.create({ idempotent: true });
    // Keep the current file long enough for a target app to read it after the
    // chooser returns. Prune only our own old temporary exports on the next use.
    for (const item of folder.list()) {
      const stamp = /^dimts-export-(\d+)-[a-z0-9]+\.(txt|mp3)$/.exec(item.name);
      if (item instanceof File && stamp && Date.now() - Number(stamp[1]) > 3_600_000) {
        try { item.delete(); } catch { /* OS cache cleanup can also remove it. */ }
      }
    }
    const file = new File(folder, `dimts-export-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
    try {
      const bytes = await fetchCallExport(id, kind, controller.signal);
      file.create(); file.write(bytes);
      await Sharing.shareAsync(file.uri, { mimeType, UTI: kind === 'audio' ? 'public.mp3' : 'public.plain-text', dialogTitle: 'Save or share your call' });
    } catch (err) {
      if (file.exists) file.delete();
      throw err;
    }
  } finally { clearTimeout(timer); }
}
