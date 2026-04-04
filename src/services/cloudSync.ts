import { logAppError, logAppInfo, logAppWarn } from './appLog';
const CLOUD_SYNC_SESSION_KEY = 'orbitterm:cloud-sync-session:v1';
const CLOUD_SYNC_CURSOR_KEY = 'orbitterm:cloud-sync-cursor:v1';
const CLOUD_SYNC_POLICY_KEY = 'orbitterm:cloud-sync-policy:v1';
const CLOUD_SYNC_BOOTSTRAP_CACHE_KEY = 'orbitterm:cloud-bootstrap-cache:v1';
const REQUEST_TIMEOUT_MS = 12_000;
const BOOTSTRAP_DISCOVERY_PATH = '/bootstrap/v1/discover';
const BOOTSTRAP_DISCOVERY_PATH_COMPAT = '/bootstarp/v1/discover';
const BOOTSTRAP_CLOCK_SKEW_MS = 5 * 60 * 1000;
const BOOTSTRAP_NONCE_LENGTH = 24;
const DEFAULT_BOOTSTRAP_DISCOVERY_ENDPOINTS = [
  'https://www.orbitterm.com',
  'https://sync.orbitterm.com'
];
const LEGACY_SYNC_HOST_MAPPINGS: Record<string, string> = {
  'sync.yest.cc': 'sync.orbitterm.com',
  'www.yest.cc': 'www.orbitterm.com'
};

const DEFAULT_BOOTSTRAP_KEYRING: Record<string, string> = {
  'bootstrap-ed25519-202603': `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArZ6xQ1NDw84E7EihwRXOJG5AsVt3Dp5Iluq6KgqCFTw=
-----END PUBLIC KEY-----`
};

export interface CloudSyncSession {
  apiBaseUrl: string;
  email: string;
  token: string;
  currentDeviceId?: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
  };
  currentDeviceId: string;
}

export interface PasswordResetSendResponse {
  message: string;
}

export interface RegisterVerifySendResponse {
  message: string;
}

export interface PasswordResetSubmitResponse {
  message: string;
}

export interface SyncPushRequest {
  version: number;
  encryptedBlobBase64: string;
}

export interface SyncPushResponse {
  acceptedVersion: number;
  updatedAt: string;
  traceId?: string;
  idempotencyReused?: boolean;
}

export interface SyncPullResponse {
  hasData: boolean;
  version?: number;
  encryptedBlobBase64?: string;
  updatedAt?: string;
  traceId?: string;
}

export interface SyncStatusResponse {
  hasData: boolean;
  version: number;
  updatedAt?: string;
  traceId?: string;
}

export interface CloudSyncCursor {
  version: number;
  updatedAt: string | null;
}

export interface CloudSyncPolicy {
  defaultSyncDomain: string;
  lockSyncDomain: boolean;
  hideSyncDomainInput: boolean;
  requireActivation: boolean;
  setupRequired: boolean;
  proCheckoutUrl?: string;
}

interface BootstrapDiscoveryPayload {
  version: number;
  issuedAt: string;
  expiresAt: string;
  syncServiceUrl: string;
  lockSyncDomain: boolean;
  hideSyncDomainInput: boolean;
  requireActivation: boolean;
  setupRequired: boolean;
  nonce?: string;
}

interface BootstrapDiscoveryEnvelope {
  algorithm: string;
  keyId: string;
  payload: BootstrapDiscoveryPayload;
  signature: string;
}

interface CloudBootstrapCache {
  expiresAt: string;
  endpoint: string;
  policy: CloudSyncPolicy;
}

export interface CloudLicenseStatus {
  active: boolean;
  status?: 'active' | 'grace' | 'expired' | 'revoked' | string;
  planKey?: string;
  isLifetime: boolean;
  expiresAt?: string;
  graceEndsAt?: string;
  remainingDays?: number;
  features?: string[];
  maxHosts?: number;
  maxDevices?: number;
  canSyncRead?: boolean;
  canSyncWrite?: boolean;
}

export interface CloudDeviceItem {
  id: string;
  deviceName: string;
  deviceLocation: string;
  userAgent: string;
  lastSeenAt: string;
  createdAt: string;
  isCurrent: boolean;
}

export interface CloudUser2FAStatus {
  enabled: boolean;
  method: string;
  backupCodesRemaining: number;
}

export interface CloudUser2FABeginResponse {
  method: string;
  secret: string;
  issuer: string;
  account: string;
  otpauthUri: string;
}

export interface CloudUser2FAEnableResponse {
  message: string;
  backupCodes: string[];
}

interface CloudErrorPayload {
  message?: string;
  code?: string;
  traceId?: string;
  trace_id?: string;
  retryable?: boolean;
}

interface CloudDevicesResponse {
  devices: CloudDeviceItem[];
}

interface LogoutDeviceResponse {
  revokedCount: number;
  message: string;
}

interface LicenseActivateResponse {
  message: string;
  status: CloudLicenseStatus;
}

export class CloudSyncConflictError extends Error {
  latest: SyncPullResponse | null;
  code?: string;
  traceId?: string;
  retryable: boolean;

  constructor(
    message: string,
    latest: SyncPullResponse | null,
    options?: {
      code?: string;
      traceId?: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'CloudSyncConflictError';
    this.latest = latest;
    this.code = options?.code;
    this.traceId = options?.traceId;
    this.retryable = options?.retryable === true;
  }
}

export class CloudSyncRequestError extends Error {
  status: number;
  code?: string;
  traceId?: string;
  retryable: boolean;

  constructor(
    message: string,
    options: {
      status: number;
      code?: string;
      traceId?: string;
      retryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'CloudSyncRequestError';
    this.status = options.status;
    this.code = options.code;
    this.traceId = options.traceId;
    this.retryable = options.retryable === true;
  }
}

const normalizeHttpsOrigin = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.host.trim()) {
      return null;
    }
    return `https://${parsed.host}`.replace(/\/+$/, '');
  } catch (_error) {
    return null;
  }
};

const normalizeSyncDomainFallback = (raw: string): string => {
  return raw.trim().replace(/\/+$/, '').replace(/\/admin$/i, '');
};

const migrateLegacySyncEndpoint = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const nextHost = LEGACY_SYNC_HOST_MAPPINGS[parsed.host.toLowerCase()];
    if (!nextHost) {
      return trimmed;
    }
    parsed.protocol = 'https:';
    parsed.host = nextHost;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return trimmed;
  }
};

const ensureHttpsEndpoint = (apiBaseUrl: string): string => {
  const normalized = normalizeHttpsOrigin(apiBaseUrl);
  if (!normalized) {
    const fallback = normalizeSyncDomainFallback(apiBaseUrl);
    if (!fallback) {
      logAppWarn('cloud-sync', '同步服务地址为空');
      throw new Error('同步服务地址不能为空。');
    }
    if (!fallback.startsWith('https://')) {
      logAppWarn('cloud-sync', '同步服务地址非 HTTPS', fallback);
      throw new Error('同步服务必须使用 HTTPS 地址。');
    }
    logAppWarn('cloud-sync', '同步服务地址格式异常，建议填写站点根地址（已自动尝试修正）', fallback);
    return fallback;
  }
  return normalized;
};

const RETRY_BACKOFF_MS = [450, 1100];

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });

const randomJitter = (): number => {
  return Math.floor(Math.random() * 120);
};

const readTraceIdFromHeaders = (response: Response): string | undefined => {
  const direct = response.headers.get('x-trace-id');
  if (!direct) {
    return undefined;
  }
  const trimmed = direct.trim();
  return trimmed || undefined;
};

const normalizeBootstrapEndpoint = (raw: string): string => {
  return raw.trim().replace(/\/+$/, '');
};

const parseBootstrapEndpoints = (raw: string | undefined): string[] => {
  if (!raw || !raw.trim()) {
    return [...DEFAULT_BOOTSTRAP_DISCOVERY_ENDPOINTS];
  }
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((item) => normalizeBootstrapEndpoint(item))
        .filter(Boolean)
    )
  );
};

const parseEndpointFromRawUrl = (raw: string): string | null => {
  return normalizeHttpsOrigin(raw);
};

const resolveCheckoutURLFromDomain = (domain: string): string => {
  const normalized = normalizeHttpsOrigin(domain) ?? normalizeSyncDomainFallback(domain);
  if (!normalized) {
    return '';
  }
  return `${normalized}/pricing`;
};

const parseBootstrapKeyring = (): Record<string, string> => {
  const raw = import.meta.env.VITE_BOOTSTRAP_KEYRING_JSON;
  if (!raw || !raw.trim()) {
    return DEFAULT_BOOTSTRAP_KEYRING;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      const keyId = key.trim();
      const pem = typeof value === 'string' ? value.trim() : '';
      if (keyId && pem) {
        next[keyId] = pem;
      }
    }
    if (Object.keys(next).length > 0) {
      return next;
    }
    return DEFAULT_BOOTSTRAP_KEYRING;
  } catch (_error) {
    return DEFAULT_BOOTSTRAP_KEYRING;
  }
};

const BOOTSTRAP_DISCOVERY_ENDPOINTS = parseBootstrapEndpoints(
  import.meta.env.VITE_BOOTSTRAP_ENDPOINTS
);
const BOOTSTRAP_KEYRING = parseBootstrapKeyring();
const BOOTSTRAP_ALLOW_MANUAL_SYNC_URL = import.meta.env.VITE_BOOTSTRAP_ALLOW_MANUAL_SYNC_URL === 'true';
const FORCE_MANAGED_SYNC_DOMAIN = true;
const bootstrapKeyCache = new Map<string, Promise<CryptoKey>>();

const collectLocalDiscoveryEndpoints = (): string[] => {
  const dynamic = new Set<string>();
  const append = (raw: string): void => {
    const parsed = parseEndpointFromRawUrl(raw);
    if (!parsed) {
      return;
    }
    dynamic.add(parsed);
  };
  try {
    const bootstrapRaw = window.localStorage.getItem(CLOUD_SYNC_BOOTSTRAP_CACHE_KEY);
    if (bootstrapRaw) {
      const parsed = JSON.parse(bootstrapRaw) as {
        endpoint?: string;
        policy?: { defaultSyncDomain?: string };
      };
      append(typeof parsed.endpoint === 'string' ? parsed.endpoint : '');
      append(
        parsed.policy && typeof parsed.policy.defaultSyncDomain === 'string'
          ? parsed.policy.defaultSyncDomain
          : ''
      );
    }
  } catch (_error) {
    // Ignore cache parse failures.
  }

  try {
    const policyRaw = window.localStorage.getItem(CLOUD_SYNC_POLICY_KEY);
    if (policyRaw) {
      const parsed = JSON.parse(policyRaw) as { defaultSyncDomain?: string };
      append(typeof parsed.defaultSyncDomain === 'string' ? parsed.defaultSyncDomain : '');
    }
  } catch (_error) {
    // Ignore parse failures.
  }

  try {
    const sessionRaw = window.localStorage.getItem(CLOUD_SYNC_SESSION_KEY);
    if (sessionRaw) {
      const parsed = JSON.parse(sessionRaw) as { apiBaseUrl?: string };
      append(typeof parsed.apiBaseUrl === 'string' ? parsed.apiBaseUrl : '');
    }
  } catch (_error) {
    // Ignore parse failures.
  }

  return Array.from(dynamic);
};

const getBootstrapDiscoveryEndpoints = (): string[] => {
  const combined = new Set<string>();
  for (const item of BOOTSTRAP_DISCOVERY_ENDPOINTS) {
    combined.add(item);
  }
  for (const item of collectLocalDiscoveryEndpoints()) {
    combined.add(item);
  }
  return Array.from(combined);
};

const isAbsoluteBootstrapURL = (raw: string): boolean => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'https:' &&
      (parsed.pathname.endsWith(BOOTSTRAP_DISCOVERY_PATH) ||
        parsed.pathname.endsWith(BOOTSTRAP_DISCOVERY_PATH_COMPAT))
    );
  } catch (_error) {
    return false;
  }
};

const buildBootstrapDiscoveryCandidates = (rawEndpoint: string, nonce: string): string[] => {
  const endpoint = ensureHttpsEndpoint(rawEndpoint);
  if (isAbsoluteBootstrapURL(rawEndpoint)) {
    const discoverURL = new URL(rawEndpoint.trim());
    discoverURL.searchParams.set('nonce', nonce);
    return [discoverURL.toString()];
  }
  const candidates: string[] = [];
  for (const path of [BOOTSTRAP_DISCOVERY_PATH, BOOTSTRAP_DISCOVERY_PATH_COMPAT]) {
    const discoverURL = new URL(`${endpoint}${path}`);
    discoverURL.searchParams.set('nonce', nonce);
    candidates.push(discoverURL.toString());
  }
  return candidates;
};

const decodeBase64 = (raw: string): Uint8Array => {
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  const binary = window.atob(padded);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
};

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

const importBootstrapPublicKey = async (keyId: string): Promise<CryptoKey> => {
  const normalizedKeyId = keyId.trim();
  if (!normalizedKeyId) {
    throw new Error('引导签名缺少 keyId。');
  }
  const pem = BOOTSTRAP_KEYRING[normalizedKeyId];
  if (!pem) {
    throw new Error(`未找到引导签名公钥：${normalizedKeyId}`);
  }
  const cached = bootstrapKeyCache.get(normalizedKeyId);
  if (cached) {
    return cached;
  }
  const importPromise = (async () => {
    if (!window.crypto?.subtle) {
      throw new Error('当前系统不支持 WebCrypto，无法校验引导签名。');
    }
    const body = pem
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    if (!body) {
      throw new Error(`引导签名公钥格式无效：${normalizedKeyId}`);
    }
    const keyBytes = decodeBase64(body);
    return window.crypto.subtle.importKey(
      'spki',
      toArrayBuffer(keyBytes),
      { name: 'Ed25519' },
      false,
      ['verify']
    );
  })();
  bootstrapKeyCache.set(normalizedKeyId, importPromise);
  return importPromise;
};

const normalizeBootstrapField = (raw: string): string => {
  return raw.trim().replace(/[\r\n]+/g, ' ');
};

const buildBootstrapCanonicalText = (payload: BootstrapDiscoveryPayload): string => {
  const boolText = (value: boolean): string => (value ? 'true' : 'false');
  const lines = [
    `version=${payload.version}`,
    `issued_at=${normalizeBootstrapField(payload.issuedAt)}`,
    `expires_at=${normalizeBootstrapField(payload.expiresAt)}`,
    `sync_service_url=${normalizeBootstrapField(payload.syncServiceUrl)}`,
    `lock_sync_domain=${boolText(payload.lockSyncDomain === true)}`,
    `hide_sync_domain_input=${boolText(payload.hideSyncDomainInput === true)}`,
    `require_activation=${boolText(payload.requireActivation !== false)}`,
    `setup_required=${boolText(payload.setupRequired === true)}`,
    `nonce=${normalizeBootstrapField(payload.nonce ?? '')}`
  ];
  return lines.join('\n');
};

const validateBootstrapPayloadTime = (payload: BootstrapDiscoveryPayload): void => {
  const issuedAtMs = Date.parse(payload.issuedAt);
  const expiresAtMs = Date.parse(payload.expiresAt);
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new Error('引导响应时间字段无效。');
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new Error('引导响应时间区间无效。');
  }
  const now = Date.now();
  if (issuedAtMs - now > BOOTSTRAP_CLOCK_SKEW_MS) {
    throw new Error('引导响应签发时间异常，请检查设备时间。');
  }
  if (expiresAtMs + BOOTSTRAP_CLOCK_SKEW_MS < now) {
    throw new Error('引导响应已过期，请重试。');
  }
};

const validateBootstrapEnvelope = async (envelope: BootstrapDiscoveryEnvelope): Promise<void> => {
  if ((envelope.algorithm || '').trim().toLowerCase() !== 'ed25519') {
    throw new Error('引导签名算法不受支持。');
  }
  validateBootstrapPayloadTime(envelope.payload);
  const publicKey = await importBootstrapPublicKey(envelope.keyId);
  const signature = decodeBase64(envelope.signature || '');
  if (signature.length === 0) {
    throw new Error('引导签名为空。');
  }
  const canonicalText = buildBootstrapCanonicalText(envelope.payload);
  const messageBytes = new TextEncoder().encode(canonicalText);
  const verified = await window.crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    toArrayBuffer(signature),
    toArrayBuffer(messageBytes)
  );
  if (!verified) {
    throw new Error('引导签名校验失败。');
  }
};

const readBootstrapCache = (): CloudBootstrapCache | null => {
  const raw = window.localStorage.getItem(CLOUD_SYNC_BOOTSTRAP_CACHE_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloudBootstrapCache>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const expiresAt = typeof parsed.expiresAt === 'string' ? parsed.expiresAt.trim() : '';
    const endpoint = typeof parsed.endpoint === 'string' ? parsed.endpoint.trim() : '';
    const policy = parsed.policy as Partial<CloudSyncPolicy> | undefined;
    if (!expiresAt || !endpoint || !policy) {
      return null;
    }
    return {
      expiresAt,
      endpoint,
      policy: {
        defaultSyncDomain:
          typeof policy.defaultSyncDomain === 'string' ? policy.defaultSyncDomain.trim() : '',
        lockSyncDomain: policy.lockSyncDomain === true,
        hideSyncDomainInput: policy.hideSyncDomainInput === true,
        requireActivation: policy.requireActivation !== false,
        setupRequired: policy.setupRequired === true,
        proCheckoutUrl:
          typeof policy.proCheckoutUrl === 'string' ? policy.proCheckoutUrl.trim() : ''
      }
    };
  } catch (_error) {
    return null;
  }
};

const writeBootstrapCache = (payload: CloudBootstrapCache): void => {
  window.localStorage.setItem(CLOUD_SYNC_BOOTSTRAP_CACHE_KEY, JSON.stringify(payload));
};

const createBootstrapNonce = (): string => {
  if (window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(BOOTSTRAP_NONCE_LENGTH);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2, 18)}`;
};

const parseErrorPayload = async (
  response: Response,
  fallbackMessage: string
): Promise<{
  message: string;
  code?: string;
  traceId?: string;
  retryable: boolean;
  latest?: unknown;
}> => {
  let payload: (CloudErrorPayload & { latest?: unknown }) | null = null;
  try {
    payload = (await response.json()) as CloudErrorPayload & { latest?: unknown };
  } catch (_error) {
    payload = null;
  }
  const message = payload?.message?.trim() || fallbackMessage;
  const code = payload?.code?.trim();
  const traceIdFromPayload = payload?.traceId?.trim() || payload?.trace_id?.trim();
  const traceId = traceIdFromPayload || readTraceIdFromHeaders(response);
  const retryableByStatus = response.status === 429 || response.status >= 500;
  return {
    message,
    code: code || undefined,
    traceId: traceId || undefined,
    retryable: payload?.retryable === true || retryableByStatus,
    latest: payload?.latest
  };
};

const shouldRetryCloudError = (error: unknown): boolean => {
  if (error instanceof CloudSyncConflictError) {
    return false;
  }
  if (error instanceof CloudSyncRequestError) {
    return error.retryable || error.status === 429 || error.status >= 500;
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowered = message.toLowerCase();
  if (lowered.includes('network') || lowered.includes('failed to fetch')) {
    return true;
  }
  if (lowered.includes('网络') || lowered.includes('连接同步服务失败')) {
    return true;
  }
  if (lowered.includes('timeout') || lowered.includes('超时')) {
    return true;
  }
  return false;
};

const isLikelyFetchNetworkError = (error: unknown): boolean => {
  if (error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error) {
    const lowered = error.message.trim().toLowerCase();
    return (
      lowered.includes('failed to fetch') ||
      lowered.includes('networkerror when attempting to fetch resource') ||
      lowered.includes('network request failed')
    );
  }
  return false;
};

const withRetry = async <T>(
  scope: string,
  action: (attempt: number) => Promise<T>,
  maxAttempts = 3
): Promise<T> => {
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await action(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !shouldRetryCloudError(error)) {
        throw error;
      }
      const delayBase =
        RETRY_BACKOFF_MS[Math.min(attempt - 1, RETRY_BACKOFF_MS.length - 1)] ??
        RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ??
        1000;
      const delay = delayBase + randomJitter();
      logAppWarn('cloud-sync', '云同步请求将自动重试', {
        scope,
        attempt,
        maxAttempts,
        delay,
        error: error instanceof Error ? error.message : String(error)
      });
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('云同步请求失败。');
};

const createIdempotencyKey = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '');
  }
  return `idem-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 12)}`;
};

const withTimeout = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutHandle = window.setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      logAppWarn('cloud-sync', '云同步请求超时', String(input));
      throw new Error('云同步请求超时，请检查网络后重试。');
    }
    if (isLikelyFetchNetworkError(error)) {
      logAppWarn('cloud-sync', '云同步网络连接失败', {
        input: String(input),
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error('连接同步服务失败，请检查网络、服务状态后重试。');
    }
    logAppError('cloud-sync', '云同步请求失败', {
      input: String(input),
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    window.clearTimeout(timeoutHandle);
  }
};

const readJson = async <T>(response: Response, fallbackMessage: string): Promise<T> => {
  if (!response.ok) {
    const payload = await parseErrorPayload(response, fallbackMessage);
    logAppWarn('cloud-sync', `云同步请求返回异常状态 ${response.status}`, {
      url: response.url,
      message: payload.message,
      code: payload.code,
      traceId: payload.traceId
    });
    throw new CloudSyncRequestError(payload.message, {
      status: response.status,
      code: payload.code,
      traceId: payload.traceId,
      retryable: payload.retryable
    });
  }

  return (await response.json()) as T;
};

const parseSyncVersion = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return fallback;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return fallback;
};

const readString = (raw: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) {
        return trimmed;
      }
    }
  }
  return undefined;
};

const readBoolean = (raw: Record<string, unknown>, keys: string[]): boolean | null => {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }
  }
  return null;
};

const readVersion = (raw: Record<string, unknown>, fallback = 0): number => {
  const candidates = [raw.version, raw.syncVersion, raw.sync_version];
  for (const candidate of candidates) {
    const parsed = parseSyncVersion(candidate, -1);
    if (parsed >= 0) {
      return parsed;
    }
  }
  return fallback;
};

const normalizeSyncPullResponse = (payload: unknown): SyncPullResponse => {
  if (!payload || typeof payload !== 'object') {
    return { hasData: false };
  }
  const raw = payload as Record<string, unknown>;
  const encryptedBlobBase64 = readString(raw, [
    'encryptedBlobBase64',
    'encrypted_blob_base64',
    'encryptedBlob',
    'encrypted_blob',
    'blob'
  ]);
  const hasDataFlag = readBoolean(raw, ['hasData', 'has_data']);
  const hasData = hasDataFlag === null ? Boolean(encryptedBlobBase64) : hasDataFlag;
  const version = readVersion(raw, 0);
  const updatedAt = readString(raw, ['updatedAt', 'updated_at']);
  const traceId = readString(raw, ['traceId', 'trace_id']);
  if (!hasData) {
    return {
      hasData: false,
      version,
      updatedAt,
      traceId
    };
  }
  return {
    hasData: true,
    version,
    encryptedBlobBase64,
    updatedAt,
    traceId
  };
};

const normalizeSyncStatusResponse = (payload: unknown): SyncStatusResponse => {
  if (!payload || typeof payload !== 'object') {
    return {
      hasData: false,
      version: 0
    };
  }
  const raw = payload as Record<string, unknown>;
  const hasDataFlag = readBoolean(raw, ['hasData', 'has_data']);
  const hasData = hasDataFlag === null ? readVersion(raw, 0) > 0 : hasDataFlag;
  return {
    hasData,
    version: readVersion(raw, 0),
    updatedAt: readString(raw, ['updatedAt', 'updated_at']),
    traceId: readString(raw, ['traceId', 'trace_id'])
  };
};

const normalizeSyncPushResponse = (payload: unknown): SyncPushResponse => {
  if (!payload || typeof payload !== 'object') {
    return {
      acceptedVersion: 0,
      updatedAt: ''
    };
  }
  const raw = payload as Record<string, unknown>;
  const acceptedVersion = parseSyncVersion(
    raw.acceptedVersion ?? raw.accepted_version ?? raw.version,
    0
  );
  return {
    acceptedVersion,
    updatedAt: readString(raw, ['updatedAt', 'updated_at']) ?? '',
    traceId: readString(raw, ['traceId', 'trace_id']),
    idempotencyReused: readBoolean(raw, ['idempotencyReused', 'idempotency_reused']) === true
  };
};

const saveSession = (session: CloudSyncSession): void => {
  window.localStorage.setItem(CLOUD_SYNC_SESSION_KEY, JSON.stringify(session));
};

export const persistCloudSyncSession = (session: CloudSyncSession): void => {
  saveSession(session);
};

const saveCloudSyncPolicy = (policy: CloudSyncPolicy): void => {
  window.localStorage.setItem(CLOUD_SYNC_POLICY_KEY, JSON.stringify(policy));
};

export const readCloudSyncPolicy = (): CloudSyncPolicy | null => {
  const raw = window.localStorage.getItem(CLOUD_SYNC_POLICY_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloudSyncPolicy>;
    const defaultSyncDomain =
      typeof parsed.defaultSyncDomain === 'string'
        ? migrateLegacySyncEndpoint(parsed.defaultSyncDomain).trim()
        : '';
    const fallbackCheckout = resolveCheckoutURLFromDomain(defaultSyncDomain);
    const rawCheckout = typeof parsed.proCheckoutUrl === 'string' ? parsed.proCheckoutUrl.trim() : '';
    let proCheckoutUrl = rawCheckout || fallbackCheckout;
    if (defaultSyncDomain && rawCheckout) {
      try {
        const checkoutHost = new URL(rawCheckout).host.toLowerCase();
        const syncHost = new URL(defaultSyncDomain).host.toLowerCase();
        if (checkoutHost !== syncHost) {
          proCheckoutUrl = fallbackCheckout;
        }
      } catch (_error) {
        proCheckoutUrl = fallbackCheckout;
      }
    }
    return {
      defaultSyncDomain,
      lockSyncDomain: parsed.lockSyncDomain === true,
      hideSyncDomainInput: parsed.hideSyncDomainInput === true,
      requireActivation: parsed.requireActivation !== false,
      setupRequired: parsed.setupRequired === true,
      proCheckoutUrl
    };
  } catch (_error) {
    return null;
  }
};

const normalizeSyncIdentity = (apiBaseUrl: string, email: string): string => {
  return `${apiBaseUrl.trim().replace(/\/+$/, '').toLowerCase()}|${email.trim().toLowerCase()}`;
};

const readCursorStore = (): Record<string, CloudSyncCursor> => {
  const raw = window.localStorage.getItem(CLOUD_SYNC_CURSOR_KEY);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const next: Record<string, CloudSyncCursor> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== 'object' || Array.isArray(value)) {
        continue;
      }
      const item = value as Record<string, unknown>;
      const version = parseSyncVersion(item.version, -1);
      if (version < 0) {
        continue;
      }
      const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : null;
      next[key] = {
        version,
        updatedAt
      };
    }
    return next;
  } catch (_error) {
    return {};
  }
};

const writeCursorStore = (payload: Record<string, CloudSyncCursor>): void => {
  window.localStorage.setItem(CLOUD_SYNC_CURSOR_KEY, JSON.stringify(payload));
};

const detectDeviceName = (): string => {
  const platform = (window.navigator.platform || '').toLowerCase();
  if (platform.includes('mac')) {
    return 'Mac 设备';
  }
  if (platform.includes('win')) {
    return 'Windows 设备';
  }
  if (platform.includes('linux')) {
    return 'Linux 设备';
  }
  return 'OrbitTerm 设备';
};

const detectDeviceLocation = (): string => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone) {
    return '未知地区';
  }
  const city = timezone.split('/').pop();
  if (!city) {
    return timezone;
  }
  return city.replace(/_/g, ' ');
};

export const readCloudSyncSession = (): CloudSyncSession | null => {
  const raw = window.localStorage.getItem(CLOUD_SYNC_SESSION_KEY);
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CloudSyncSession>;
    if (!parsed.apiBaseUrl || !parsed.email || !parsed.token) {
      return null;
    }
    const migratedApiBaseUrl = migrateLegacySyncEndpoint(parsed.apiBaseUrl);
    const session: CloudSyncSession = {
      apiBaseUrl: migratedApiBaseUrl,
      email: parsed.email,
      token: parsed.token,
      currentDeviceId: typeof parsed.currentDeviceId === 'string' ? parsed.currentDeviceId : undefined
    };
    if (migratedApiBaseUrl !== parsed.apiBaseUrl) {
      // Persist endpoint migration immediately so subsequent sync uses the new domain.
      saveSession(session);
      try {
        const oldKey = normalizeSyncIdentity(parsed.apiBaseUrl, parsed.email);
        const nextKey = normalizeSyncIdentity(migratedApiBaseUrl, parsed.email);
        if (oldKey !== nextKey) {
          const store = readCursorStore();
          if (store[oldKey] && !store[nextKey]) {
            store[nextKey] = store[oldKey];
          }
          delete store[oldKey];
          writeCursorStore(store);
        }
      } catch (_error) {
        // Ignore cursor migration failure; session migration still takes effect.
      }
    }
    return session;
  } catch (_error) {
    return null;
  }
};

export const clearCloudSyncSession = (): void => {
  window.localStorage.removeItem(CLOUD_SYNC_SESSION_KEY);
};

export const clearCloudSyncPolicy = (): void => {
  window.localStorage.removeItem(CLOUD_SYNC_POLICY_KEY);
};

export const isCloudBootstrapDiscoveryConfigured = (): boolean => {
  return getBootstrapDiscoveryEndpoints().length > 0;
};

export const shouldAllowManualSyncUrlEntry = (): boolean => {
  if (FORCE_MANAGED_SYNC_DOMAIN) {
    return false;
  }
  return BOOTSTRAP_ALLOW_MANUAL_SYNC_URL;
};

export const readCloudSyncCursor = (session: CloudSyncSession): CloudSyncCursor | null => {
  const key = normalizeSyncIdentity(session.apiBaseUrl, session.email);
  const store = readCursorStore();
  return store[key] ?? null;
};

export const writeCloudSyncCursor = (
  session: CloudSyncSession,
  cursor: CloudSyncCursor
): void => {
  const key = normalizeSyncIdentity(session.apiBaseUrl, session.email);
  const store = readCursorStore();
  store[key] = {
    version: parseSyncVersion(cursor.version, 0),
    updatedAt: cursor.updatedAt ?? null
  };
  writeCursorStore(store);
};

export const registerCloudSync = async (
  apiBaseUrl: string,
  email: string,
  password: string,
  verifyCode: string
): Promise<CloudSyncSession> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        verifyCode,
        deviceName: detectDeviceName(),
        deviceLocation: detectDeviceLocation()
      })
    });
    const payload = await readJson<AuthResponse>(response, '注册失败，请稍后重试。');
    const session: CloudSyncSession = {
      apiBaseUrl: endpoint,
      email: payload.user.email,
      token: payload.token,
      currentDeviceId: payload.currentDeviceId
    };
    saveSession(session);
    try {
      const policy = await fetchCloudSyncPolicy(endpoint);
      saveCloudSyncPolicy(policy);
    } catch (_error) {
      // Ignore policy fetch failures and keep flow.
    }
    logAppInfo('cloud-sync', '注册同步账号成功', {
      endpoint,
      email: payload.user.email
    });
    return session;
  } catch (error) {
    logAppError('cloud-sync', '注册同步账号失败', {
      endpoint,
      email,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const sendCloudRegisterVerifyCode = async (
  apiBaseUrl: string,
  email: string
): Promise<RegisterVerifySendResponse> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/auth/register/verify/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email
      })
    });
    const payload = await readJson<RegisterVerifySendResponse>(response, '发送注册验证码失败，请稍后重试。');
    logAppInfo('cloud-sync', '发送注册验证码成功', {
      endpoint,
      email
    });
    return payload;
  } catch (error) {
    logAppError('cloud-sync', '发送注册验证码失败', {
      endpoint,
      email,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const loginCloudSync = async (
  apiBaseUrl: string,
  email: string,
  password: string,
  options?: {
    otpCode?: string;
    backupCode?: string;
  }
): Promise<CloudSyncSession> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        otpCode: options?.otpCode?.trim() || undefined,
        backupCode: options?.backupCode?.trim() || undefined,
        deviceName: detectDeviceName(),
        deviceLocation: detectDeviceLocation()
      })
    });
    const payload = await readJson<AuthResponse>(response, '登录失败，请检查账号或密码。');
    const session: CloudSyncSession = {
      apiBaseUrl: endpoint,
      email: payload.user.email,
      token: payload.token,
      currentDeviceId: payload.currentDeviceId
    };
    saveSession(session);
    try {
      const policy = await fetchCloudSyncPolicy(endpoint);
      saveCloudSyncPolicy(policy);
    } catch (_error) {
      // Ignore policy fetch failures and keep flow.
    }
    logAppInfo('cloud-sync', '登录同步账号成功', {
      endpoint,
      email: payload.user.email
    });
    return session;
  } catch (error) {
    logAppError('cloud-sync', '登录同步账号失败', {
      endpoint,
      email,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const sendCloudPasswordResetCode = async (
  apiBaseUrl: string,
  email: string
): Promise<PasswordResetSendResponse> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/auth/password/forgot/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email
      })
    });
    const payload = await readJson<PasswordResetSendResponse>(response, '发送验证码失败，请稍后重试。');
    logAppInfo('cloud-sync', '发送重置密码验证码成功', {
      endpoint,
      email
    });
    return payload;
  } catch (error) {
    logAppError('cloud-sync', '发送重置密码验证码失败', {
      endpoint,
      email,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const resetCloudPassword = async (
  apiBaseUrl: string,
  email: string,
  code: string,
  newPassword: string
): Promise<PasswordResetSubmitResponse> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/auth/password/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        code,
        newPassword
      })
    });
    const payload = await readJson<PasswordResetSubmitResponse>(response, '重置密码失败，请稍后重试。');
    logAppInfo('cloud-sync', '重置密码成功', {
      endpoint,
      email
    });
    return payload;
  } catch (error) {
    logAppError('cloud-sync', '重置密码失败', {
      endpoint,
      email,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

const authHeaders = (token: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`
});

export const pushCloudSyncBlob = async (
  session: CloudSyncSession,
  request: SyncPushRequest
): Promise<SyncPushResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const normalizedVersion = parseSyncVersion(request.version, 0);
  const idempotencyKey = createIdempotencyKey();
  return withRetry('sync-push', async () => {
    const response = await withTimeout(`${endpoint}/sync/push`, {
      method: 'POST',
      headers: {
        ...authHeaders(session.token),
        'X-Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify({
        version: normalizedVersion,
        encryptedBlobBase64: request.encryptedBlobBase64
      })
    });
    if (response.status === 409) {
      const parsed = await parseErrorPayload(response, '检测到版本冲突，请先拉取最新数据后重试。');
      const latest =
        parsed.latest !== undefined ? normalizeSyncPullResponse(parsed.latest) : null;
      if (latest && !latest.traceId && parsed.traceId) {
        latest.traceId = parsed.traceId;
      }
      throw new CloudSyncConflictError(parsed.message, latest, {
        code: parsed.code,
        traceId: parsed.traceId,
        retryable: parsed.retryable
      });
    }
    const payload = await readJson<unknown>(response, '同步上传失败，请稍后重试。');
    const normalized = normalizeSyncPushResponse(payload);
    if (!normalized.traceId) {
      normalized.traceId = readTraceIdFromHeaders(response);
    }
    return normalized;
  });
};

export const getCloudSyncStatus = async (session: CloudSyncSession): Promise<SyncStatusResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  return withRetry('sync-status', async () => {
    const response = await withTimeout(`${endpoint}/sync/status`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.token}`
      }
    });
    const payload = await readJson<unknown>(response, '获取同步状态失败，请稍后重试。');
    const normalized = normalizeSyncStatusResponse(payload);
    if (!normalized.traceId) {
      normalized.traceId = readTraceIdFromHeaders(response);
    }
    return normalized;
  });
};

export const pullCloudSyncBlob = async (session: CloudSyncSession): Promise<SyncPullResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  return withRetry('sync-pull', async () => {
    const response = await withTimeout(`${endpoint}/sync/pull`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${session.token}`
      }
    });
    const payload = await readJson<unknown>(response, '同步拉取失败，请稍后重试。');
    const normalized = normalizeSyncPullResponse(payload);
    if (!normalized.traceId) {
      normalized.traceId = readTraceIdFromHeaders(response);
    }
    return normalized;
  });
};

export const listCloudDevices = async (session: CloudSyncSession): Promise<CloudDeviceItem[]> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/devices`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.token}`
    }
  });
  const payload = await readJson<CloudDevicesResponse>(response, '获取设备列表失败，请稍后重试。');
  return payload.devices;
};

export const logoutCloudDevice = async (
  session: CloudSyncSession,
  deviceId: string
): Promise<LogoutDeviceResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/logout/device`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({
      deviceId
    })
  });
  return readJson<LogoutDeviceResponse>(response, '退出设备失败，请稍后重试。');
};

export const logoutAllCloudDevices = async (
  session: CloudSyncSession
): Promise<LogoutDeviceResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/logout/device`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({
      revokeAll: true
    })
  });
  return readJson<LogoutDeviceResponse>(response, '退出所有设备失败，请稍后重试。');
};

export const fetchCloudSyncPolicy = async (apiBaseUrl: string): Promise<CloudSyncPolicy> => {
  const endpoint = ensureHttpsEndpoint(apiBaseUrl);
  try {
    const response = await withTimeout(`${endpoint}/client/config`, {
      method: 'GET'
    });
    const payload = await readJson<Partial<CloudSyncPolicy>>(response, '读取客户端策略失败，请稍后重试。');
    const defaultSyncDomain =
      typeof payload.defaultSyncDomain === 'string'
        ? migrateLegacySyncEndpoint(payload.defaultSyncDomain).trim()
        : '';
    const fallbackCheckout = resolveCheckoutURLFromDomain(defaultSyncDomain || endpoint);
    const rawCheckout = typeof payload.proCheckoutUrl === 'string' ? payload.proCheckoutUrl.trim() : '';
    let proCheckoutUrl = rawCheckout || fallbackCheckout;
    if (defaultSyncDomain && rawCheckout) {
      try {
        const checkoutHost = new URL(rawCheckout).host.toLowerCase();
        const syncHost = new URL(defaultSyncDomain).host.toLowerCase();
        if (checkoutHost !== syncHost) {
          proCheckoutUrl = fallbackCheckout;
        }
      } catch (_error) {
        proCheckoutUrl = fallbackCheckout;
      }
    }
    return {
      defaultSyncDomain,
      lockSyncDomain: payload.lockSyncDomain === true,
      hideSyncDomainInput: payload.hideSyncDomainInput === true,
      requireActivation: payload.requireActivation !== false,
      setupRequired: payload.setupRequired === true,
      proCheckoutUrl
    };
  } catch (error) {
    logAppError('cloud-sync', '读取客户端同步策略失败', {
      endpoint,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const discoverCloudSyncPolicy = async (
  options?: {
    force?: boolean;
  }
): Promise<CloudSyncPolicy> => {
  const discoveryEndpoints = getBootstrapDiscoveryEndpoints();
  if (discoveryEndpoints.length === 0) {
    throw new Error('未配置引导发现地址。');
  }

  if (options?.force !== true) {
    const cached = readBootstrapCache();
    if (cached) {
      const expiresAt = Date.parse(cached.expiresAt);
      if (Number.isFinite(expiresAt) && expiresAt + BOOTSTRAP_CLOCK_SKEW_MS > Date.now()) {
        saveCloudSyncPolicy(cached.policy);
        return cached.policy;
      }
    }
  }

  const nonce = createBootstrapNonce();
  let lastError: Error | null = null;

  for (const rawEndpoint of discoveryEndpoints) {
    const endpoint = ensureHttpsEndpoint(rawEndpoint);
    const discoverCandidates = buildBootstrapDiscoveryCandidates(rawEndpoint, nonce);
    for (const discoverURL of discoverCandidates) {
      try {
        const response = await withTimeout(discoverURL, {
          method: 'GET',
          headers: {
            'Cache-Control': 'no-cache'
          }
        });
        const envelope = await readJson<BootstrapDiscoveryEnvelope>(
          response,
          '读取引导配置失败，请稍后重试。'
        );
        await validateBootstrapEnvelope(envelope);
        const payload = envelope.payload;
        const syncServiceURL = ensureHttpsEndpoint(payload.syncServiceUrl);
        const policy: CloudSyncPolicy = {
          defaultSyncDomain: syncServiceURL,
          lockSyncDomain: payload.lockSyncDomain === true,
          hideSyncDomainInput: payload.hideSyncDomainInput === true,
          requireActivation: payload.requireActivation !== false,
          setupRequired: payload.setupRequired === true,
          proCheckoutUrl: resolveCheckoutURLFromDomain(syncServiceURL)
        };
        saveCloudSyncPolicy(policy);
        writeBootstrapCache({
          endpoint,
          expiresAt: payload.expiresAt,
          policy
        });
        logAppInfo('cloud-bootstrap', '引导发现成功', {
          endpoint,
          keyId: envelope.keyId,
          domain: syncServiceURL
        });
        return policy;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logAppWarn('cloud-bootstrap', '引导发现失败', {
          endpoint,
          discoverURL,
          error: message
        });
        lastError = error instanceof Error ? error : new Error(message);
      }
    }
  }

  throw lastError ?? new Error('自动发现同步服务失败，请稍后重试。');
};

export const getCloudLicenseStatus = async (
  session: CloudSyncSession
): Promise<CloudLicenseStatus> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/license/status`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.token}`
    }
  });
  return readJson<CloudLicenseStatus>(response, '读取授权状态失败，请稍后重试。');
};

export const getCloudUser2FAStatus = async (
  session: CloudSyncSession
): Promise<CloudUser2FAStatus> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/2fa/status`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${session.token}`
    }
  });
  return readJson<CloudUser2FAStatus>(response, '读取 2FA 状态失败，请稍后重试。');
};

export const beginCloudUser2FA = async (
  session: CloudSyncSession
): Promise<CloudUser2FABeginResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/2fa/totp/begin`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({})
  });
  return readJson<CloudUser2FABeginResponse>(response, '生成 2FA 密钥失败，请稍后重试。');
};

export const enableCloudUser2FA = async (
  session: CloudSyncSession,
  payload: {
    secret: string;
    otpCode: string;
  }
): Promise<CloudUser2FAEnableResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/2fa/totp/enable`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({
      secret: payload.secret,
      otpCode: payload.otpCode
    })
  });
  return readJson<CloudUser2FAEnableResponse>(response, '启用 2FA 失败，请稍后重试。');
};

export const disableCloudUser2FA = async (
  session: CloudSyncSession,
  payload: {
    otpCode?: string;
    backupCode?: string;
  }
): Promise<{ message: string }> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/2fa/totp/disable`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({
      otpCode: payload.otpCode?.trim() || undefined,
      backupCode: payload.backupCode?.trim() || undefined
    })
  });
  return readJson<{ message: string }>(response, '关闭 2FA 失败，请稍后重试。');
};

export const activateCloudLicense = async (
  session: CloudSyncSession,
  code: string
): Promise<LicenseActivateResponse> => {
  const endpoint = ensureHttpsEndpoint(session.apiBaseUrl);
  const response = await withTimeout(`${endpoint}/license/activate`, {
    method: 'POST',
    headers: authHeaders(session.token),
    body: JSON.stringify({ code })
  });
  return readJson<LicenseActivateResponse>(response, '激活失败，请稍后重试。');
};
