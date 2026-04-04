import { useState } from 'react';
import { useHostStore } from '../store/useHostStore';
import { useI18n } from '../i18n/useI18n';
import { BrandLogo } from './BrandLogo';

export function UnlockScreen(): JSX.Element {
  const { t } = useI18n();
  const unlockVault = useHostStore((state) => state.unlockVault);
  const unlockVaultWithCloud = useHostStore((state) => state.unlockVaultWithCloud);
  const isUnlocking = useHostStore((state) => state.isUnlocking);
  const unlockError = useHostStore((state) => state.unlockError);

  const [unlockMode, setUnlockMode] = useState<'master' | 'cloud'>('master');
  const [masterPassword, setMasterPassword] = useState<string>('');
  const [cloudEmail, setCloudEmail] = useState<string>('');
  const [cloudPassword, setCloudPassword] = useState<string>('');

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

    if (!cloudEmail.trim() || !cloudPassword.trim()) {
      return;
    }

    await unlockVaultWithCloud(cloudEmail, cloudPassword);
    setCloudPassword('');
  };

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden px-6">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(255,255,255,0.42),transparent_35%),radial-gradient(circle_at_78%_16%,rgba(190,220,255,0.5),transparent_32%),radial-gradient(circle_at_50%_82%,rgba(225,238,255,0.75),transparent_45%)]" />
      <section className="glass-card relative w-full max-w-xl rounded-3xl border border-white/60 bg-white/45 p-10 shadow-glass">
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

        <div className="mt-6 grid grid-cols-2 gap-2 rounded-2xl border border-white/55 bg-white/60 p-1">
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
        </div>

        {unlockMode === 'master' ? (
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

        {unlockError && <p className="mt-3 text-center text-sm text-rose-500">{unlockError}</p>}
      </section>
    </main>
  );
}
