import { detectMobileFormFactor } from './runtime';

export type MobileOrientationMode = 'portrait' | 'landscape' | 'auto';

let lastRequestedMode: MobileOrientationMode | null = null;

interface OrientationLike {
  lock?: (orientation: string) => Promise<unknown>;
  unlock?: () => void;
}

const supportsOrientationLock = (): boolean => {
  if (typeof screen === 'undefined') {
    return false;
  }
  const orientation = (screen.orientation as OrientationLike | undefined) ?? undefined;
  return typeof orientation?.lock === 'function';
};

export const applyMobileOrientationMode = async (
  mode: MobileOrientationMode
): Promise<boolean> => {
  if (!detectMobileFormFactor()) {
    return false;
  }
  if (lastRequestedMode === mode) {
    return false;
  }

  if (mode === 'auto') {
    const orientation = (screen.orientation as OrientationLike | undefined) ?? undefined;
    if (typeof orientation?.unlock === 'function') {
      try {
        orientation.unlock();
      } catch (_error) {
        // Ignore unlock failures on runtimes that soft-lock orientation.
      }
    }
    lastRequestedMode = mode;
    return true;
  }

  const lockTarget = mode === 'landscape' ? 'landscape-primary' : 'portrait-primary';
  if (!supportsOrientationLock()) {
    lastRequestedMode = mode;
    return false;
  }

  try {
    const orientation = screen.orientation as OrientationLike;
    if (!orientation.lock) {
      return false;
    }
    await orientation.lock(lockTarget);
    lastRequestedMode = mode;
    return true;
  } catch (_error) {
    return false;
  }
};
