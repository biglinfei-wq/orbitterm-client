import { useAppLogStore, type AppLogLevel } from '../store/useAppLogStore';

const CLOUD_SCOPE_PREFIXES = ['cloud-sync', 'cloud-bootstrap'];
const CLOUD_SYNC_SESSION_KEY = 'orbitterm:cloud-sync-session:v1';
const CLOUD_SYNC_POLICY_KEY = 'orbitterm:cloud-sync-policy:v1';
const CLOUD_SYNC_BOOTSTRAP_CACHE_KEY = 'orbitterm:cloud-bootstrap-cache:v1';

const shouldMaskCloudDomain = (scope: string): boolean => {
  const normalized = scope.trim().toLowerCase();
  return CLOUD_SCOPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
};

const redactSyncDomainInText = (input: string): string => {
  if (!input) {
    return input;
  }
  return input.replace(/\bhttps?:\/\/[^\s/]+/gi, (raw) => {
    if (raw.toLowerCase().startsWith('https://')) {
      return 'https://**';
    }
    if (raw.toLowerCase().startsWith('http://')) {
      return 'http://**';
    }
    return '**';
  });
};

const safeReadLocalStorage = (key: string): string => {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch (_error) {
    return '';
  }
};

const collectKnownSyncDomains = (): string[] => {
  const domains = new Set<string>();
  const captureFromURL = (raw: string): void => {
    const value = raw.trim();
    if (!value) {
      return;
    }
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        domains.add(`${parsed.protocol}//${parsed.host}`.toLowerCase());
      }
    } catch (_error) {
      // Ignore malformed URL values.
    }
  };

  const sessionRaw = safeReadLocalStorage(CLOUD_SYNC_SESSION_KEY);
  if (sessionRaw) {
    try {
      const parsed = JSON.parse(sessionRaw) as { apiBaseUrl?: string };
      captureFromURL(typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '');
    } catch (_error) {
      // Ignore parse failures.
    }
  }

  const policyRaw = safeReadLocalStorage(CLOUD_SYNC_POLICY_KEY);
  if (policyRaw) {
    try {
      const parsed = JSON.parse(policyRaw) as { defaultSyncDomain?: string };
      captureFromURL(typeof parsed.defaultSyncDomain === 'string' ? parsed.defaultSyncDomain : '');
    } catch (_error) {
      // Ignore parse failures.
    }
  }

  const bootstrapRaw = safeReadLocalStorage(CLOUD_SYNC_BOOTSTRAP_CACHE_KEY);
  if (bootstrapRaw) {
    try {
      const parsed = JSON.parse(bootstrapRaw) as {
        endpoint?: string;
        policy?: { defaultSyncDomain?: string };
      };
      captureFromURL(typeof parsed.endpoint === 'string' ? parsed.endpoint : '');
      captureFromURL(
        parsed.policy && typeof parsed.policy.defaultSyncDomain === 'string'
          ? parsed.policy.defaultSyncDomain
          : ''
      );
    } catch (_error) {
      // Ignore parse failures.
    }
  }

  return Array.from(domains);
};

const redactKnownSyncDomainsInText = (input: string): string => {
  const knownDomains = collectKnownSyncDomains();
  if (!input || knownDomains.length === 0) {
    return input;
  }
  let output = input;
  for (const domain of knownDomains) {
    const escaped = domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const httpsPattern = new RegExp(`${escaped}`, 'gi');
    output = output.replace(httpsPattern, (raw) => {
      if (raw.toLowerCase().startsWith('https://')) {
        return 'https://**';
      }
      if (raw.toLowerCase().startsWith('http://')) {
        return 'http://**';
      }
      return '**';
    });
  }
  return output;
};

const normalizeDetail = (detail: unknown): string | undefined => {
  if (detail == null) {
    return undefined;
  }
  if (typeof detail === 'string') {
    return detail;
  }
  if (detail instanceof Error) {
    return detail.stack ?? detail.message;
  }
  try {
    return JSON.stringify(detail);
  } catch (_error) {
    return String(detail);
  }
};

export const appendAppLog = (
  level: AppLogLevel,
  scope: string,
  message: string,
  detail?: unknown
): void => {
  const shouldMask = shouldMaskCloudDomain(scope);
  const normalizedMessage = shouldMask
    ? redactSyncDomainInText(message)
    : redactKnownSyncDomainsInText(message);
  const normalizedDetailRaw = normalizeDetail(detail);
  const normalizedDetail =
    normalizedDetailRaw == null
      ? undefined
      : shouldMask
        ? redactSyncDomainInText(normalizedDetailRaw)
        : redactKnownSyncDomainsInText(normalizedDetailRaw);

  useAppLogStore.getState().appendLog({
    level,
    scope,
    message: normalizedMessage,
    detail: normalizedDetail
  });
};

export const logAppInfo = (scope: string, message: string, detail?: unknown): void => {
  appendAppLog('info', scope, message, detail);
};

export const logAppWarn = (scope: string, message: string, detail?: unknown): void => {
  appendAppLog('warn', scope, message, detail);
};

export const logAppError = (scope: string, message: string, detail?: unknown): void => {
  appendAppLog('error', scope, message, detail);
};
