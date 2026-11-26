import { linuxBackend } from './linux.js';
import { macosBackend } from './macos.js';
import type { ServiceBackend, ServiceSystem } from './types.js';
import { windowsBackend } from './windows.js';

/** The backend for this system's platform; null where the background service is not supported. */
export function serviceBackend(system: ServiceSystem): ServiceBackend | null {
  switch (system.platform) {
    case 'win32':
      return windowsBackend(system);
    case 'darwin':
      return macosBackend(system);
    case 'linux':
      return linuxBackend(system);
    default:
      return null;
  }
}
