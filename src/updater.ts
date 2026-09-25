import { check, type Update } from '@tauri-apps/plugin-updater';
import { useCallback, useRef, useState } from 'react';
export function useUpdater() {
  const update = useRef<Update | null>(null),
    busy = useRef(false);
  const [status, setStatus] = useState('Updates are checked automatically.');
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const download = useCallback(async () => {
    if (!update.current || busy.current) return;
    busy.current = true;
    setStatus('Downloading update…');
    try {
      await update.current.download();
      setReady(true);
      setStatus(`Version ${update.current.version} is verified and ready to install.`);
    } catch (e) {
      setStatus(`Update download failed: ${String(e)}`);
    } finally {
      busy.current = false;
    }
  }, []);
  const checkNow = useCallback(
    async (autoDownload = true) => {
      if (busy.current || ready) return;
      busy.current = true;
      setStatus('Checking for updates…');
      try {
        update.current = await check({ timeout: 15000 });
        setAvailable(!!update.current);
        setStatus(
          update.current
            ? `Version ${update.current.version} is available.`
            : 'You have the latest version.',
        );
      } catch {
        setStatus('Update service is unavailable. Check your connection or try again later.');
      } finally {
        busy.current = false;
      }
      if (update.current && autoDownload) await download();
    },
    [download, ready],
  );
  const install = useCallback(async () => {
    if (!ready || !update.current) return;
    setStatus('Installing update…');
    await update.current.install();
  }, [ready]);
  return { status, ready, available, checkNow, download, install };
}
