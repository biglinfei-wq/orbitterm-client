import { invoke as tauriApiInvoke } from '@tauri-apps/api/core';

type TauriInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

type CompatTauriWindow = Window & {
  __TAURI__?: {
    invoke?: TauriInvoke;
    core?: {
      invoke?: TauriInvoke;
    };
  };
};

const getInvoke = (): TauriInvoke => {
  const compatWindow = typeof window === 'undefined' ? null : (window as CompatTauriWindow);

  const legacyInvoke = compatWindow?.__TAURI__?.invoke;
  if (legacyInvoke) {
    return legacyInvoke;
  }

  const coreInvoke = compatWindow?.__TAURI__?.core?.invoke;
  if (coreInvoke) {
    return coreInvoke;
  }

  return tauriApiInvoke as TauriInvoke;
};

export const tauriInvoke = async <T>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> => {
  try {
    const invoke = getInvoke();
    return await invoke<T>(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes('__TAURI_IPC__') ||
      message.includes('__TAURI_INTERNALS__') ||
      message.includes('not running in Tauri')
    ) {
      throw new Error('未检测到 Tauri 运行环境，请在 OrbitTerm 客户端应用中执行。');
    }
    throw error;
  }
};
