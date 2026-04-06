import { tauriInvoke } from './tauri';
import { detectMobileFormFactor, isAndroidRuntime } from './runtime';

interface PluginBiometricStatus {
  isAvailable: boolean;
  biometryType: string;
  error?: string;
  errorCode?: string;
}

const BIOMETRIC_MASTER_PASSWORD_KEY = 'orbitterm.biometric.master-password';

const ensureMobileRuntime = (): void => {
  if (!detectMobileFormFactor() && !isAndroidRuntime()) {
    throw new Error('当前仅移动端支持生物识别解锁。');
  }
};

export const readBiometricStatus = async (): Promise<PluginBiometricStatus> => {
  ensureMobileRuntime();
  try {
    const status = await tauriInvoke<PluginBiometricStatus>('mobile_biometric_status');
    return status;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || '生物识别状态检测失败。');
  }
};

export const authenticateByBiometric = async (reason: string): Promise<void> => {
  ensureMobileRuntime();
  try {
    await tauriInvoke('mobile_biometric_authenticate', { reason });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || '生物识别验证失败。');
  }
};

export const saveBiometricMasterPassword = async (password: string): Promise<void> => {
  const normalized = password.trim();
  if (!normalized) {
    return;
  }
  try {
    await tauriInvoke('mobile_secure_store_set', {
      key: BIOMETRIC_MASTER_PASSWORD_KEY,
      value: normalized
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || '保存生物识别解锁凭据失败。');
  }
};

export const bindBiometricMasterPasswordFromSession = async (): Promise<void> => {
  try {
    await tauriInvoke('mobile_secure_store_set_from_vault_session', {
      key: BIOMETRIC_MASTER_PASSWORD_KEY
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message || '生物识别绑定失败，请先确认金库已解锁。');
  }
};

export const loadBiometricMasterPassword = async (): Promise<string | null> => {
  try {
    const result = await tauriInvoke<string | null>('mobile_secure_store_get', {
      key: BIOMETRIC_MASTER_PASSWORD_KEY
    });
    const password = typeof result === 'string' ? result.trim() : '';
    return password || null;
  } catch (_error) {
    return null;
  }
};

export const clearBiometricMasterPassword = async (): Promise<void> => {
  try {
    await tauriInvoke('mobile_secure_store_remove', {
      key: BIOMETRIC_MASTER_PASSWORD_KEY
    });
  } catch (_error) {
    // Ignore keychain cleanup errors.
  }
};
