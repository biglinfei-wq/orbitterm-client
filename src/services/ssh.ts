import type { HostConfig, IdentityConfig } from '../types/host';
import { tauriInvoke } from './tauri';

export interface SshConnectedResponse {
  sessionId: string;
  ptyBackend: string;
}

export type SshKeyAlgorithm =
  | 'ed25519'
  | 'rsa3072'
  | 'rsa4096'
  | 'ecdsaP256'
  | 'ecdsaP384'
  | 'ecdsaP521';

export interface SshGenerateKeypairResponse {
  algorithm: SshKeyAlgorithm;
  privateKey: string;
  publicKey: string;
  fingerprint: string;
}

export interface SshDerivePublicKeyResponse {
  publicKey: string;
  fingerprint: string;
}

export interface SshExportPrivateKeyResponse {
  path: string;
  bytes: number;
}

export interface SshPasswordAuthStatusResponse {
  supported: boolean;
  enabled: boolean;
  detail: string;
  backupPath?: string | null;
}

export interface SshHostDiskInfo {
  mountPoint: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: string;
}

export interface SshHostInfoResponse {
  hostname: string;
  osName: string;
  osVersion: string;
  kernelName: string;
  kernelRelease: string;
  kernelVersion: string;
  architecture: string;
  cpuModel: string;
  cpuCores: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  disks: SshHostDiskInfo[];
}

interface SshConnectRequest {
  sessionId?: string;
  hostConfig: HostConfig;
  identityConfig: IdentityConfig;
  proxyChain: ProxyJumpHop[];
  cols?: number;
  rows?: number;
  term?: string;
}

export interface ProxyJumpHop {
  hostConfig: HostConfig;
  identityConfig: IdentityConfig;
}

export interface SysStatus {
  cpuUsagePercent: number;
  memoryUsagePercent: number;
  netRxBytesPerSec: number;
  netTxBytesPerSec: number;
  latencyMs?: number | null;
  sampledAt: number;
  intervalSecs: number;
}

export interface SshSysStatusEvent {
  sessionId: string;
  status: SysStatus;
}

const CWD_MARKER_LINE_PATTERN = /\u001d[^\u001d\r\n]{0,4096}\u001d\r?\n?/g;

const toConnectRequest = (
  host: HostConfig,
  identity: IdentityConfig,
  proxyChain: ProxyJumpHop[]
): SshConnectRequest => {
  return {
    hostConfig: host,
    identityConfig: identity,
    proxyChain,
    cols: 120,
    rows: 30,
    term: 'xterm-256color'
  };
};

export const sshConnect = async (
  host: HostConfig,
  identity: IdentityConfig,
  proxyChain: ProxyJumpHop[] = []
): Promise<SshConnectedResponse> => {
  return tauriInvoke<SshConnectedResponse>('ssh_connect', {
    request: toConnectRequest(host, identity, proxyChain)
  });
};

export const sshWrite = async (sessionId: string, data: string): Promise<void> => {
  await tauriInvoke<void>('ssh_write', {
    request: {
      sessionId,
      data
    }
  });
};

export const sshResize = async (
  sessionId: string,
  cols: number,
  rows: number
): Promise<void> => {
  await tauriInvoke<void>('ssh_resize', {
    request: {
      sessionId,
      cols,
      rows
    }
  });
};

export const sshDisconnect = async (sessionId: string): Promise<void> => {
  await tauriInvoke<void>('ssh_disconnect', {
    request: {
      sessionId
    }
  });
};

export const sshSetPulseActivity = async (sessionId: string, active: boolean): Promise<void> => {
  await tauriInvoke<void>('ssh_set_pulse_activity', {
    request: {
      sessionId,
      active
    }
  });
};

export const sshGenerateKeypair = async (
  algorithm: SshKeyAlgorithm,
  comment?: string
): Promise<SshGenerateKeypairResponse> => {
  return tauriInvoke<SshGenerateKeypairResponse>('ssh_generate_keypair', {
    request: {
      algorithm,
      comment: comment?.trim() ? comment.trim() : undefined
    }
  });
};

export const sshDerivePublicKey = async (
  privateKey: string
): Promise<SshDerivePublicKeyResponse> => {
  return tauriInvoke<SshDerivePublicKeyResponse>('ssh_derive_public_key', {
    request: {
      privateKey
    }
  });
};

export const sshDeployPublicKey = async (
  sessionId: string,
  publicKey: string
): Promise<void> => {
  await tauriInvoke<void>('ssh_deploy_public_key', {
    request: {
      sessionId,
      publicKey
    }
  });
};

export const sshExportPrivateKey = async (
  privateKey: string,
  destinationPath: string
): Promise<SshExportPrivateKeyResponse> => {
  return tauriInvoke<SshExportPrivateKeyResponse>('ssh_export_private_key', {
    request: {
      privateKey,
      destinationPath
    }
  });
};

export const sshPasswordAuthStatus = async (
  sessionId: string
): Promise<SshPasswordAuthStatusResponse> => {
  return tauriInvoke<SshPasswordAuthStatusResponse>('ssh_password_auth_status', {
    request: {
      sessionId
    }
  });
};

export const sshSetPasswordAuth = async (
  sessionId: string,
  enabled: boolean
): Promise<SshPasswordAuthStatusResponse> => {
  return tauriInvoke<SshPasswordAuthStatusResponse>('ssh_set_password_auth', {
    request: {
      sessionId,
      enabled
    }
  });
};

export const sshQueryPwd = async (
  sessionId: string,
  _timeoutMs = 3500
): Promise<string> => {
  const result = await tauriInvoke<{ cwd: string }>('ssh_query_cwd', {
    request: {
      sessionId
    }
  });
  const cwd = typeof result?.cwd === 'string' ? result.cwd.trim() : '';
  if (!cwd) {
    throw new Error('未能识别当前终端路径，请重试。');
  }
  return cwd;
};

export const sshQueryHostInfo = async (
  sessionId: string
): Promise<SshHostInfoResponse> => {
  return tauriInvoke<SshHostInfoResponse>('ssh_query_host_info', {
    request: {
      sessionId
    }
  });
};

export const sanitizeSshOutputForDisplay = (sessionId: string, chunk: string): string => {
  void sessionId;
  if (!chunk) {
    return '';
  }

  // Keep terminal control chars untouched to avoid breaking prompt/newline rendering.
  // Only strip null bytes and internal cwd probe markers if they appear.
  return chunk
    .replace(/\u0000/g, '')
    .replace(CWD_MARKER_LINE_PATTERN, '');
};
