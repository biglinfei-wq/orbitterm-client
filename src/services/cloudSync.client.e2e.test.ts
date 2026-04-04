import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CloudSyncModule = typeof import('./cloudSync');

const base64UrlEncode = (input: Buffer): string => {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
};

const canonicalText = (payload: {
  version: number;
  issuedAt: string;
  expiresAt: string;
  syncServiceUrl: string;
  lockSyncDomain: boolean;
  hideSyncDomainInput: boolean;
  requireActivation: boolean;
  setupRequired: boolean;
  nonce?: string;
}): string => {
  const boolText = (value: boolean): string => (value ? 'true' : 'false');
  return [
    `version=${payload.version}`,
    `issued_at=${payload.issuedAt}`,
    `expires_at=${payload.expiresAt}`,
    `sync_service_url=${payload.syncServiceUrl}`,
    `lock_sync_domain=${boolText(payload.lockSyncDomain)}`,
    `hide_sync_domain_input=${boolText(payload.hideSyncDomainInput)}`,
    `require_activation=${boolText(payload.requireActivation)}`,
    `setup_required=${boolText(payload.setupRequired)}`,
    `nonce=${payload.nonce ?? ''}`
  ].join('\n');
};

const importCloudSyncModule = async (): Promise<CloudSyncModule> => {
  vi.resetModules();
  return import('./cloudSync');
};

describe('cloudSync client critical flow tests', () => {
  const createMemoryStorage = (): Storage => {
    const store = new Map<string, string>();
    return {
      get length() {
        return store.size;
      },
      clear() {
        store.clear();
      },
      getItem(key: string) {
        return store.has(key) ? store.get(key)! : null;
      },
      key(index: number) {
        return Array.from(store.keys())[index] ?? null;
      },
      removeItem(key: string) {
        store.delete(key);
      },
      setItem(key: string, value: string) {
        store.set(String(key), String(value));
      }
    };
  };

  beforeEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: createMemoryStorage(),
      configurable: true
    });
    window.localStorage.clear();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('discovers bootstrap policy with valid signature', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    vi.stubEnv('VITE_BOOTSTRAP_ENDPOINTS', 'https://bootstrap.example.com');
    vi.stubEnv(
      'VITE_BOOTSTRAP_KEYRING_JSON',
      JSON.stringify({
        'test-bootstrap-key': publicPem
      })
    );
    vi.stubEnv('VITE_BOOTSTRAP_ALLOW_MANUAL_SYNC_URL', 'false');

    const cloudSync = await importCloudSyncModule();
    const now = new Date();
    const payload = {
      version: 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 2 * 60 * 1000).toISOString(),
      syncServiceUrl: 'https://sync.example.com',
      lockSyncDomain: true,
      hideSyncDomainInput: true,
      requireActivation: true,
      setupRequired: false,
      nonce: 'nonce-e2e-1'
    };
    const signature = sign(null, Buffer.from(canonicalText(payload), 'utf-8'), privateKey);
    const envelope = {
      algorithm: 'Ed25519',
      keyId: 'test-bootstrap-key',
      payload,
      signature: base64UrlEncode(signature)
    };

    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify(envelope), {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const policy = await cloudSync.discoverCloudSyncPolicy({ force: true });
    expect(policy.defaultSyncDomain).toBe('https://sync.example.com');
    expect(policy.lockSyncDomain).toBe(true);
    expect(cloudSync.readCloudSyncPolicy()?.defaultSyncDomain).toBe('https://sync.example.com');
  });

  it('completes login and persists session', async () => {
    vi.stubEnv('VITE_BOOTSTRAP_ENDPOINTS', '');
    vi.stubEnv('VITE_BOOTSTRAP_KEYRING_JSON', '');
    vi.stubEnv('VITE_BOOTSTRAP_ALLOW_MANUAL_SYNC_URL', 'true');
    const cloudSync = await importCloudSyncModule();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/login')) {
        return new Response(
          JSON.stringify({
            token: 'token-1',
            user: {
              id: 'user-1',
              email: 'user@example.com'
            },
            currentDeviceId: 'device-1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/client/config')) {
        return new Response(
          JSON.stringify({
            defaultSyncDomain: 'https://sync.example.com',
            lockSyncDomain: true,
            hideSyncDomainInput: true,
            requireActivation: true,
            setupRequired: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await cloudSync.loginCloudSync(
      'https://sync.example.com',
      'user@example.com',
      'passw0rd1234'
    );
    expect(session.token).toBe('token-1');
    expect(cloudSync.readCloudSyncSession()?.email).toBe('user@example.com');
  });

  it('completes sync push, status and pull flow', async () => {
    vi.stubEnv('VITE_BOOTSTRAP_ENDPOINTS', '');
    vi.stubEnv('VITE_BOOTSTRAP_KEYRING_JSON', '');
    vi.stubEnv('VITE_BOOTSTRAP_ALLOW_MANUAL_SYNC_URL', 'true');
    const cloudSync = await importCloudSyncModule();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/sync/push')) {
        return new Response(
          JSON.stringify({
            acceptedVersion: 4,
            updatedAt: '2026-03-30T00:00:00Z',
            traceId: 'trace-push-1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/sync/status')) {
        return new Response(
          JSON.stringify({
            hasData: true,
            version: 4,
            updatedAt: '2026-03-30T00:00:00Z',
            traceId: 'trace-status-1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/sync/pull')) {
        return new Response(
          JSON.stringify({
            hasData: true,
            version: 4,
            encryptedBlobBase64: 'Y2lwaGVyLWRhdGE=',
            updatedAt: '2026-03-30T00:00:00Z',
            traceId: 'trace-pull-1'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = {
      apiBaseUrl: 'https://sync.example.com',
      email: 'user@example.com',
      token: 'token-1',
      currentDeviceId: 'device-1'
    };

    const push = await cloudSync.pushCloudSyncBlob(session, {
      version: 3,
      encryptedBlobBase64: 'Y2lwaGVyLWRhdGE='
    });
    expect(push.acceptedVersion).toBe(4);

    const status = await cloudSync.getCloudSyncStatus(session);
    expect(status.hasData).toBe(true);
    expect(status.version).toBe(4);

    const pull = await cloudSync.pullCloudSyncBlob(session);
    expect(pull.hasData).toBe(true);
    expect(pull.version).toBe(4);
    expect(pull.encryptedBlobBase64).toBe('Y2lwaGVyLWRhdGE=');
  });

  it('completes user 2FA setup and disable flow', async () => {
    vi.stubEnv('VITE_BOOTSTRAP_ENDPOINTS', '');
    vi.stubEnv('VITE_BOOTSTRAP_KEYRING_JSON', '');
    vi.stubEnv('VITE_BOOTSTRAP_ALLOW_MANUAL_SYNC_URL', 'true');
    const cloudSync = await importCloudSyncModule();

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/2fa/status')) {
        return new Response(
          JSON.stringify({
            enabled: false,
            method: 'totp',
            backupCodesRemaining: 0
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/2fa/totp/begin')) {
        return new Response(
          JSON.stringify({
            method: 'totp',
            secret: 'BASE32SECRET',
            issuer: 'OrbitTerm',
            account: 'user@example.com',
            otpauthUri: 'otpauth://totp/OrbitTerm:user@example.com?secret=BASE32SECRET'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/2fa/totp/enable')) {
        return new Response(
          JSON.stringify({
            message: '2FA 已启用',
            backupCodes: ['CODE1', 'CODE2']
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/2fa/totp/disable')) {
        return new Response(
          JSON.stringify({
            message: '2FA 已关闭'
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = {
      apiBaseUrl: 'https://sync.example.com',
      email: 'user@example.com',
      token: 'token-1',
      currentDeviceId: 'device-1'
    };

    const status = await cloudSync.getCloudUser2FAStatus(session);
    expect(status.enabled).toBe(false);
    const begin = await cloudSync.beginCloudUser2FA(session);
    expect(begin.secret).toBe('BASE32SECRET');
    const enabled = await cloudSync.enableCloudUser2FA(session, {
      secret: begin.secret,
      otpCode: '123456'
    });
    expect(enabled.backupCodes.length).toBe(2);
    const disabled = await cloudSync.disableCloudUser2FA(session, {
      backupCode: 'CODE1'
    });
    expect(disabled.message).toContain('关闭');
  });
});
