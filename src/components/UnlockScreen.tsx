import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useHostStore } from '../store/useHostStore';
import { useI18n } from '../i18n/useI18n';
import { BrandLogo } from './BrandLogo';
import { detectMobileFormFactor } from '../services/runtime';
import { useUiSettingsStore } from '../store/useUiSettingsStore';
import {
  authenticateByBiometric,
  loadBiometricMasterPassword,
  readBiometricStatus
} from '../services/mobileBiometric';

interface UnlockScreenProps {
  isMobileView?: boolean;
}

export function UnlockScreen({ isMobileView }: UnlockScreenProps): JSX.Element {
  const { t } = useI18n();
  const unlockVault = useHostStore((state) => state.unlockVault);
  const unlockVaultWithCloud = useHostStore((state) => state.unlockVaultWithCloud);
  const isUnlocking = useHostStore((state) => state.isUnlocking);
  const unlockError = useHostStore((state) => state.unlockError);
  const mobileBiometricEnabled = useUiSettingsStore((state) => state.mobileBiometricEnabled);

  const [unlockMode, setUnlockMode] = useState<'master' | 'cloud'>('master');
  const [masterPassword, setMasterPassword] = useState<string>('');
  const [cloudEmail, setCloudEmail] = useState<string>('');
  const [cloudPassword, setCloudPassword] = useState<string>('');
  const [isBiometricPending, setIsBiometricPending] = useState<boolean>(false);
  const [isBiometricAvailable, setIsBiometricAvailable] = useState<boolean>(false);
  const [mobileKeyboardInset, setMobileKeyboardInset] = useState<number>(0);
  const biometricRunningRef = useRef<boolean>(false);
  const lastBiometricAttemptAtRef = useRef<number>(0);
  const suppressAutoBiometricRef = useRef<boolean>(false);
  const autoBiometricTriedInVisibleSessionRef = useRef<boolean>(false);
  const isMobile = isMobileView ?? detectMobileFormFactor();
  const allowCloudUnlock = !isMobile;
  const canUnlock =
    unlockMode === 'master'
      ? masterPassword.trim().length > 0
      : allowCloudUnlock && cloudEmail.trim().length > 0 && cloudPassword.trim().length > 0;

  useEffect(() => {
    if (!isMobile || !mobileBiometricEnabled) {
      setIsBiometricAvailable(false);
      return;
    }
    let canceled = false;
    void (async () => {
      try {
        const status = await readBiometricStatus();
        if (!canceled) {
          setIsBiometricAvailable(status.isAvailable);
        }
      } catch (_error) {
        if (!canceled) {
          setIsBiometricAvailable(false);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [isMobile, mobileBiometricEnabled]);

  useEffect(() => {
    if (!allowCloudUnlock) {
      setUnlockMode('master');
    }
  }, [allowCloudUnlock]);

  useEffect(() => {
    if (!isMobile || typeof window === 'undefined' || !window.visualViewport) {
      setMobileKeyboardInset(0);
      return;
    }
    const viewport = window.visualViewport;
    const syncInset = (): void => {
      const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
      setMobileKeyboardInset(inset);
    };
    syncInset();
    viewport.addEventListener('resize', syncInset);
    viewport.addEventListener('scroll', syncInset);
    return () => {
      viewport.removeEventListener('resize', syncInset);
      viewport.removeEventListener('scroll', syncInset);
      setMobileKeyboardInset(0);
    };
  }, [isMobile]);

  const runUnlock = async (): Promise<void> => {
    if (isUnlocking) {
      return;
    }

    if (unlockMode === 'master') {
      if (!masterPassword.trim()) {
        return;
      }
      await unlockVault(masterPassword);
      setMasterPassword('');
      return;
    }

    if (!allowCloudUnlock || !cloudEmail.trim() || !cloudPassword.trim()) {
      return;
    }

    await unlockVaultWithCloud(cloudEmail, cloudPassword);
    setCloudPassword('');
  };

  const runBiometricUnlock = useCallback(async (options?: {
    silentCancel?: boolean;
    source?: 'auto' | 'manual';
  }): Promise<void> => {
    if (isBiometricPending || isUnlocking || biometricRunningRef.current) {
      return;
    }
    const now = Date.now();
    if (options?.source === 'auto') {
      if (suppressAutoBiometricRef.current) {
        return;
      }
      if (now - lastBiometricAttemptAtRef.current < 1800) {
        return;
      }
    }
    biometricRunningRef.current = true;
    lastBiometricAttemptAtRef.current = now;
    setIsBiometricPending(true);
    try {
      await authenticateByBiometric('使用 Face ID / Touch ID 解锁 OrbitTerm 金库');
      const boundMasterPassword = await loadBiometricMasterPassword();
      if (!boundMasterPassword) {
        if (options?.source === 'auto') {
          suppressAutoBiometricRef.current = true;
        }
        toast.error('未检测到已绑定的金库解锁凭据，请在设置中重新启用 Face ID / Touch ID。');
        return;
      }
      suppressAutoBiometricRef.current = false;
      await unlockVault(boundMasterPassword);
    } catch (error) {
      const fallback = '生物识别解锁失败，请改用金库密码或账号密码解锁。';
      const message = error instanceof Error ? error.message : fallback;
      if (
        options?.silentCancel &&
        /cancel|取消|canceled|用户取消|authentication failed|auth failed|system cancel|app cancel/i.test(
          message
        )
      ) {
        suppressAutoBiometricRef.current = true;
        return;
      }
      if (options?.source === 'auto') {
        suppressAutoBiometricRef.current = true;
      }
      toast.error(message || fallback);
    } finally {
      setIsBiometricPending(false);
      biometricRunningRef.current = false;
    }
  }, [isBiometricPending, isUnlocking, unlockVault]);

  useEffect(() => {
    if (!isMobile || !mobileBiometricEnabled || !isBiometricAvailable) {
      suppressAutoBiometricRef.current = false;
      autoBiometricTriedInVisibleSessionRef.current = false;
      return;
    }
    const triggerAutoBiometric = (): void => {
      if (document.visibilityState !== 'visible') {
        autoBiometricTriedInVisibleSessionRef.current = false;
        return;
      }
      if (
        isUnlocking ||
        isBiometricPending ||
        biometricRunningRef.current ||
        autoBiometricTriedInVisibleSessionRef.current
      ) {
        return;
      }
      if (suppressAutoBiometricRef.current && Date.now() - lastBiometricAttemptAtRef.current < 3500) {
        return;
      }
      autoBiometricTriedInVisibleSessionRef.current = true;
      void runBiometricUnlock({ silentCancel: true, source: 'auto' });
    };
    triggerAutoBiometric();
    document.addEventListener('visibilitychange', triggerAutoBiometric);
    return () => {
      document.removeEventListener('visibilitychange', triggerAutoBiometric);
    };
  }, [isBiometricAvailable, isBiometricPending, isMobile, isUnlocking, mobileBiometricEnabled, runBiometricUnlock]);

  return (
    <main
      className={`relative min-h-screen overflow-hidden ${
        isMobile ? 'px-0 py-0' : 'flex items-center justify-center px-4 py-4 sm:px-6'
      }`}
      style={{
        transform: isMobile && mobileKeyboardInset > 0 ? `translateY(-${mobileKeyboardInset}px)` : undefined,
        transition: isMobile ? 'transform 120ms ease' : undefined
      }}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.42),transparent_35%),radial-gradient(circle_at_78%_16%,rgba(190,220,255,0.5),transparent_32%),radial-gradient(circle_at_50%_82%,rgba(225,238,255,0.75),transparent_45%)]" />
      <section
        className={`glass-card relative w-full ${
          isMobile
            ? 'min-h-screen border-0 bg-white/55 px-4 pb-[calc(1rem+env(safe-area-inset-bottom))] pt-[calc(0.9rem+env(safe-area-inset-top))]'
            : 'max-w-xl rounded-3xl border border-white/60 bg-white/45 p-6 shadow-glass sm:p-10'
        }`}
      >
        <BrandLogo className="mx-auto h-16 w-16 rounded-2xl border border-white/65 shadow-[0_14px_30px_rgba(15,23,42,0.22)]" />
        <p className="text-center text-xs font-semibold uppercase tracking-[0.24em] text-slate-500">
          OrbitTerm · 轨连终端
        </p>
        <h1 className="mt-3 text-center text-[2rem] font-semibold text-slate-900">OrbitTerm</h1>
        <p className="mt-1 text-center text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
          Vault Unlock
        </p>
        <h2 className="mt-4 text-center text-2xl font-semibold text-slate-900">{t('unlock.title')}</h2>
        <p className="mt-2 text-center text-sm text-slate-600">
          {unlockMode === 'master' ? t('unlock.subtitle') : t('unlock.subtitleCloud')}
        </p>

        <div className={`mt-6 grid gap-2 rounded-2xl border border-white/55 bg-white/60 p-1 ${allowCloudUnlock ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <button
            className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
              unlockMode === 'master'
                ? 'bg-frost-accent/15 text-frost-accent shadow-[inset_0_0_0_1px_rgba(60,130,246,0.28)]'
                : 'text-slate-600 hover:bg-white/70'
            }`}
            disabled={isUnlocking}
            onClick={() => setUnlockMode('master')}
            type="button"
          >
            {t('unlock.tabMaster')}
          </button>
          {allowCloudUnlock && (
            <button
              className={`rounded-xl px-3 py-2 text-sm font-semibold transition ${
                unlockMode === 'cloud'
                  ? 'bg-frost-accent/15 text-frost-accent shadow-[inset_0_0_0_1px_rgba(60,130,246,0.28)]'
                  : 'text-slate-600 hover:bg-white/70'
              }`}
              disabled={isUnlocking}
              onClick={() => setUnlockMode('cloud')}
              type="button"
            >
              {t('unlock.tabCloud')}
            </button>
          )}
        </div>

        {isMobile && mobileBiometricEnabled && isBiometricAvailable && (
          <button
            className="mt-3 w-full rounded-2xl border border-slate-300 bg-white/70 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-white/85 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isBiometricPending || isUnlocking}
            onClick={() => {
              suppressAutoBiometricRef.current = false;
              void runBiometricUnlock({ source: 'manual' });
            }}
            type="button"
          >
            {isBiometricPending
              ? '正在唤起生物识别...'
              : 'Face ID / Touch ID 解锁'}
          </button>
        )}

        {unlockMode === 'master' || !allowCloudUnlock ? (
          <div className="mt-6">
            <input
              autoComplete="current-password"
              className="w-full rounded-2xl border border-white/65 bg-white/75 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-frost-accent/70 focus:ring-2 focus:ring-frost-accent/20"
              disabled={isUnlocking}
              onChange={(event) => setMasterPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runUnlock();
                }
              }}
              placeholder={
                isUnlocking ? t('unlock.passwordPlaceholderUnlocking') : t('unlock.passwordPlaceholder')
              }
              type="password"
              value={masterPassword}
            />
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            <input
              autoComplete="email"
              className="w-full rounded-2xl border border-white/65 bg-white/75 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-frost-accent/70 focus:ring-2 focus:ring-frost-accent/20"
              disabled={isUnlocking}
              onChange={(event) => setCloudEmail(event.target.value)}
              placeholder={t('unlock.cloudEmailPlaceholder')}
              type="email"
              value={cloudEmail}
            />
            <input
              autoComplete="current-password"
              className="w-full rounded-2xl border border-white/65 bg-white/75 px-4 py-3 text-base text-slate-900 outline-none transition focus:border-frost-accent/70 focus:ring-2 focus:ring-frost-accent/20"
              disabled={isUnlocking}
              onChange={(event) => setCloudPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void runUnlock();
                }
              }}
              placeholder={t('unlock.cloudPasswordPlaceholder')}
              type="password"
              value={cloudPassword}
            />
          </div>
        )}

        <div className="mt-5">
          <button
            className="w-full rounded-2xl border border-[#3a73db] bg-[#2f6df4] px-4 py-3 text-base font-semibold text-white shadow-[0_10px_26px_rgba(47,109,244,0.34)] transition hover:bg-[#245ad0] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isUnlocking || !canUnlock}
            onClick={() => {
              void runUnlock();
            }}
            type="button"
          >
            {isUnlocking ? t('common.processing') : t('unlock.confirm')}
          </button>
        </div>

        {unlockError && <p className="mt-3 text-center text-sm text-rose-500">{unlockError}</p>}
      </section>
    </main>
  );
}
