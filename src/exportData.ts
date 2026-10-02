import { Platform } from 'react-native';
import { fetchDataExport } from './api';

/** Download (web) or share (native) everything Dimts holds about the account. */
export async function exportAllData() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  const name = `dimts-export-${new Date().toISOString().slice(0, 10)}.json`;
  try {
    const bytes = await fetchDataExport(controller.signal);
    if (Platform.OS === 'web') {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url; link.download = name;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
      return;
    }
    const Sharing = await import('expo-sharing');
    if (!await Sharing.isAvailableAsync()) throw new Error('File sharing is not available on this device.');
    const { File, Paths } = await import('expo-file-system');
    const file = new File(Paths.cache, name);
    if (file.exists) file.delete();
    file.create(); file.write(bytes);
    try { await Sharing.shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Save your Dimts data' }); }
    finally { if (file.exists) file.delete(); }
  } finally { clearTimeout(timer); }
}
