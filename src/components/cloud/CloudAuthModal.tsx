import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  CloudSyncRequestError,
  discoverCloudSyncPolicy,
  fetchCloudSyncPolicy,
  isCloudBootstrapDiscoveryConfigured,
  resetCloudPassword,
  readCloudSyncPolicy,
  sendCloudRegisterVerifyCode,
  sendCloudPasswordResetCode,
  shouldAllowManualSyncUrlEntry,
  type CloudSyncPolicy
} from '../../services/cloudSync';
import { logAppError, logAppWarn } from '../../services/appLog';
import { useHostStore } from '../../store/useHostStore';
import { useI18n } from '../../i18n/useI18n';

interface CloudAuthModalProps {
  open: boolean;
  onSkip: () => void;
  onSuccess: () => void;
}

interface CloudAuthHints {
  apiBaseUrl: string;
  email: string;
}

const CLOUD_AUTH_HINT_KEY = 'orbitterm:cloud-auth-hints:v1';

const readAuthHints = (): CloudAuthHints => {
  const fallback: CloudAuthHints = {
    apiBaseUrl: '',
    email: ''
  };
  const raw = window.localStorage.getItem(CLOUD_AUTH_HINT_KEY);
  if (!raw) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloudAuthHints>;
    return {
      apiBaseUrl: typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '',
      email: typeof parsed.email === 'string' ? parsed.email : ''
    };
  } catch (_error) {
    return fallback;
  }
};

const writeAuthHints = (hints: CloudAuthHints): void => {
  window.localStorage.setItem(CLOUD_AUTH_HINT_KEY, JSON.stringify(hints));
};

const isLikelyNetworkFailure = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror when attempting to fetch resource') ||
    normalized.includes('network request failed') ||
    normalized.includes('连接同步服务失败')
  );
};

const extractErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || fallback;
  }
  if (typeof error === 'string') {
    const message = error.trim();
    return message || fallback;
  }
  return fallback;
};

const maskEmailForLog = (email: string): string => {
  const trimmed = email.trim();
  if (!trimmed.includes('@')) {
    return trimmed || 'unknown';
  }
  const [local = '', domain = ''] = trimmed.split('@');
  const prefix = local.slice(0, 2);
  return `${prefix || '*'}***@${domain || '**'}`;
};

export function CloudAuthModal({ open, onSkip, onSuccess }: CloudAuthModalProps): JSX.Element | null {
  const { t } = useI18n();
  const isSyncingCloud = useHostStore((state) => state.isSyncingCloud);
  const cloudSyncError = useHostStore((state) => state.cloudSyncError);
  const registerCloudAccount = useHostStore((state) => state.registerCloudAccount);
  const loginCloudAccount = useHostStore((state) => state.loginCloudAccount);

  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [registerVerifyCode, setRegisterVerifyCode] = useState<string>('');
  const [isSendingRegisterVerifyCode, setIsSendingRegisterVerifyCode] = useState<boolean>(false);
  const [otpCode, setOtpCode] = useState<string>('');
  const [backupCode, setBackupCode] = useState<string>('');
  const [show2FAInput, setShow2FAInput] = useState<boolean>(false);
  const [showResetPanel, setShowResetPanel] = useState<boolean>(false);
  const [resetCode, setResetCode] = useState<string>('');
  const [resetNewPassword, setResetNewPassword] = useState<string>('');
  const [resetNewPasswordConfirm, setResetNewPasswordConfirm] = useState<string>('');
  const [isSendingResetCode, setIsSendingResetCode] = useState<boolean>(false);
  const [isSubmittingReset, setIsSubmittingReset] = useState<boolean>(false);
  const [policy, setPolicy] = useState<CloudSyncPolicy | null>(null);
  const [isDiscoveringBootstrap, setIsDiscoveringBootstrap] = useState<boolean>(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);

  const bootstrapConfigured = isCloudBootstrapDiscoveryConfigured();
  const allowManualSyncUrlEntry = shouldAllowManualSyncUrlEntry();

  useEffect(() => {
    if (!open) {
      return;
    }
    const hints = readAuthHints();
    const cachedPolicy = readCloudSyncPolicy();
    setPolicy(cachedPolicy);
    const hintedDomain = hints.apiBaseUrl.trim();
    const cachedDomain = cachedPolicy?.defaultSyncDomain?.trim() || '';
    setApiBaseUrl(cachedDomain || hintedDomain);
    setEmail(hints.email);
    setPassword('');
    setRegisterVerifyCode('');
    setIsSendingRegisterVerifyCode(false);
    setOtpCode('');
    setBackupCode('');
    setShowResetPanel(false);
    setResetCode('');
    setResetNewPassword('');
    setResetNewPasswordConfirm('');
    setShow2FAInput(false);
    setBootstrapError(null);
    setIsDiscoveringBootstrap(false);
  }, [allowManualSyncUrlEntry, open]);

  useEffect(() => {
    if (!open || !policy?.lockSyncDomain || !policy.defaultSyncDomain) {
      return;
    }
    setApiBaseUrl(policy.defaultSyncDomain);
  }, [open, policy]);

  useEffect(() => {
    if (!open || !bootstrapConfigured) {
      return;
    }
    let cancelled = false;
    setIsDiscoveringBootstrap(true);
    setBootstrapError(null);
    void discoverCloudSyncPolicy()
      .then((nextPolicy) => {
        if (cancelled) {
          return;
        }
        setPolicy(nextPolicy);
        if (nextPolicy.defaultSyncDomain) {
          setApiBaseUrl(nextPolicy.defaultSyncDomain);
        }
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        const fallback = t('cloud.bootstrapFailed');
        const message = error instanceof Error ? error.message : fallback;
        setBootstrapError(message || fallback);
      })
      .finally(() => {
        if (!cancelled) {
          setIsDiscoveringBootstrap(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bootstrapConfigured, open, t]);

  const normalizedHints = useMemo<CloudAuthHints>(() => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const shouldForceAutoDomain = !allowManualSyncUrlEntry;
    const effectiveApiBaseUrl =
      shouldForceAutoDomain && discoveredDomain
        ? discoveredDomain
        : policy?.lockSyncDomain && discoveredDomain
          ? discoveredDomain
        : apiBaseUrl.trim();
    return {
      apiBaseUrl: effectiveApiBaseUrl,
      email: email.trim()
    };
  }, [allowManualSyncUrlEntry, apiBaseUrl, email, policy]);

  const refreshPolicyByEndpoint = async (endpoint: string): Promise<CloudSyncPolicy | null> => {
    if (!endpoint.trim()) {
      if (bootstrapConfigured) {
        try {
          const discovered = await discoverCloudSyncPolicy({ force: true });
          setPolicy(discovered);
          return discovered;
        } catch (error) {
          logAppWarn('cloud-sync-auth', '刷新策略失败：自动发现未成功', {
            stage: 'refresh-policy-discover',
            message: extractErrorMessage(error, '自动发现失败')
          });
          return policy;
        }
      }
      return policy;
    }
    try {
      const nextPolicy = await fetchCloudSyncPolicy(endpoint);
      setPolicy(nextPolicy);
      return nextPolicy;
    } catch (error) {
      logAppWarn('cloud-sync-auth', '刷新策略失败：直连同步策略接口未成功', {
        stage: 'refresh-policy-fetch',
        endpoint,
        message: extractErrorMessage(error, '策略接口不可用')
      });
      return policy;
    }
  };

  const resolvePreferredApiBase = (
    latestPolicy: CloudSyncPolicy | null,
    baseUrlCandidate: string
  ): string => {
    const policyDomain = latestPolicy?.defaultSyncDomain?.trim() || '';
    if (policyDomain) {
      return policyDomain;
    }
    return baseUrlCandidate;
  };

  const handleRegister = async (): Promise<void> => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const baseUrlCandidate = normalizedHints.apiBaseUrl || discoveredDomain;
    if (!baseUrlCandidate || !normalizedHints.email || !password.trim()) {
      logAppWarn('cloud-sync-auth', '注册请求参数不完整', {
        stage: 'register',
        hasSyncDomain: Boolean(baseUrlCandidate),
        hasEmail: Boolean(normalizedHints.email),
        hasPassword: Boolean(password.trim())
      });
      toast.error(baseUrlCandidate ? t('cloud.errorFillRequired') : t('cloud.errorNoAutoSyncUrl'));
      return;
    }
    if (!registerVerifyCode.trim()) {
      logAppWarn('cloud-sync-auth', '注册请求缺少验证码', {
        stage: 'register',
        email: maskEmailForLog(normalizedHints.email)
      });
      toast.error(t('cloud.errorRegisterCodeRequired'));
      return;
    }
    const latestPolicy = await refreshPolicyByEndpoint(baseUrlCandidate);
    if (latestPolicy?.setupRequired) {
      toast.error(t('cloud.errorSetupRequired'));
      return;
    }
    const effectiveApi = resolvePreferredApiBase(latestPolicy, baseUrlCandidate);
    try {
      await registerCloudAccount(
        effectiveApi,
        normalizedHints.email,
        password,
        registerVerifyCode.trim()
      );
      writeAuthHints({
        ...normalizedHints,
        apiBaseUrl: effectiveApi
      });
      setPassword('');
      onSuccess();
    } catch (error) {
      if (isLikelyNetworkFailure(error) && bootstrapConfigured) {
        try {
          const fallbackPolicy = await discoverCloudSyncPolicy({ force: true });
          const fallbackApi = fallbackPolicy.defaultSyncDomain.trim();
          if (fallbackApi && fallbackApi !== effectiveApi) {
            await registerCloudAccount(
              fallbackApi,
              normalizedHints.email,
              password,
              registerVerifyCode.trim()
            );
            writeAuthHints({
              ...normalizedHints,
              apiBaseUrl: fallbackApi
            });
      setPassword('');
      setRegisterVerifyCode('');
      onSuccess();
            return;
          }
        } catch (_retryError) {
          // Fall through to original error feedback.
        }
      }
      const fallback = t('cloud.errorRegister');
      const message = error instanceof Error ? error.message : fallback;
      logAppError('cloud-sync-auth', '注册流程失败', {
        stage: 'register',
        email: maskEmailForLog(normalizedHints.email),
        endpoint: effectiveApi,
        message: extractErrorMessage(error, fallback)
      });
      toast.error(message || fallback);
    }
  };

  const handleSendRegisterVerifyCode = async (): Promise<void> => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const baseUrlCandidate = normalizedHints.apiBaseUrl || discoveredDomain;
    const targetEmail = normalizedHints.email.trim();
    if (!baseUrlCandidate || !targetEmail) {
      logAppWarn('cloud-sync-auth', '发送注册验证码参数不完整', {
        stage: 'send-register-code',
        hasSyncDomain: Boolean(baseUrlCandidate),
        hasEmail: Boolean(targetEmail)
      });
      toast.error(baseUrlCandidate ? t('cloud.errorFillRequired') : t('cloud.errorNoAutoSyncUrl'));
      return;
    }
    const latestPolicy = await refreshPolicyByEndpoint(baseUrlCandidate);
    const effectiveApi = resolvePreferredApiBase(latestPolicy, baseUrlCandidate);
    setIsSendingRegisterVerifyCode(true);
    try {
      const result = await sendCloudRegisterVerifyCode(effectiveApi, targetEmail);
      toast.success(result.message || t('cloud.registerCodeSent'));
    } catch (error) {
      const message = error instanceof Error ? error.message : t('cloud.errorSendRegisterCode');
      logAppError('cloud-sync-auth', '发送注册验证码失败', {
        stage: 'send-register-code',
        email: maskEmailForLog(targetEmail),
        endpoint: effectiveApi,
        message: extractErrorMessage(error, t('cloud.errorSendRegisterCode'))
      });
      toast.error(message || t('cloud.errorSendRegisterCode'));
    } finally {
      setIsSendingRegisterVerifyCode(false);
    }
  };

  const handleLogin = async (): Promise<void> => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const baseUrlCandidate = normalizedHints.apiBaseUrl || discoveredDomain;
    if (!baseUrlCandidate || !normalizedHints.email || !password.trim()) {
      logAppWarn('cloud-sync-auth', '登录请求参数不完整', {
        stage: 'login',
        hasSyncDomain: Boolean(baseUrlCandidate),
        hasEmail: Boolean(normalizedHints.email),
        hasPassword: Boolean(password.trim())
      });
      toast.error(baseUrlCandidate ? t('cloud.errorFillRequired') : t('cloud.errorNoAutoSyncUrl'));
      return;
    }
    const latestPolicy = await refreshPolicyByEndpoint(baseUrlCandidate);
    if (latestPolicy?.setupRequired) {
      toast.error(t('cloud.errorSetupRequired'));
      return;
    }
    const effectiveApi = resolvePreferredApiBase(latestPolicy, baseUrlCandidate);
    try {
      await loginCloudAccount(effectiveApi, normalizedHints.email, password, {
        otpCode: otpCode.trim() || undefined,
        backupCode: backupCode.trim() || undefined
      });
      writeAuthHints({
        ...normalizedHints,
        apiBaseUrl: effectiveApi
      });
      setPassword('');
      setOtpCode('');
      setBackupCode('');
      setShow2FAInput(false);
      onSuccess();
    } catch (error) {
      if (isLikelyNetworkFailure(error) && bootstrapConfigured) {
        try {
          const fallbackPolicy = await discoverCloudSyncPolicy({ force: true });
          const fallbackApi = fallbackPolicy.defaultSyncDomain.trim();
          if (fallbackApi && fallbackApi !== effectiveApi) {
            await loginCloudAccount(fallbackApi, normalizedHints.email, password, {
              otpCode: otpCode.trim() || undefined,
              backupCode: backupCode.trim() || undefined
            });
            writeAuthHints({
              ...normalizedHints,
              apiBaseUrl: fallbackApi
            });
            setPassword('');
            setOtpCode('');
            setBackupCode('');
            setShow2FAInput(false);
            onSuccess();
            return;
          }
        } catch (_retryError) {
          // Keep original error handling.
        }
      }
      if (
        error instanceof CloudSyncRequestError &&
        (error.code === 'two_factor_required' || error.code === 'two_factor_invalid')
      ) {
        setShow2FAInput(true);
      }
      const fallback = t('cloud.errorLogin');
      const message = error instanceof Error ? error.message : fallback;
      logAppError('cloud-sync-auth', '登录流程失败', {
        stage: 'login',
        email: maskEmailForLog(normalizedHints.email),
        endpoint: effectiveApi,
        message: extractErrorMessage(error, fallback)
      });
      toast.error(message || fallback);
    }
  };

  const handleSendResetCode = async (): Promise<void> => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const baseUrlCandidate = normalizedHints.apiBaseUrl || discoveredDomain;
    const targetEmail = normalizedHints.email.trim();
    if (!baseUrlCandidate || !targetEmail) {
      logAppWarn('cloud-sync-auth', '发送重置验证码参数不完整', {
        stage: 'send-reset-code',
        hasSyncDomain: Boolean(baseUrlCandidate),
        hasEmail: Boolean(targetEmail)
      });
      toast.error(baseUrlCandidate ? t('cloud.errorFillRequired') : t('cloud.errorNoAutoSyncUrl'));
      return;
    }
    const latestPolicy = await refreshPolicyByEndpoint(baseUrlCandidate);
    const effectiveApi = resolvePreferredApiBase(latestPolicy, baseUrlCandidate);
    setIsSendingResetCode(true);
    try {
      const result = await sendCloudPasswordResetCode(effectiveApi, targetEmail);
      toast.success(result.message || '验证码已发送，请检查邮箱。');
      setShowResetPanel(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : '发送验证码失败，请稍后重试。';
      logAppError('cloud-sync-auth', '发送重置验证码失败', {
        stage: 'send-reset-code',
        email: maskEmailForLog(targetEmail),
        endpoint: effectiveApi,
        message: extractErrorMessage(error, '发送验证码失败，请稍后重试。')
      });
      toast.error(message);
    } finally {
      setIsSendingResetCode(false);
    }
  };

  const handleSubmitResetPassword = async (): Promise<void> => {
    const discoveredDomain = policy?.defaultSyncDomain?.trim() || '';
    const baseUrlCandidate = normalizedHints.apiBaseUrl || discoveredDomain;
    const targetEmail = normalizedHints.email.trim();
    if (!baseUrlCandidate || !targetEmail || !resetCode.trim() || !resetNewPassword.trim()) {
      logAppWarn('cloud-sync-auth', '重置密码参数不完整', {
        stage: 'reset-password',
        hasSyncDomain: Boolean(baseUrlCandidate),
        hasEmail: Boolean(targetEmail),
        hasCode: Boolean(resetCode.trim()),
        hasPassword: Boolean(resetNewPassword.trim())
      });
      toast.error(baseUrlCandidate ? t('cloud.errorFillRequired') : t('cloud.errorNoAutoSyncUrl'));
      return;
    }
    if (resetNewPassword !== resetNewPasswordConfirm) {
      logAppWarn('cloud-sync-auth', '重置密码两次输入不一致', {
        stage: 'reset-password',
        email: maskEmailForLog(targetEmail)
      });
      toast.error('两次输入的新密码不一致。');
      return;
    }
    const latestPolicy = await refreshPolicyByEndpoint(baseUrlCandidate);
    const effectiveApi = resolvePreferredApiBase(latestPolicy, baseUrlCandidate);
    setIsSubmittingReset(true);
    try {
      const result = await resetCloudPassword(
        effectiveApi,
        targetEmail,
        resetCode.trim(),
        resetNewPassword
      );
      toast.success(result.message || '密码重置成功，请使用新密码登录。');
      setPassword(resetNewPassword);
      setResetCode('');
      setResetNewPassword('');
      setResetNewPasswordConfirm('');
      setShowResetPanel(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : '重置密码失败，请稍后重试。';
      logAppError('cloud-sync-auth', '重置密码失败', {
        stage: 'reset-password',
        email: maskEmailForLog(targetEmail),
        endpoint: effectiveApi,
        message: extractErrorMessage(error, '重置密码失败，请稍后重试。')
      });
      toast.error(message);
    } finally {
      setIsSubmittingReset(false);
    }
  };

  const forceAutoSyncDomain = !allowManualSyncUrlEntry;
  const hideSyncDomainInput = policy?.hideSyncDomainInput === true || forceAutoSyncDomain;
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[136] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-white/45 bg-[#f1f7ff]/95 p-6 shadow-2xl backdrop-blur-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-500">{t('cloud.tag')}</p>
        <h2 className="mt-2 text-xl font-semibold text-slate-900">{t('cloud.title')}</h2>
        <p className="mt-1 text-sm text-slate-600">
          {t('cloud.desc')}
        </p>
        {policy?.requireActivation ? (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
            {t('cloud.requireActivation')}
          </p>
        ) : null}

        <div className="mt-4 space-y-3">
          {!hideSyncDomainInput ? (
            <div>
              <label className="block text-xs text-slate-600" htmlFor="cloud-auth-api-url">
                {t('cloud.syncUrlLabel')}
              </label>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300 disabled:cursor-not-allowed disabled:bg-slate-100"
                disabled={policy?.lockSyncDomain === true}
                id="cloud-auth-api-url"
                onBlur={() => {
                  if (apiBaseUrl.trim()) {
                    void refreshPolicyByEndpoint(apiBaseUrl);
                  }
                }}
                onChange={(event) => setApiBaseUrl(event.target.value)}
                placeholder={t('cloud.syncUrlPlaceholder')}
                type="url"
                value={apiBaseUrl}
              />
              {policy?.lockSyncDomain ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  {t('cloud.syncUrlLocked')}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
              <p>{t('cloud.syncUrlAutoManaged')}</p>
              {isDiscoveringBootstrap ? (
                <p className="mt-1 text-[11px] text-slate-500">{t('cloud.bootstrapDiscovering')}</p>
              ) : null}
              {!isDiscoveringBootstrap && (policy?.defaultSyncDomain || apiBaseUrl).trim() ? (
                <p className="mt-1 text-[11px] text-slate-500">{t('cloud.bootstrapReady')} **</p>
              ) : null}
              {!isDiscoveringBootstrap && !(policy?.defaultSyncDomain || apiBaseUrl).trim() ? (
                <p className="mt-1 text-[11px] text-amber-700">{t('cloud.errorNoAutoSyncUrl')}</p>
              ) : null}
              {bootstrapError ? (
                <p className="mt-1 text-[11px] text-rose-700">
                  {t('cloud.bootstrapFailed')} {bootstrapError}
                </p>
              ) : null}
            </div>
          )}

          <div>
            <label className="block text-xs text-slate-600" htmlFor="cloud-auth-email">
              {t('cloud.emailLabel')}
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
              id="cloud-auth-email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
              type="email"
              value={email}
            />
          </div>

          <div>
            <label className="block text-xs text-slate-600" htmlFor="cloud-auth-password">
              {t('cloud.passwordLabel')}
            </label>
            <input
              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
              id="cloud-auth-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('cloud.passwordPlaceholder')}
              type="password"
              value={password}
            />
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
            <label className="block text-xs text-slate-600" htmlFor="cloud-register-code">
              {t('cloud.registerCodeLabel')}
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                id="cloud-register-code"
                onChange={(event) => setRegisterVerifyCode(event.target.value)}
                placeholder="123456"
                type="text"
                value={registerVerifyCode}
              />
              <button
                className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={isSendingRegisterVerifyCode || isSubmittingReset || isSyncingCloud}
                onClick={() => {
                  void handleSendRegisterVerifyCode();
                }}
                type="button"
              >
                {isSendingRegisterVerifyCode ? t('common.processing') : t('cloud.btnSendRegisterCode')}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">{t('cloud.registerCodeHint')}</p>
          </div>
          <div className="flex items-center justify-start gap-2">
            <button
              className="text-left text-[11px] text-slate-500 underline decoration-dotted underline-offset-4 hover:text-slate-700"
              disabled={isSendingResetCode || isSubmittingReset}
              onClick={() => {
                setShowResetPanel((prev) => !prev);
              }}
              type="button"
            >
              {t('cloud.btnForgotPassword')}
            </button>
          </div>

          {showResetPanel ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-3">
              <div>
                <label className="block text-xs text-slate-600" htmlFor="cloud-reset-code">
                  {t('cloud.resetCodeLabel')}
                </label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                    id="cloud-reset-code"
                    onChange={(event) => setResetCode(event.target.value)}
                    placeholder="123456"
                    type="text"
                    value={resetCode}
                  />
                  <button
                    className="shrink-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSendingResetCode || isSubmittingReset || isSyncingCloud}
                    onClick={() => {
                      void handleSendResetCode();
                    }}
                    type="button"
                  >
                    {isSendingResetCode ? t('common.processing') : t('cloud.btnSendResetCode')}
                  </button>
                </div>
              </div>
              <div className="mt-2">
                <label className="block text-xs text-slate-600" htmlFor="cloud-reset-new-password">
                  {t('cloud.newPasswordLabel')}
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                  id="cloud-reset-new-password"
                  onChange={(event) => setResetNewPassword(event.target.value)}
                  placeholder={t('cloud.passwordPlaceholder')}
                  type="password"
                  value={resetNewPassword}
                />
              </div>
              <div className="mt-2">
                <label className="block text-xs text-slate-600" htmlFor="cloud-reset-new-password-confirm">
                  {t('cloud.newPasswordConfirmLabel')}
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                  id="cloud-reset-new-password-confirm"
                  onChange={(event) => setResetNewPasswordConfirm(event.target.value)}
                  placeholder={t('cloud.passwordPlaceholder')}
                  type="password"
                  value={resetNewPasswordConfirm}
                />
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  className="rounded-lg border border-[#2f6df4] bg-[#2f6df4] px-3 py-2 text-xs font-semibold text-white hover:bg-[#245ad0] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSubmittingReset}
                  onClick={() => {
                    void handleSubmitResetPassword();
                  }}
                  type="button"
                >
                  {isSubmittingReset ? t('common.processing') : t('cloud.btnResetPassword')}
                </button>
              </div>
            </div>
          ) : null}

          {show2FAInput ? (
            <>
              <div>
                <label className="block text-xs text-slate-600" htmlFor="cloud-auth-otp">
                  2FA 验证码（6 位）
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                  id="cloud-auth-otp"
                  onChange={(event) => setOtpCode(event.target.value)}
                  placeholder="例如：123456"
                  type="text"
                  value={otpCode}
                />
              </div>
              <div>
                <label className="block text-xs text-slate-600" htmlFor="cloud-auth-backup-code">
                  恢复码（可选）
                </label>
                <input
                  className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-blue-300"
                  id="cloud-auth-backup-code"
                  onChange={(event) => setBackupCode(event.target.value)}
                  placeholder="例如：ABCD-1234"
                  type="text"
                  value={backupCode}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  已启用 2FA 的账号登录时，需要输入验证码或恢复码。
                </p>
              </div>
            </>
          ) : (
            <button
              className="text-left text-[11px] text-slate-500 underline decoration-dotted underline-offset-4 hover:text-slate-700"
              onClick={() => {
                setShow2FAInput(true);
              }}
              type="button"
            >
              已开启 2FA？点击填写验证码/恢复码
            </button>
          )}
        </div>

        {cloudSyncError ? (
          <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {cloudSyncError}
          </p>
        ) : null}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSyncingCloud}
            onClick={() => {
              onSkip();
            }}
            type="button"
          >
            {t('cloud.btnSkip')}
          </button>
          <button
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSyncingCloud}
            onClick={() => {
              void handleRegister();
            }}
            type="button"
          >
            {isSyncingCloud ? t('common.processing') : t('cloud.btnRegister')}
          </button>
          <button
            className="rounded-lg border border-[#2f6df4] bg-[#2f6df4] px-3 py-2 text-xs font-semibold text-white hover:bg-[#245ad0] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isSyncingCloud}
            onClick={() => {
              void handleLogin();
            }}
            type="button"
          >
            {isSyncingCloud ? t('common.processing') : t('cloud.btnLogin')}
          </button>
        </div>
      </div>
    </div>
  );
}
