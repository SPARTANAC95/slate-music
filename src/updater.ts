import { check } from '@tauri-apps/plugin-updater';
import { useState, useSyncExternalStore } from 'react';
import { UpdateController } from './updateController';

export function useUpdater() {
  const [controller] = useState(() => new UpdateController(() => check({ timeout: 15000 })));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return {
    ...state,
    checkNow: controller.checkNow,
    download: controller.download,
    install: controller.install,
  };
}
