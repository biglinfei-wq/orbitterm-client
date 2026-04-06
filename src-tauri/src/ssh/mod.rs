use std::collections::HashMap;
use std::io::SeekFrom;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use russh::client;
use russh::keys::{decode_openssh, PrivateKeyWithHashAlg};
use russh::{ChannelMsg, Disconnect};
use russh_sftp::client::{error::Error as SftpError, SftpSession};
use russh_sftp::protocol::{FileType, OpenFlags, StatusCode};
use tauri::{AppHandle, Emitter};
use tokio::fs as tokio_fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::sync::{mpsc, Mutex, RwLock};
use tokio::time::{sleep, timeout, Instant};
use uuid::Uuid;

use crate::error::{map_russh_error, SshBackendError, SshResult};
use crate::models::{
    AuthMethod, SftpActionResponse, SftpCompressRequest, SftpCopyRequest, SftpDownloadRequest,
    SftpEntry, SftpExtractRequest, SftpLsRequest, SftpLsResponse, SftpMkdirRequest,
    SftpPathUsageRequest, SftpPathUsageResponse, SftpReadTextRequest, SftpReadTextResponse,
    SftpRenameRequest, SftpRmRequest, SftpTransferProgressEvent, SftpTransferResponse,
    SftpUploadRequest, SshClosedEvent, SshConnectRequest, SshConnectedResponse,
    SshDiagnosticLogEvent, SshErrorEvent, SshHostDiskInfo, SshHostInfoResponse, SshOutputEvent,
    SshPasswordAuthStatusResponse, SshQueryCwdResponse, SshSysStatusEvent, SysStatus,
};

#[derive(Debug)]
pub enum SessionCommand {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Disconnect,
}

#[derive(Clone)]
struct SessionEntry {
    command_tx: mpsc::Sender<SessionCommand>,
    handle: Arc<Mutex<client::Handle<ClientHandler>>>,
    tunnel_handles: Vec<Arc<Mutex<client::Handle<ClientHandler>>>>,
    pulse_active: Arc<RwLock<bool>>,
}

#[derive(Debug, Clone)]
struct LatencyProbeTarget {
    host: String,
    port: u16,
}

#[derive(Clone, Default)]
pub struct SshSessionRegistry {
    sessions: Arc<RwLock<HashMap<String, SessionEntry>>>,
}

#[derive(Debug, Default, Clone)]
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

impl SshSessionRegistry {
    pub async fn connect(
        &self,
        app: AppHandle,
        request: SshConnectRequest,
    ) -> SshResult<SshConnectedResponse> {
        validate_connect_request(&request)?;

        let timeout_secs = request
            .host_config
            .advanced_options
            .connection_timeout
            .max(3);
        let cols = request.cols.unwrap_or(120).max(40);
        let rows = request.rows.unwrap_or(30).max(10);
        let term = request
            .term
            .clone()
            .unwrap_or_else(|| "xterm-256color".to_string());

        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| Uuid::new_v4().to_string());

        let backend = pty_backend_name().to_string();
        let latency_probe_target = LatencyProbeTarget {
            host: request.host_config.basic_info.address.trim().to_string(),
            port: request.host_config.basic_info.port,
        };

        let mut config = client::Config::default();
        // inactivity_timeout 代表会话空闲断开阈值，不应复用“连接超时”配置，
        // 否则会在短时间无输入时频繁断线（例如 10 秒）。
        config.inactivity_timeout = None;
        if request.host_config.advanced_options.keep_alive_enabled {
            let interval = request
                .host_config
                .advanced_options
                .keep_alive_interval
                .max(5);
            config.keepalive_interval = Some(Duration::from_secs(interval));
            config.keepalive_max = 3;
        } else {
            config.keepalive_interval = None;
        }
        emit_diagnostic_log(
            &app,
            &session_id,
            "info",
            "kex",
            format!(
                "KEX 偏好: {}",
                format_algorithm_list(config.preferred.kex.as_ref(), 4)
            ),
        );
        let jump_auth_chain = request
            .proxy_chain
            .iter()
            .map(|hop| auth_method_label(&hop.identity_config.auth_config.method))
            .collect::<Vec<&str>>();
        emit_diagnostic_log(
            &app,
            &session_id,
            "info",
            "auth",
            format!(
                "认证方式: 主机 [{}], 跳板链 {}",
                auth_method_label(&request.identity_config.auth_config.method),
                if jump_auth_chain.is_empty() {
                    "无".to_string()
                } else {
                    jump_auth_chain.join(" -> ")
                }
            ),
        );

        let config = Arc::new(config);
        let (handle_ref, tunnel_handles) =
            establish_connection_chain(&request, config, timeout_secs, &app, &session_id).await?;

        let mut channel = {
            let guard = handle_ref.lock().await;
            guard
                .channel_open_session()
                .await
                .map_err(|err| map_russh_error(&err))?
        };

        channel
            .request_pty(true, &term, u32::from(cols), u32::from(rows), 0, 0, &[])
            .await
            .map_err(|err| map_russh_error(&err))?;

        channel
            .request_shell(true)
            .await
            .map_err(|err| map_russh_error(&err))?;

        let (command_tx, mut command_rx) = mpsc::channel::<SessionCommand>(512);
        let pulse_active = Arc::new(RwLock::new(true));

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(
                session_id.clone(),
                SessionEntry {
                    command_tx: command_tx.clone(),
                    handle: handle_ref.clone(),
                    tunnel_handles: tunnel_handles.clone(),
                    pulse_active: pulse_active.clone(),
                },
            );
        }

        let monitor_registry = self.clone();
        let monitor_app = app.clone();
        let monitor_session_id = session_id.clone();
        let monitor_handle = handle_ref.clone();
        tokio::spawn(async move {
            monitor_registry
                .run_sys_status_monitor(
                    monitor_app,
                    monitor_session_id,
                    monitor_handle,
                    pulse_active,
                    latency_probe_target,
                )
                .await;
        });

        let registry = self.clone();
        let app_for_loop = app.clone();
        let loop_session_id = session_id.clone();
        let handle_for_loop = handle_ref.clone();
        let tunnel_handles_for_loop = tunnel_handles;
        tokio::spawn(async move {
            let mut writer = channel.make_writer();
            let mut has_error = false;

            loop {
                tokio::select! {
                    cmd = command_rx.recv() => {
                        match cmd {
                            Some(SessionCommand::Input(data)) => {
                                if writer.write_all(data.as_bytes()).await.is_err() {
                                    has_error = true;
                                    emit_error(
                                        &app_for_loop,
                                        Some(loop_session_id.clone()),
                                        SshBackendError::ChannelClosed,
                                    );
                                    break;
                                }
                            }
                            Some(SessionCommand::Resize { cols, rows }) => {
                                let remote_resize = channel
                                    .window_change(u32::from(cols), u32::from(rows), 0, 0)
                                    .await;
                                if let Err(err) = remote_resize {
                                    has_error = true;
                                    emit_error(
                                        &app_for_loop,
                                        Some(loop_session_id.clone()),
                                        map_russh_error(&err),
                                    );
                                    break;
                                }
                            }
                            Some(SessionCommand::Disconnect) | None => {
                                break;
                            }
                        }
                    }
                    msg = channel.wait() => {
                        match msg {
                            Some(ChannelMsg::Data { data }) => {
                                let payload = SshOutputEvent {
                                    session_id: loop_session_id.clone(),
                                    data: String::from_utf8_lossy(&data).to_string(),
                                };
                                if app_for_loop.emit("ssh-output", payload).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::ExtendedData { data, .. }) => {
                                let payload = SshOutputEvent {
                                    session_id: loop_session_id.clone(),
                                    data: String::from_utf8_lossy(&data).to_string(),
                                };
                                if app_for_loop.emit("ssh-output", payload).is_err() {
                                    break;
                                }
                            }
                            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                                break;
                            }
                            Some(_) => {}
                            None => {
                                break;
                            }
                        }
                    }
                }
            }

            let _ = channel.eof().await;
            let _ = channel.close().await;
            {
                let guard = handle_for_loop.lock().await;
                let _ = guard
                    .disconnect(Disconnect::ByApplication, "session closed", "zh-CN")
                    .await;
            }
            for tunnel_handle in tunnel_handles_for_loop.iter().rev() {
                let guard = tunnel_handle.lock().await;
                let _ = guard
                    .disconnect(Disconnect::ByApplication, "session closed", "zh-CN")
                    .await;
            }

            registry.remove_session(&loop_session_id).await;

            if !has_error {
                let _ = app_for_loop.emit(
                    "ssh-closed",
                    SshClosedEvent {
                        session_id: loop_session_id,
                    },
                );
            }
        });

        Ok(SshConnectedResponse {
            session_id,
            pty_backend: backend,
        })
    }

    pub async fn write_input(&self, session_id: &str, data: String) -> SshResult<()> {
        let tx = self.get_sender(session_id).await?;
        tx.send(SessionCommand::Input(data))
            .await
            .map_err(|_| SshBackendError::ChannelClosed)
    }

    pub async fn resize(&self, session_id: &str, cols: u16, rows: u16) -> SshResult<()> {
        let tx = self.get_sender(session_id).await?;
        tx.send(SessionCommand::Resize { cols, rows })
            .await
            .map_err(|_| SshBackendError::ChannelClosed)
    }

    pub async fn disconnect(&self, session_id: &str) -> SshResult<()> {
        let entry = self.get_entry(session_id).await?;
        let send_result = entry.command_tx.send(SessionCommand::Disconnect).await;
        if send_result.is_ok() {
            return Ok(());
        }

        self.force_close_entry(session_id.to_string(), entry).await;
        Err(SshBackendError::ChannelClosed)
    }

    pub async fn set_pulse_activity(&self, session_id: &str, active: bool) -> SshResult<()> {
        let entry = self.get_entry(session_id).await?;
        let mut guard = entry.pulse_active.write().await;
        *guard = active;
        Ok(())
    }

    pub async fn deploy_public_key(&self, session_id: &str, public_key: String) -> SshResult<()> {
        let command = crate::key_manager::build_deploy_command(public_key.as_str())
            .map_err(|err| SshBackendError::RemoteCommand(err.user_message()))?;
        let (status, stdout, stderr) = self.exec_command(session_id, command.as_str(), 15).await?;
        if status == 0 {
            return Ok(());
        }

        let detail = if !stderr.trim().is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout
        } else {
            format!("远端返回状态码 {status}")
        };
        Err(SshBackendError::RemoteCommand(detail))
    }

    pub async fn query_password_auth_status(
        &self,
        session_id: &str,
    ) -> SshResult<SshPasswordAuthStatusResponse> {
        let command = build_password_auth_status_command();
        let (status, stdout, stderr) = self.exec_command(session_id, command.as_str(), 18).await?;
        if status == 0 {
            return Ok(parse_password_auth_status_output(
                stdout.as_str(),
                None,
                "状态读取成功",
            ));
        }
        if status == 64 && stdout.contains("__OT_UNSUPPORTED__") {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                "远端系统不支持该操作".to_string()
            };
            return Ok(SshPasswordAuthStatusResponse {
                supported: false,
                enabled: true,
                detail,
                backup_path: None,
            });
        }

        let detail = if !stderr.trim().is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout
        } else {
            format!("远端返回状态码 {status}")
        };
        Err(SshBackendError::RemoteCommand(detail))
    }

    pub async fn query_cwd(&self, session_id: &str) -> SshResult<SshQueryCwdResponse> {
        let command = "sh -lc 'pwd -P 2>/dev/null || pwd'";
        let (status, stdout, stderr) = self.exec_command(session_id, command, 8).await?;
        if status != 0 {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                format!("远端返回状态码 {status}")
            };
            return Err(SshBackendError::RemoteCommand(detail));
        }

        if let Some(cwd) = parse_cwd_output(stdout.as_str()) {
            return Ok(SshQueryCwdResponse { cwd });
        }

        Err(SshBackendError::RemoteCommand(
            "未能识别远端当前目录。".to_string(),
        ))
    }

    pub async fn query_host_info(&self, session_id: &str) -> SshResult<SshHostInfoResponse> {
        let command = build_host_info_command();
        let (status, stdout, stderr) = self.exec_command(session_id, command.as_str(), 20).await?;
        if status != 0 {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                format!("远端返回状态码 {status}")
            };
            return Err(SshBackendError::RemoteCommand(detail));
        }
        Ok(parse_host_info_output(stdout.as_str()))
    }

    pub async fn sftp_copy(&self, request: SftpCopyRequest) -> SshResult<()> {
        if request.from_path.trim().is_empty() || request.to_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }
        let command = build_copy_path_command(request.from_path.as_str(), request.to_path.as_str());
        let (status, stdout, stderr) = self
            .exec_command(&request.session_id, command.as_str(), 20)
            .await?;
        if status == 0 {
            return Ok(());
        }
        let detail = if !stderr.trim().is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout
        } else {
            format!("远端返回状态码 {status}")
        };
        Err(SshBackendError::RemoteCommand(detail))
    }

    pub async fn sftp_compress(
        &self,
        request: SftpCompressRequest,
    ) -> SshResult<SftpActionResponse> {
        if request.path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }
        let command = build_compress_path_command(
            request.path.as_str(),
            request.archive_name.as_deref().unwrap_or_default(),
        );
        let (status, stdout, stderr) = self
            .exec_command(&request.session_id, command.as_str(), 32)
            .await?;
        if status != 0 {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                format!("远端返回状态码 {status}")
            };
            return Err(SshBackendError::RemoteCommand(detail));
        }
        let archive_path =
            parse_kv_line(stdout.as_str(), "PATH").unwrap_or_else(|| request.path.clone());
        Ok(SftpActionResponse {
            path: archive_path.clone(),
            message: format!("压缩完成：{archive_path}"),
        })
    }

    pub async fn sftp_extract(&self, request: SftpExtractRequest) -> SshResult<SftpActionResponse> {
        if request.archive_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }
        let command = build_extract_path_command(
            request.archive_path.as_str(),
            request.destination_dir.as_deref().unwrap_or_default(),
        );
        let (status, stdout, stderr) = self
            .exec_command(&request.session_id, command.as_str(), 40)
            .await?;
        if status != 0 {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                format!("远端返回状态码 {status}")
            };
            return Err(SshBackendError::RemoteCommand(detail));
        }
        let destination_path =
            parse_kv_line(stdout.as_str(), "PATH").unwrap_or_else(|| request.archive_path.clone());
        Ok(SftpActionResponse {
            path: destination_path.clone(),
            message: format!("解压完成：{destination_path}"),
        })
    }

    pub async fn sftp_path_usage(
        &self,
        request: SftpPathUsageRequest,
    ) -> SshResult<SftpPathUsageResponse> {
        if request.path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }
        let command = build_path_usage_command(request.path.as_str());
        let (status, stdout, stderr) = self
            .exec_command(&request.session_id, command.as_str(), 20)
            .await?;
        if status != 0 {
            let detail = if !stderr.trim().is_empty() {
                stderr
            } else if !stdout.trim().is_empty() {
                stdout
            } else {
                format!("远端返回状态码 {status}")
            };
            return Err(SshBackendError::RemoteCommand(detail));
        }
        let used_bytes = parse_kv_line(stdout.as_str(), "USED")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let total_bytes = parse_kv_line(stdout.as_str(), "TOTAL")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let available_bytes = parse_kv_line(stdout.as_str(), "AVAIL")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        let path = parse_kv_line(stdout.as_str(), "PATH").unwrap_or_else(|| request.path.clone());
        Ok(SftpPathUsageResponse {
            path,
            used_bytes,
            total_bytes,
            available_bytes,
        })
    }

    pub async fn set_password_auth_enabled(
        &self,
        session_id: &str,
        enabled: bool,
    ) -> SshResult<SshPasswordAuthStatusResponse> {
        let command = build_set_password_auth_command(enabled);
        let (status, stdout, stderr) = self.exec_command(session_id, command.as_str(), 28).await?;
        if status == 0 {
            let default_detail = if enabled {
                "已开启密码登录"
            } else {
                "已关闭密码登录"
            };
            return Ok(parse_password_auth_status_output(
                stdout.as_str(),
                None,
                default_detail,
            ));
        }

        if status == 64 && stdout.contains("__OT_UNSUPPORTED__") {
            return Ok(SshPasswordAuthStatusResponse {
                supported: false,
                enabled: true,
                detail: "远端系统不支持密码登录策略切换（仅支持 Linux OpenSSH）。".to_string(),
                backup_path: None,
            });
        }

        if status == 65 && stdout.contains("__OT_PERMISSION__") {
            return Err(SshBackendError::RemoteCommand(
                "需要 root 或免密 sudo 权限才能修改 sshd_config。".to_string(),
            ));
        }

        let detail = if !stderr.trim().is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout
        } else {
            format!("远端返回状态码 {status}")
        };
        Err(SshBackendError::RemoteCommand(detail))
    }

    pub async fn sftp_ls(&self, request: SftpLsRequest) -> SshResult<SftpLsResponse> {
        let target_path = if request.path.trim().is_empty() {
            ".".to_string()
        } else {
            request.path.clone()
        };

        let sftp = self.open_sftp_session(&request.session_id).await?;
        let canonical_path = sftp
            .canonicalize(target_path)
            .await
            .map_err(map_sftp_error)?;

        let mut entries = Vec::new();
        let read_dir = sftp
            .read_dir(canonical_path.clone())
            .await
            .map_err(map_sftp_error)?;

        for entry in read_dir {
            let metadata = entry.metadata();
            let file_type = metadata.file_type();
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let path = join_remote_path(&canonical_path, &name);
            let modified_at = metadata.mtime.map(i64::from);
            entries.push(SftpEntry {
                name,
                path,
                is_dir: file_type.is_dir(),
                size: metadata.len(),
                modified_at,
                file_type: file_type_label(file_type).to_string(),
            });
        }

        entries.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });

        let _ = sftp.close().await;

        Ok(SftpLsResponse {
            path: canonical_path,
            entries,
        })
    }

    pub async fn sftp_mkdir(&self, request: SftpMkdirRequest) -> SshResult<()> {
        if request.path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let sftp = self.open_sftp_session(&request.session_id).await?;
        sftp.create_dir(request.path)
            .await
            .map_err(map_sftp_error)?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn sftp_rm(&self, request: SftpRmRequest) -> SshResult<()> {
        if request.path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let sftp = self.open_sftp_session(&request.session_id).await?;
        if request.recursive {
            remove_remote_path_recursive(&sftp, request.path).await?;
        } else {
            let metadata = sftp
                .symlink_metadata(request.path.clone())
                .await
                .map_err(map_sftp_error)?;
            if metadata.file_type().is_dir() {
                sftp.remove_dir(request.path)
                    .await
                    .map_err(map_sftp_error)?;
            } else {
                sftp.remove_file(request.path)
                    .await
                    .map_err(map_sftp_error)?;
            }
        }
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn sftp_rename(&self, request: SftpRenameRequest) -> SshResult<()> {
        if request.from_path.trim().is_empty() || request.to_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let sftp = self.open_sftp_session(&request.session_id).await?;
        sftp.rename(request.from_path, request.to_path)
            .await
            .map_err(map_sftp_error)?;
        let _ = sftp.close().await;
        Ok(())
    }

    pub async fn sftp_download(
        &self,
        app: AppHandle,
        request: SftpDownloadRequest,
    ) -> SshResult<SftpTransferResponse> {
        if request.remote_path.trim().is_empty() || request.local_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let sftp = self.open_sftp_session(&request.session_id).await?;
        let mut remote_file = sftp
            .open(request.remote_path.clone())
            .await
            .map_err(map_sftp_error)?;

        let remote_meta = sftp
            .metadata(request.remote_path.clone())
            .await
            .map_err(map_sftp_error)?;
        let total_size = remote_meta.len();
        let requested_resume = request.resume_from.unwrap_or(0).min(total_size);
        let local_existing = match tokio_fs::metadata(request.local_path.clone()).await {
            Ok(metadata) => metadata.len(),
            Err(_) => 0,
        };
        let start_offset = requested_resume.min(local_existing);

        if start_offset > 0 {
            remote_file
                .seek(SeekFrom::Start(start_offset))
                .await
                .map_err(|err| {
                    SshBackendError::SftpOperation(format!("定位远端下载偏移失败：{err}"))
                })?;
        }

        if let Some(parent) = Path::new(request.local_path.as_str()).parent() {
            tokio_fs::create_dir_all(parent).await.map_err(|err| {
                SshBackendError::SftpOperation(format!("创建本地目录失败：{err}"))
            })?;
        }

        let mut local_file = if start_offset > 0 {
            tokio_fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(request.local_path.clone())
                .await
                .map_err(|err| SshBackendError::SftpOperation(format!("打开本地文件失败：{err}")))?
        } else {
            tokio_fs::File::create(request.local_path.clone())
                .await
                .map_err(|err| SshBackendError::SftpOperation(format!("创建本地文件失败：{err}")))?
        };

        let mut copied: u64 = start_offset;
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut emitted_progress: u8 = if total_size == 0 {
            0
        } else {
            ((copied.saturating_mul(100) / total_size).min(100)) as u8
        };
        let transfer_id = request
            .transfer_id
            .clone()
            .unwrap_or_else(|| format!("download:{}:{}", request.local_path, request.remote_path));

        let _ = app.emit(
            "sftp-transfer-progress",
            SftpTransferProgressEvent {
                session_id: request.session_id.clone(),
                transfer_id: transfer_id.clone(),
                direction: "download".to_string(),
                remote_path: request.remote_path.clone(),
                local_path: request.local_path.clone(),
                transferred_bytes: copied,
                total_bytes: total_size,
                progress: emitted_progress,
            },
        );

        loop {
            let read_len = remote_file.read(&mut buffer).await.map_err(|err| {
                SshBackendError::SftpOperation(format!("读取远端文件失败：{err}"))
            })?;
            if read_len == 0 {
                break;
            }

            local_file
                .write_all(&buffer[..read_len])
                .await
                .map_err(|err| {
                    SshBackendError::SftpOperation(format!("写入本地文件失败：{err}"))
                })?;
            copied = copied.saturating_add(read_len as u64);

            let progress = if total_size == 0 {
                100
            } else {
                ((copied.saturating_mul(100) / total_size).min(100)) as u8
            };
            if progress != emitted_progress {
                emitted_progress = progress;
                let _ = app.emit(
                    "sftp-transfer-progress",
                    SftpTransferProgressEvent {
                        session_id: request.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        direction: "download".to_string(),
                        remote_path: request.remote_path.clone(),
                        local_path: request.local_path.clone(),
                        transferred_bytes: copied,
                        total_bytes: total_size,
                        progress,
                    },
                );
            }
        }

        local_file
            .flush()
            .await
            .map_err(|err| SshBackendError::SftpOperation(format!("刷新本地文件失败：{err}")))?;

        if emitted_progress < 100 {
            let _ = app.emit(
                "sftp-transfer-progress",
                SftpTransferProgressEvent {
                    session_id: request.session_id.clone(),
                    transfer_id: transfer_id,
                    direction: "download".to_string(),
                    remote_path: request.remote_path.clone(),
                    local_path: request.local_path.clone(),
                    transferred_bytes: copied,
                    total_bytes: total_size,
                    progress: 100,
                },
            );
        }

        let _ = sftp.close().await;
        Ok(SftpTransferResponse {
            path: request.local_path,
            bytes: copied,
            total_bytes: total_size,
        })
    }

    pub async fn sftp_read_text(
        &self,
        request: SftpReadTextRequest,
    ) -> SshResult<SftpReadTextResponse> {
        if request.remote_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let max_bytes = request
            .max_bytes
            .unwrap_or(2 * 1024 * 1024)
            .clamp(1, 8 * 1024 * 1024);
        let sftp = self.open_sftp_session(&request.session_id).await?;
        let mut remote_file = sftp
            .open(request.remote_path.clone())
            .await
            .map_err(map_sftp_error)?;

        let mut bytes: Vec<u8> = Vec::with_capacity(max_bytes.min(256 * 1024));
        let mut buffer = vec![0_u8; 64 * 1024];
        let mut truncated = false;
        loop {
            let read_len = remote_file.read(&mut buffer).await.map_err(|err| {
                SshBackendError::SftpOperation(format!("读取远端文件失败：{err}"))
            })?;
            if read_len == 0 {
                break;
            }

            let remaining = max_bytes.saturating_sub(bytes.len());
            if remaining == 0 {
                truncated = true;
                break;
            }

            let to_take = remaining.min(read_len);
            bytes.extend_from_slice(&buffer[..to_take]);
            if to_take < read_len {
                truncated = true;
                break;
            }
        }

        let content = String::from_utf8_lossy(&bytes).to_string();
        let _ = sftp.close().await;

        Ok(SftpReadTextResponse {
            path: request.remote_path,
            content,
            bytes: bytes.len() as u64,
            truncated,
        })
    }

    pub async fn sftp_upload(
        &self,
        app: AppHandle,
        request: SftpUploadRequest,
    ) -> SshResult<SftpTransferResponse> {
        if request.remote_path.trim().is_empty() {
            return Err(SshBackendError::InvalidInput);
        }

        let sftp = self.open_sftp_session(&request.session_id).await?;
        let transfer_id = request.transfer_id.clone().unwrap_or_else(|| {
            format!(
                "upload:{}:{}",
                request.local_path.clone().unwrap_or_default(),
                request.remote_path
            )
        });
        let (transferred, total_bytes) = if let Some(content_base64) =
            request.content_base64.clone()
        {
            let mut remote_file = sftp
                .open_with_flags(
                    request.remote_path.clone(),
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(map_sftp_error)?;
            let decoded = base64::engine::general_purpose::STANDARD
                .decode(content_base64.as_bytes())
                .map_err(|_| {
                    SshBackendError::SftpOperation("编辑内容编码错误，请重试。".to_string())
                })?;
            remote_file.write_all(&decoded).await.map_err(|err| {
                SshBackendError::SftpOperation(format!("写入远端文件失败：{err}"))
            })?;
            remote_file.shutdown().await.map_err(|err| {
                SshBackendError::SftpOperation(format!("关闭远端文件失败：{err}"))
            })?;
            let transferred = decoded.len() as u64;
            let total_bytes = transferred;
            let local_path_for_event = request.local_path.clone().unwrap_or_default();
            let _ = app.emit(
                "sftp-transfer-progress",
                SftpTransferProgressEvent {
                    session_id: request.session_id.clone(),
                    transfer_id: transfer_id.clone(),
                    direction: "upload".to_string(),
                    remote_path: request.remote_path.clone(),
                    local_path: local_path_for_event,
                    transferred_bytes: transferred,
                    total_bytes,
                    progress: 100,
                },
            );
            (transferred, total_bytes)
        } else {
            let local_path = request
                .local_path
                .clone()
                .ok_or(SshBackendError::InvalidInput)?;
            if local_path.trim().is_empty() {
                return Err(SshBackendError::InvalidInput);
            }

            let mut local_file = tokio_fs::File::open(local_path.clone())
                .await
                .map_err(|err| {
                    SshBackendError::SftpOperation(format!("读取本地文件失败：{err}"))
                })?;
            let metadata = local_file.metadata().await.map_err(|err| {
                SshBackendError::SftpOperation(format!("读取本地文件信息失败：{err}"))
            })?;
            let total_size = metadata.len();
            let requested_resume = request.resume_from.unwrap_or(0).min(total_size);
            let remote_existing = if requested_resume > 0 {
                match sftp.metadata(request.remote_path.clone()).await {
                    Ok(metadata) => metadata.len(),
                    Err(_) => 0,
                }
            } else {
                0
            };
            let resume_from = requested_resume.min(remote_existing);

            let mut remote_file = sftp
                .open_with_flags(
                    request.remote_path.clone(),
                    if resume_from > 0 {
                        OpenFlags::CREATE | OpenFlags::WRITE
                    } else {
                        OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
                    },
                )
                .await
                .map_err(map_sftp_error)?;

            if resume_from > 0 {
                remote_file
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(|err| {
                        SshBackendError::SftpOperation(format!("定位远端上传偏移失败：{err}"))
                    })?;
                local_file
                    .seek(SeekFrom::Start(resume_from))
                    .await
                    .map_err(|err| {
                        SshBackendError::SftpOperation(format!("定位本地上传偏移失败：{err}"))
                    })?;
            }

            let mut transferred = resume_from;
            let mut emitted_progress: u8 = if total_size == 0 {
                0
            } else {
                ((transferred.saturating_mul(100) / total_size).min(100)) as u8
            };
            let _ = app.emit(
                "sftp-transfer-progress",
                SftpTransferProgressEvent {
                    session_id: request.session_id.clone(),
                    transfer_id: transfer_id.clone(),
                    direction: "upload".to_string(),
                    remote_path: request.remote_path.clone(),
                    local_path: local_path.clone(),
                    transferred_bytes: transferred,
                    total_bytes: total_size,
                    progress: emitted_progress,
                },
            );
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                let read_len = local_file.read(&mut buffer).await.map_err(|err| {
                    SshBackendError::SftpOperation(format!("读取本地文件失败：{err}"))
                })?;
                if read_len == 0 {
                    break;
                }

                remote_file
                    .write_all(&buffer[..read_len])
                    .await
                    .map_err(|err| {
                        SshBackendError::SftpOperation(format!("写入远端文件失败：{err}"))
                    })?;
                transferred = transferred.saturating_add(read_len as u64);

                let progress = if total_size == 0 {
                    100
                } else {
                    let ratio = (transferred.saturating_mul(100) / total_size).min(100);
                    ratio as u8
                };
                if progress != emitted_progress {
                    emitted_progress = progress;
                    let _ = app.emit(
                        "sftp-upload-progress",
                        SftpTransferProgressEvent {
                            session_id: request.session_id.clone(),
                            transfer_id: transfer_id.clone(),
                            direction: "upload".to_string(),
                            remote_path: request.remote_path.clone(),
                            local_path: local_path.clone(),
                            transferred_bytes: transferred,
                            total_bytes: total_size,
                            progress,
                        },
                    );
                    let _ = app.emit(
                        "sftp-transfer-progress",
                        SftpTransferProgressEvent {
                            session_id: request.session_id.clone(),
                            transfer_id: transfer_id.clone(),
                            direction: "upload".to_string(),
                            remote_path: request.remote_path.clone(),
                            local_path: local_path.clone(),
                            transferred_bytes: transferred,
                            total_bytes: total_size,
                            progress,
                        },
                    );
                }
            }

            if emitted_progress < 100 {
                let _ = app.emit(
                    "sftp-upload-progress",
                    SftpTransferProgressEvent {
                        session_id: request.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        direction: "upload".to_string(),
                        remote_path: request.remote_path.clone(),
                        local_path,
                        transferred_bytes: transferred,
                        total_bytes: total_size,
                        progress: 100,
                    },
                );
                let _ = app.emit(
                    "sftp-transfer-progress",
                    SftpTransferProgressEvent {
                        session_id: request.session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        direction: "upload".to_string(),
                        remote_path: request.remote_path.clone(),
                        local_path: request.local_path.clone().unwrap_or_default(),
                        transferred_bytes: transferred,
                        total_bytes: total_size,
                        progress: 100,
                    },
                );
            }
            remote_file.shutdown().await.map_err(|err| {
                SshBackendError::SftpOperation(format!("关闭远端文件失败：{err}"))
            })?;
            (transferred, total_size)
        };

        let _ = sftp.close().await;
        Ok(SftpTransferResponse {
            path: request.remote_path,
            bytes: transferred,
            total_bytes: total_bytes.max(transferred),
        })
    }

    async fn get_sender(&self, session_id: &str) -> SshResult<mpsc::Sender<SessionCommand>> {
        let entry = self.get_entry(session_id).await?;
        Ok(entry.command_tx)
    }

    async fn exec_command(
        &self,
        session_id: &str,
        command: &str,
        timeout_secs: u64,
    ) -> SshResult<(u32, String, String)> {
        let entry = self.get_entry(session_id).await?;
        let mut channel = {
            let guard = entry.handle.lock().await;
            guard
                .channel_open_session()
                .await
                .map_err(|err| map_russh_error(&err))?
        };

        channel
            .exec(true, command)
            .await
            .map_err(|err| map_russh_error(&err))?;

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut exit_status: Option<u32> = None;
        loop {
            let message = timeout(Duration::from_secs(timeout_secs), channel.wait())
                .await
                .map_err(|_| SshBackendError::Timeout)?;

            match message {
                Some(ChannelMsg::Data { data }) => {
                    stdout.push_str(String::from_utf8_lossy(&data).as_ref());
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    stderr.push_str(String::from_utf8_lossy(&data).as_ref());
                }
                Some(ChannelMsg::ExitStatus {
                    exit_status: status,
                }) => {
                    exit_status = Some(status);
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                    break;
                }
                Some(_) => {}
            }
        }

        let _ = channel.eof().await;
        let _ = channel.close().await;
        Ok((exit_status.unwrap_or(0), stdout, stderr))
    }

    async fn open_sftp_session(&self, session_id: &str) -> SshResult<SftpSession> {
        let entry = self.get_entry(session_id).await?;
        let channel = {
            let guard = entry.handle.lock().await;
            guard
                .channel_open_session()
                .await
                .map_err(|err| map_russh_error(&err))?
        };

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|err| map_russh_error(&err))?;

        SftpSession::new(channel.into_stream())
            .await
            .map_err(map_sftp_error)
    }

    async fn get_entry(&self, session_id: &str) -> SshResult<SessionEntry> {
        let sessions = self.sessions.read().await;
        sessions
            .get(session_id)
            .cloned()
            .ok_or(SshBackendError::SessionNotFound)
    }

    async fn session_exists(&self, session_id: &str) -> bool {
        let sessions = self.sessions.read().await;
        sessions.contains_key(session_id)
    }

    async fn remove_session(&self, session_id: &str) {
        let mut sessions = self.sessions.write().await;
        sessions.remove(session_id);
    }

    async fn force_close_entry(&self, session_id: String, entry: SessionEntry) {
        {
            let guard = entry.handle.lock().await;
            let _ = guard
                .disconnect(Disconnect::ByApplication, "session closed", "zh-CN")
                .await;
        }

        for tunnel_handle in entry.tunnel_handles.iter().rev() {
            let guard = tunnel_handle.lock().await;
            let _ = guard
                .disconnect(Disconnect::ByApplication, "session closed", "zh-CN")
                .await;
        }

        self.remove_session(&session_id).await;
    }

    async fn run_sys_status_monitor(
        &self,
        app: AppHandle,
        session_id: String,
        handle: Arc<Mutex<client::Handle<ClientHandler>>>,
        pulse_active: Arc<RwLock<bool>>,
        latency_probe_target: LatencyProbeTarget,
    ) {
        let mut previous: Option<ProcSnapshot> = None;
        let mut previous_at: Option<Instant> = None;
        let mut logged_non_linux_hint = false;

        loop {
            if !self.session_exists(&session_id).await {
                break;
            }

            let active = {
                let guard = pulse_active.read().await;
                *guard
            };
            let interval = if active {
                Duration::from_secs(6)
            } else {
                Duration::from_secs(24)
            };

            let (sample_result, icmp_latency, tcp_latency) = tokio::join!(
                sample_sys_status(handle.clone()),
                sample_local_icmp_rtt_ms(&latency_probe_target),
                sample_local_tcp_rtt_ms(&latency_probe_target),
            );
            if let Ok(sample) = sample_result {
                let now = Instant::now();
                let elapsed = previous_at
                    .map(|value| now.saturating_duration_since(value))
                    .unwrap_or_else(|| Duration::from_secs(0));
                let merged_latency =
                    merge_latency_samples(icmp_latency, tcp_latency, sample.latency_ms);

                let status =
                    build_sys_status(&sample.snapshot, previous.as_ref(), elapsed, merged_latency);
                previous = Some(sample.snapshot);
                previous_at = Some(now);
                let _ = app.emit(
                    "ssh-sys-status",
                    SshSysStatusEvent {
                        session_id: session_id.clone(),
                        status,
                    },
                );
            } else if !logged_non_linux_hint {
                logged_non_linux_hint = true;
                emit_diagnostic_log(
                    &app,
                    &session_id,
                    "warn",
                    "pulse",
                    "Pulse 监控未读取到 /proc 数据，远端可能不是 Linux。".to_string(),
                );
            }

            sleep(interval).await;
        }
    }
}

async fn sample_local_tcp_rtt_ms(target: &LatencyProbeTarget) -> Option<f64> {
    let host = target.host.trim();
    if host.is_empty() {
        return None;
    }
    let mut samples: Vec<f64> = Vec::with_capacity(3);
    for _ in 0..3 {
        let started_at = Instant::now();
        let connect_result = timeout(
            Duration::from_secs(2),
            TcpStream::connect((host, target.port)),
        )
        .await;
        if let Ok(Ok(stream)) = connect_result {
            drop(stream);
            let elapsed_ms = started_at.elapsed().as_secs_f64() * 1000.0;
            if elapsed_ms.is_finite() && elapsed_ms >= 0.0 {
                samples.push(elapsed_ms.min(120_000.0));
            }
        }
    }
    if samples.is_empty() {
        return None;
    }
    samples.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    Some(samples[samples.len() / 2])
}

async fn sample_local_icmp_rtt_ms(target: &LatencyProbeTarget) -> Option<f64> {
    let host = target.host.trim();
    if host.is_empty() {
        return None;
    }

    let mut command = Command::new("ping");
    #[cfg(target_os = "windows")]
    {
        // Prevent flashing cmd.exe windows while sampling RTT in background.
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        command.args(["-n", "2", "-w", "1200", host]);
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        command.args(["-n", "-c", "2", "-W", "1", host]);
    }

    let output = match timeout(Duration::from_secs(3), command.output()).await {
        Ok(Ok(value)) => value,
        _ => return None,
    };

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    parse_ping_time_ms(stdout.as_ref()).or_else(|| parse_ping_time_ms(stderr.as_ref()))
}

fn parse_ping_time_ms(raw: &str) -> Option<f64> {
    for line in raw.lines() {
        let lowered = line.to_lowercase();
        if lowered.contains("min/avg/max") {
            if let Some(value) = parse_unix_ping_avg_ms(line) {
                return Some(value);
            }
        }
    }
    for line in raw.lines() {
        if let Some(value) = parse_latency_token(line, "time=") {
            return Some(value);
        }
        if let Some(value) = parse_latency_token(line, "time<") {
            return Some(value.max(0.5));
        }
        if let Some(value) = parse_latency_token(line, "时间=") {
            return Some(value);
        }
        if let Some(value) = parse_latency_token(line, "時間=") {
            return Some(value);
        }
        if let Some(value) = parse_latency_token(line, "时间<") {
            return Some(value.max(0.5));
        }
        if let Some(value) = parse_latency_token(line, "時間<") {
            return Some(value.max(0.5));
        }
        if let Some(value) = parse_latency_token(line, "Average =") {
            return Some(value);
        }
        if let Some(value) = parse_latency_token(line, "平均 =") {
            return Some(value);
        }
    }
    None
}

fn parse_unix_ping_avg_ms(line: &str) -> Option<f64> {
    let right = line.split('=').nth(1)?.trim();
    let values = right.split_whitespace().next()?;
    let parts = values.split('/').collect::<Vec<&str>>();
    if parts.len() < 2 {
        return None;
    }
    let avg = parts[1].trim().parse::<f64>().ok()?;
    if avg.is_finite() && avg >= 0.0 {
        Some(avg.min(120_000.0))
    } else {
        None
    }
}

fn parse_latency_token(line: &str, marker: &str) -> Option<f64> {
    let idx = line.find(marker)?;
    let raw = line.get(idx + marker.len()..)?.trim();
    let mut numeric = String::new();
    for ch in raw.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            numeric.push(ch);
            continue;
        }
        if !numeric.is_empty() {
            break;
        }
    }
    if numeric.is_empty() {
        return None;
    }
    let parsed = numeric.parse::<f64>().ok()?;
    if parsed.is_finite() && parsed >= 0.0 {
        Some(parsed.min(120_000.0))
    } else {
        None
    }
}

fn shell_escape(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn parse_kv_line(raw: &str, key: &str) -> Option<String> {
    let prefix = format!("{key}=");
    for line in raw.lines() {
        if let Some(value) = line.strip_prefix(prefix.as_str()) {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn build_host_info_command() -> String {
    r#"sh -lc '
set -eu
HOSTNAME="$(hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown)"
KERNEL_NAME="$(uname -s 2>/dev/null || echo unknown)"
KERNEL_RELEASE="$(uname -r 2>/dev/null || echo unknown)"
KERNEL_VERSION="$(uname -v 2>/dev/null || echo unknown)"
ARCH="$(uname -m 2>/dev/null || echo unknown)"
OS_NAME=""
OS_VERSION=""
if [ -r /etc/os-release ]; then
  . /etc/os-release
  OS_NAME="${PRETTY_NAME:-${NAME:-unknown}}"
  OS_VERSION="${VERSION_ID:-${VERSION:-unknown}}"
fi
if [ -z "$OS_NAME" ]; then
  OS_NAME="$KERNEL_NAME"
fi
if [ -z "$OS_VERSION" ]; then
  OS_VERSION="$KERNEL_RELEASE"
fi
CPU_MODEL="$(awk -F: "/model name/{gsub(/^[ \t]+/,\"\",\$2); print \$2; exit}" /proc/cpuinfo 2>/dev/null || true)"
if [ -z "$CPU_MODEL" ]; then
  CPU_MODEL="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown)"
fi
CPU_CORES="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)"
MEM_TOTAL_KB="$(awk "/MemTotal:/{print \$2; exit}" /proc/meminfo 2>/dev/null || echo 0)"
MEM_AVAIL_KB="$(awk "/MemAvailable:/{print \$2; exit}" /proc/meminfo 2>/dev/null || echo 0)"
if [ "$MEM_AVAIL_KB" = "0" ]; then
  MEM_AVAIL_KB="$(awk "/MemFree:/{print \$2; exit}" /proc/meminfo 2>/dev/null || echo 0)"
fi
SWAP_TOTAL_KB="$(awk "/SwapTotal:/{print \$2; exit}" /proc/meminfo 2>/dev/null || echo 0)"
SWAP_FREE_KB="$(awk "/SwapFree:/{print \$2; exit}" /proc/meminfo 2>/dev/null || echo 0)"
echo "HOSTNAME=$HOSTNAME"
echo "OS_NAME=$OS_NAME"
echo "OS_VERSION=$OS_VERSION"
echo "KERNEL_NAME=$KERNEL_NAME"
echo "KERNEL_RELEASE=$KERNEL_RELEASE"
echo "KERNEL_VERSION=$KERNEL_VERSION"
echo "ARCH=$ARCH"
echo "CPU_MODEL=$CPU_MODEL"
echo "CPU_CORES=$CPU_CORES"
echo "MEM_TOTAL_BYTES=$((MEM_TOTAL_KB * 1024))"
echo "MEM_AVAIL_BYTES=$((MEM_AVAIL_KB * 1024))"
echo "SWAP_TOTAL_BYTES=$((SWAP_TOTAL_KB * 1024))"
echo "SWAP_FREE_BYTES=$((SWAP_FREE_KB * 1024))"
df -PT -k 2>/dev/null | awk "NR>1{printf \"DISK|%s|%s|%s|%s|%s|%s\\n\",\$7,\$2,\$3*1024,\$4*1024,\$5*1024,\$6}"
'"#
    .to_string()
}

fn parse_host_info_output(raw: &str) -> SshHostInfoResponse {
    let mut disks = Vec::new();
    for line in raw.lines() {
        if !line.starts_with("DISK|") {
            continue;
        }
        let parts = line.split('|').collect::<Vec<&str>>();
        if parts.len() < 7 {
            continue;
        }
        let total_bytes = parts[3].trim().parse::<u64>().unwrap_or(0);
        let used_bytes = parts[4].trim().parse::<u64>().unwrap_or(0);
        let available_bytes = parts[5].trim().parse::<u64>().unwrap_or(0);
        disks.push(SshHostDiskInfo {
            mount_point: parts[1].trim().to_string(),
            fs_type: parts[2].trim().to_string(),
            total_bytes,
            used_bytes,
            available_bytes,
            used_percent: parts[6].trim().to_string(),
        });
    }

    SshHostInfoResponse {
        hostname: parse_kv_line(raw, "HOSTNAME").unwrap_or_else(|| "unknown".to_string()),
        os_name: parse_kv_line(raw, "OS_NAME").unwrap_or_else(|| "unknown".to_string()),
        os_version: parse_kv_line(raw, "OS_VERSION").unwrap_or_else(|| "unknown".to_string()),
        kernel_name: parse_kv_line(raw, "KERNEL_NAME").unwrap_or_else(|| "unknown".to_string()),
        kernel_release: parse_kv_line(raw, "KERNEL_RELEASE")
            .unwrap_or_else(|| "unknown".to_string()),
        kernel_version: parse_kv_line(raw, "KERNEL_VERSION")
            .unwrap_or_else(|| "unknown".to_string()),
        architecture: parse_kv_line(raw, "ARCH").unwrap_or_else(|| "unknown".to_string()),
        cpu_model: parse_kv_line(raw, "CPU_MODEL").unwrap_or_else(|| "unknown".to_string()),
        cpu_cores: parse_kv_line(raw, "CPU_CORES")
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0),
        memory_total_bytes: parse_kv_line(raw, "MEM_TOTAL_BYTES")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        memory_available_bytes: parse_kv_line(raw, "MEM_AVAIL_BYTES")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        swap_total_bytes: parse_kv_line(raw, "SWAP_TOTAL_BYTES")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        swap_free_bytes: parse_kv_line(raw, "SWAP_FREE_BYTES")
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        disks,
    }
}

fn build_copy_path_command(from_path: &str, to_path: &str) -> String {
    format!(
        "sh -lc 'set -eu; SRC={}; DEST={}; if [ ! -e \"$SRC\" ]; then echo \"source not found\"; exit 66; fi; cp -a \"$SRC\" \"$DEST\"'",
        shell_escape(from_path.trim()),
        shell_escape(to_path.trim())
    )
}

fn build_compress_path_command(path: &str, archive_name: &str) -> String {
    let escaped_path = shell_escape(path.trim());
    let escaped_name = shell_escape(archive_name.trim());
    format!(
        "sh -lc 'set -eu; SRC={escaped_path}; NAME={escaped_name}; BASE=\"$(basename \"$SRC\")\"; DIR=\"$(dirname \"$SRC\")\"; if [ ! -e \"$SRC\" ]; then echo \"source not found\"; exit 66; fi; if [ -n \"$NAME\" ]; then case \"$NAME\" in /*) OUT=\"$NAME\" ;; *) OUT=\"$DIR/$NAME\" ;; esac; else TS=\"$(date +%Y%m%d%H%M%S)\"; OUT=\"$DIR/${{BASE}}.$TS.tar.gz\"; fi; tar -czf \"$OUT\" -C \"$DIR\" \"$BASE\"; echo \"PATH=$OUT\"'"
    )
}

fn build_extract_path_command(archive_path: &str, destination_dir: &str) -> String {
    let escaped_archive_path = shell_escape(archive_path.trim());
    let escaped_destination_dir = shell_escape(destination_dir.trim());
    format!(
        "sh -lc 'set -eu; SRC={escaped_archive_path}; DEST_IN={escaped_destination_dir}; if [ ! -f \"$SRC\" ]; then echo \"archive not found\"; exit 66; fi; if [ -n \"$DEST_IN\" ]; then DEST=\"$DEST_IN\"; else DEST=\"$(dirname \"$SRC\")\"; fi; mkdir -p \"$DEST\"; case \"$SRC\" in *.tar.gz|*.tgz) tar -xzf \"$SRC\" -C \"$DEST\" ;; *.tar) tar -xf \"$SRC\" -C \"$DEST\" ;; *.zip) unzip -o \"$SRC\" -d \"$DEST\" >/dev/null ;; *.gz) OUT_NAME=\"$(basename \"$SRC\" .gz)\"; gunzip -c \"$SRC\" > \"$DEST/$OUT_NAME\" ;; *) echo \"unsupported archive\"; exit 64 ;; esac; echo \"PATH=$DEST\"'"
    )
}

fn build_path_usage_command(path: &str) -> String {
    let script = r#"sh -lc 'set -eu; TARGET=__TARGET__; if [ ! -e "$TARGET" ]; then echo "target not found"; exit 66; fi; if [ -d "$TARGET" ]; then ROOT="$TARGET"; else ROOT="$(dirname "$TARGET")"; fi; USED="$(du -sb "$TARGET" 2>/dev/null | awk "NR==1{print \$1}")"; if [ -z "$USED" ]; then USED_KB="$(du -sk "$TARGET" 2>/dev/null | awk "NR==1{print \$1}")"; USED=$(( ${USED_KB:-0} * 1024 )); fi; DF="$(df -kP "$ROOT" 2>/dev/null | awk "NR==2{print \$2 \" \" \$3 \" \" \$4}")"; set -- $DF; TOTAL=$(( ${1:-0} * 1024 )); USED_DF=$(( ${2:-0} * 1024 )); AVAIL=$(( ${3:-0} * 1024 )); if [ "$TOTAL" -gt 0 ] && [ "$USED" -gt "$TOTAL" ]; then USED="$USED_DF"; fi; echo "PATH=$TARGET"; echo "USED=$USED"; echo "TOTAL=$TOTAL"; echo "AVAIL=$AVAIL"'"#;
    script.replace("__TARGET__", shell_escape(path.trim()).as_str())
}

fn build_password_auth_status_command() -> String {
    r#"sh -lc '
set -eu
if ! command -v uname >/dev/null 2>&1; then
  echo "__OT_UNSUPPORTED__:missing_uname"
  exit 64
fi
KERNEL="$(uname -s 2>/dev/null | tr "[:upper:]" "[:lower:]")"
case "$KERNEL" in
  linux*) ;;
  *)
    echo "__OT_UNSUPPORTED__:non_linux"
    exit 64
    ;;
esac
CFG="/etc/ssh/sshd_config"
if [ ! -r "$CFG" ]; then
  echo "__OT_UNSUPPORTED__:missing_sshd_config"
  exit 64
fi
VALUE=""
SOURCE="default"
if command -v sshd >/dev/null 2>&1; then
  VALUE="$(sshd -T 2>/dev/null | awk "/^passwordauthentication /{print tolower(\$2); exit}")"
  if [ -n "$VALUE" ]; then
    SOURCE="sshd -T"
  fi
fi
if [ -z "$VALUE" ]; then
  VALUE="$(awk "tolower(\$1)==\"passwordauthentication\"{v=tolower(\$2)} END{print v}" "$CFG")"
  if [ -n "$VALUE" ]; then
    SOURCE="sshd_config"
  fi
fi
if [ -z "$VALUE" ]; then
  VALUE="yes"
  SOURCE="default_yes"
fi
if [ "$VALUE" = "yes" ] || [ "$VALUE" = "true" ]; then
  echo "enabled=true"
else
  echo "enabled=false"
fi
echo "detail=来源: $SOURCE"
'"#
    .to_string()
}

fn build_set_password_auth_command(enabled: bool) -> String {
    let target = if enabled { "yes" } else { "no" };
    let template = r#"sh -lc '
set -eu
TARGET="__TARGET__"
if ! command -v uname >/dev/null 2>&1; then
  echo "__OT_UNSUPPORTED__:missing_uname"
  exit 64
fi
KERNEL="$(uname -s 2>/dev/null | tr "[:upper:]" "[:lower:]")"
case "$KERNEL" in
  linux*) ;;
  *)
    echo "__OT_UNSUPPORTED__:non_linux"
    exit 64
    ;;
esac
CFG="/etc/ssh/sshd_config"
if [ ! -f "$CFG" ]; then
  echo "__OT_UNSUPPORTED__:missing_sshd_config"
  exit 64
fi
APPLY_SCRIPT="$(cat <<'"'"'OT_SCRIPT'"'"'
set -eu
TARGET="$1"
CFG="/etc/ssh/sshd_config"
TMP="${CFG}.orbitterm.tmp"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BAK="${CFG}.orbitterm.bak.${TS}"
cp "$CFG" "$BAK"
awk -v target="$TARGET" '
  BEGIN { updated=0 }
  {
    if ($0 ~ /^[[:space:]]*#?[[:space:]]*PasswordAuthentication[[:space:]]+/ && updated == 0) {
      print "PasswordAuthentication " target
      updated=1
    } else {
      print
    }
  }
  END {
    if (updated == 0) {
      print "PasswordAuthentication " target
    }
  }
' "$CFG" > "$TMP"
chmod --reference="$CFG" "$TMP" 2>/dev/null || true
chown --reference="$CFG" "$TMP" 2>/dev/null || true
mv "$TMP" "$CFG"
if command -v sshd >/dev/null 2>&1; then
  if ! sshd -t -f "$CFG" >/dev/null 2>&1; then
    cp "$BAK" "$CFG"
    rm -f "$TMP"
    echo "__OT_FAILED__:invalid_sshd_config"
    exit 70
  fi
fi
RELOAD_OK=0
if command -v systemctl >/dev/null 2>&1; then
  if systemctl reload sshd >/dev/null 2>&1 || systemctl reload ssh >/dev/null 2>&1 || systemctl restart sshd >/dev/null 2>&1 || systemctl restart ssh >/dev/null 2>&1; then
    RELOAD_OK=1
  fi
fi
if [ "$RELOAD_OK" -eq 0 ] && command -v service >/dev/null 2>&1; then
  if service ssh reload >/dev/null 2>&1 || service sshd reload >/dev/null 2>&1 || service ssh restart >/dev/null 2>&1 || service sshd restart >/dev/null 2>&1; then
    RELOAD_OK=1
  fi
fi
if [ "$RELOAD_OK" -eq 0 ] && command -v pgrep >/dev/null 2>&1 && command -v pkill >/dev/null 2>&1; then
  if pgrep -x sshd >/dev/null 2>&1 && pkill -HUP -x sshd >/dev/null 2>&1; then
    RELOAD_OK=1
  fi
fi
if [ "$RELOAD_OK" -eq 0 ]; then
  cp "$BAK" "$CFG"
  echo "__OT_FAILED__:reload_sshd_failed"
  exit 71
fi
if [ "$TARGET" = "yes" ]; then
  echo "enabled=true"
  echo "detail=已开启密码登录"
else
  echo "enabled=false"
  echo "detail=已关闭密码登录"
fi
echo "backup=$BAK"
OT_SCRIPT
)"
if [ "$(id -u)" -eq 0 ]; then
  sh -c "$APPLY_SCRIPT" _ "$TARGET"
  exit 0
fi
if command -v sudo >/dev/null 2>&1; then
  if sudo -n sh -c "$APPLY_SCRIPT" _ "$TARGET"; then
    exit 0
  fi
  echo "__OT_PERMISSION__:need_root_or_passwordless_sudo"
  exit 65
fi
echo "__OT_PERMISSION__:need_root_or_passwordless_sudo"
exit 65
'"#;
    template.replace("__TARGET__", target)
}

fn parse_password_auth_status_output(
    stdout: &str,
    backup_override: Option<String>,
    default_detail: &str,
) -> SshPasswordAuthStatusResponse {
    let mut enabled = true;
    let mut detail = default_detail.to_string();
    let mut backup_path = backup_override;

    for line in stdout.lines() {
        if let Some(value) = line.strip_prefix("enabled=") {
            enabled = value.trim().eq_ignore_ascii_case("true");
            continue;
        }
        if let Some(value) = line.strip_prefix("detail=") {
            let next = value.trim();
            if !next.is_empty() {
                detail = next.to_string();
            }
            continue;
        }
        if let Some(value) = line.strip_prefix("backup=") {
            let next = value.trim();
            if !next.is_empty() {
                backup_path = Some(next.to_string());
            }
            continue;
        }
    }

    SshPasswordAuthStatusResponse {
        supported: true,
        enabled,
        detail,
        backup_path,
    }
}

#[derive(Debug, Clone)]
struct ProcCpuTotals {
    total: u64,
    idle: u64,
}

#[derive(Debug, Clone)]
struct ProcSnapshot {
    cpu: ProcCpuTotals,
    memory_usage_percent: f64,
    net_rx_total: u64,
    net_tx_total: u64,
}

#[derive(Debug, Clone)]
struct SampledSysStatus {
    snapshot: ProcSnapshot,
    latency_ms: f64,
}

const SYS_STATUS_COMMAND: &str =
    "sh -lc \"cat /proc/stat | head -n 1; grep -E '^MemTotal:|^MemAvailable:' /proc/meminfo; cat /proc/net/dev\"";

async fn sample_sys_status(
    handle: Arc<Mutex<client::Handle<ClientHandler>>>,
) -> SshResult<SampledSysStatus> {
    let mut channel = {
        let guard = handle.lock().await;
        guard
            .channel_open_session()
            .await
            .map_err(|err| map_russh_error(&err))?
    };

    let probe_started_at = Instant::now();
    channel
        .exec(true, SYS_STATUS_COMMAND)
        .await
        .map_err(|err| map_russh_error(&err))?;
    let mut first_response_at: Option<Instant> = None;
    let mut raw = String::new();
    loop {
        let message = timeout(Duration::from_secs(4), channel.wait())
            .await
            .map_err(|_| SshBackendError::Timeout)?;
        match message {
            Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                if first_response_at.is_none() {
                    first_response_at = Some(Instant::now());
                }
                raw.push_str(String::from_utf8_lossy(&data).as_ref());
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                if first_response_at.is_none() {
                    first_response_at = Some(Instant::now());
                }
                break;
            }
            Some(_) => {}
        }
    }

    let _ = channel.eof().await;
    let _ = channel.close().await;

    let snapshot = parse_proc_snapshot(raw.as_str())?;
    let latency_ms = first_response_at
        .unwrap_or_else(Instant::now)
        .saturating_duration_since(probe_started_at)
        .as_secs_f64()
        * 1000.0;
    Ok(SampledSysStatus {
        snapshot,
        latency_ms,
    })
}

fn merge_latency_samples(
    icmp_latency: Option<f64>,
    tcp_latency: Option<f64>,
    ssh_exec_latency: f64,
) -> Option<f64> {
    let normalize = |value: f64| -> Option<f64> {
        if value.is_finite() && value >= 0.0 {
            Some(value.min(120_000.0))
        } else {
            None
        }
    };
    if let Some(value) = icmp_latency.and_then(normalize) {
        if value <= 2.0 {
            if let Some(tcp_value) = tcp_latency.and_then(normalize) {
                if tcp_value >= 8.0 {
                    return Some(tcp_value);
                }
            }
        }
        // Prefer local ICMP RTT to keep displayed latency aligned with user-local ping semantics.
        return Some(value);
    }
    // Fallback to local TCP connect RTT.
    if let Some(value) = tcp_latency.and_then(normalize) {
        return Some(value);
    }
    // Final fallback uses SSH command response latency.
    if let Some(value) = normalize(ssh_exec_latency) {
        return Some(value);
    }
    None
}

fn parse_cwd_output(raw: &str) -> Option<String> {
    let normalized = raw.replace('\r', "\n");
    for line in normalized.lines().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('/') || (trimmed.len() > 2 && trimmed.as_bytes()[1] == b':') {
            return Some(trimmed.to_string());
        }
    }
    None
}

fn parse_proc_snapshot(raw: &str) -> SshResult<ProcSnapshot> {
    let mut cpu_line: Option<&str> = None;
    let mut mem_total_kb: Option<u64> = None;
    let mut mem_available_kb: Option<u64> = None;
    let mut net_rx_total: u64 = 0;
    let mut net_tx_total: u64 = 0;
    let mut saw_non_loopback = false;
    let mut fallback_rx_total: u64 = 0;
    let mut fallback_tx_total: u64 = 0;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("cpu ") {
            cpu_line = Some(trimmed);
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("MemTotal:") {
            mem_total_kb = parse_kb_value(rest);
            continue;
        }

        if let Some(rest) = trimmed.strip_prefix("MemAvailable:") {
            mem_available_kb = parse_kb_value(rest);
            continue;
        }

        if let Some((iface_raw, stats_raw)) = trimmed.split_once(':') {
            let iface = iface_raw.trim();
            let fields = stats_raw
                .split_whitespace()
                .filter_map(|value| value.parse::<u64>().ok())
                .collect::<Vec<u64>>();
            if fields.len() < 9 {
                continue;
            }
            let rx = fields[0];
            let tx = fields[8];
            fallback_rx_total = fallback_rx_total.saturating_add(rx);
            fallback_tx_total = fallback_tx_total.saturating_add(tx);
            if iface != "lo" {
                saw_non_loopback = true;
                net_rx_total = net_rx_total.saturating_add(rx);
                net_tx_total = net_tx_total.saturating_add(tx);
            }
        }
    }

    if !saw_non_loopback {
        net_rx_total = fallback_rx_total;
        net_tx_total = fallback_tx_total;
    }

    let cpu = parse_cpu_line(
        cpu_line
            .ok_or_else(|| SshBackendError::SftpOperation("无法解析 /proc/stat".to_string()))?,
    )?;

    let total_kb = mem_total_kb
        .ok_or_else(|| SshBackendError::SftpOperation("无法解析 /proc/meminfo".to_string()))?;
    let available_kb = mem_available_kb
        .ok_or_else(|| SshBackendError::SftpOperation("无法解析 /proc/meminfo".to_string()))?;
    if total_kb == 0 {
        return Err(SshBackendError::SftpOperation(
            "远端内存信息无效".to_string(),
        ));
    }
    let used_kb = total_kb.saturating_sub(available_kb);
    let memory_usage_percent = (used_kb as f64 / total_kb as f64) * 100.0;

    Ok(ProcSnapshot {
        cpu,
        memory_usage_percent,
        net_rx_total,
        net_tx_total,
    })
}

fn parse_kb_value(raw: &str) -> Option<u64> {
    raw.split_whitespace().next()?.parse::<u64>().ok()
}

fn parse_cpu_line(line: &str) -> SshResult<ProcCpuTotals> {
    let fields = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .collect::<Vec<u64>>();
    if fields.len() < 4 {
        return Err(SshBackendError::SftpOperation(
            "远端 CPU 指标无效".to_string(),
        ));
    }

    let total = fields.iter().copied().fold(0_u64, u64::saturating_add);
    let idle = fields[3].saturating_add(*fields.get(4).unwrap_or(&0));
    Ok(ProcCpuTotals { total, idle })
}

fn build_sys_status(
    current: &ProcSnapshot,
    previous: Option<&ProcSnapshot>,
    elapsed: Duration,
    latency_ms: Option<f64>,
) -> SysStatus {
    let cpu_usage_percent = if let Some(prev) = previous {
        let total_delta = current.cpu.total.saturating_sub(prev.cpu.total);
        let idle_delta = current.cpu.idle.saturating_sub(prev.cpu.idle);
        if total_delta == 0 {
            0.0
        } else {
            ((total_delta.saturating_sub(idle_delta)) as f64 / total_delta as f64) * 100.0
        }
    } else {
        0.0
    };

    let elapsed_secs = elapsed.as_secs_f64();
    let (net_rx_bytes_per_sec, net_tx_bytes_per_sec) = if let Some(prev) = previous {
        if elapsed_secs <= 0.0 {
            (0.0, 0.0)
        } else {
            (
                current.net_rx_total.saturating_sub(prev.net_rx_total) as f64 / elapsed_secs,
                current.net_tx_total.saturating_sub(prev.net_tx_total) as f64 / elapsed_secs,
            )
        }
    } else {
        (0.0, 0.0)
    };

    SysStatus {
        cpu_usage_percent: cpu_usage_percent.clamp(0.0, 100.0),
        memory_usage_percent: current.memory_usage_percent.clamp(0.0, 100.0),
        net_rx_bytes_per_sec: net_rx_bytes_per_sec.max(0.0),
        net_tx_bytes_per_sec: net_tx_bytes_per_sec.max(0.0),
        latency_ms: latency_ms.and_then(|value| {
            if value.is_finite() && value >= 0.0 {
                Some(value.min(120_000.0))
            } else {
                None
            }
        }),
        sampled_at: now_unix_ts(),
        interval_secs: elapsed.as_secs(),
    }
}

fn validate_connect_request(request: &SshConnectRequest) -> SshResult<()> {
    if request.host_config.basic_info.address.trim().is_empty()
        || request.identity_config.username.trim().is_empty()
    {
        return Err(SshBackendError::InvalidInput);
    }

    if request.host_config.identity_id.trim().is_empty()
        || request.identity_config.id.trim().is_empty()
        || request.host_config.identity_id != request.identity_config.id
    {
        return Err(SshBackendError::InvalidInput);
    }

    for hop in &request.proxy_chain {
        if hop.host_config.basic_info.address.trim().is_empty()
            || hop.identity_config.username.trim().is_empty()
            || hop.host_config.identity_id.trim().is_empty()
            || hop.identity_config.id.trim().is_empty()
            || hop.host_config.identity_id != hop.identity_config.id
        {
            return Err(SshBackendError::InvalidInput);
        }
    }

    if !is_identity_auth_valid(&request.identity_config) {
        return Err(SshBackendError::InvalidInput);
    }
    for hop in &request.proxy_chain {
        if !is_identity_auth_valid(&hop.identity_config) {
            return Err(SshBackendError::InvalidInput);
        }
    }

    Ok(())
}

fn is_identity_auth_valid(identity: &crate::models::IdentityConfig) -> bool {
    match identity.auth_config.method {
        AuthMethod::Password => {
            identity
                .auth_config
                .password
                .as_deref()
                .unwrap_or_default()
                .trim()
                .len()
                > 0
        }
        AuthMethod::PrivateKey => {
            identity
                .auth_config
                .private_key
                .as_deref()
                .unwrap_or_default()
                .trim()
                .len()
                > 0
        }
    }
}

async fn establish_connection_chain(
    request: &SshConnectRequest,
    config: Arc<client::Config>,
    timeout_secs: u64,
    app: &AppHandle,
    session_id: &str,
) -> SshResult<(
    Arc<Mutex<client::Handle<ClientHandler>>>,
    Vec<Arc<Mutex<client::Handle<ClientHandler>>>>,
)> {
    let mut all_targets = request.proxy_chain.clone();
    all_targets.push(crate::models::ProxyJumpHop {
        host_config: request.host_config.clone(),
        identity_config: request.identity_config.clone(),
    });

    let mut tunnel_handles: Vec<Arc<Mutex<client::Handle<ClientHandler>>>> = Vec::new();
    let mut previous_handle_ref: Option<Arc<Mutex<client::Handle<ClientHandler>>>> = None;
    let total_targets = all_targets.len();

    for (idx, target) in all_targets.into_iter().enumerate() {
        let hop_label = format!(
            "第 {}/{} 跳 {}:{}",
            idx + 1,
            total_targets,
            target.host_config.basic_info.address,
            target.host_config.basic_info.port
        );
        emit_diagnostic_log(
            app,
            session_id,
            "info",
            "connect",
            format!("开始连接 {hop_label}"),
        );

        let mut next_handle = if let Some(parent) = previous_handle_ref.as_ref() {
            match connect_via_parent(
                parent.clone(),
                config.clone(),
                target.host_config.basic_info.address.as_str(),
                target.host_config.basic_info.port,
                timeout_secs,
            )
            .await
            {
                Ok(handle) => handle,
                Err(err) => {
                    emit_diagnostic_log(
                        app,
                        session_id,
                        "error",
                        "connect",
                        format!("{hop_label} 连接失败: {}", err.user_message()),
                    );
                    return Err(err);
                }
            }
        } else {
            match connect_direct(
                config.clone(),
                target.host_config.basic_info.address.as_str(),
                target.host_config.basic_info.port,
                timeout_secs,
            )
            .await
            {
                Ok(handle) => handle,
                Err(err) => {
                    emit_diagnostic_log(
                        app,
                        session_id,
                        "error",
                        "connect",
                        format!("{hop_label} 连接失败: {}", err.user_message()),
                    );
                    return Err(err);
                }
            }
        };

        emit_diagnostic_log(
            app,
            session_id,
            "info",
            "connect",
            format!("{hop_label} TCP 通道已建立"),
        );
        authenticate_identity(
            &mut next_handle,
            &target.identity_config,
            timeout_secs,
            app,
            session_id,
            &hop_label,
        )
        .await?;
        let next_ref = Arc::new(Mutex::new(next_handle));

        if idx + 1 < total_targets {
            tunnel_handles.push(next_ref.clone());
        }
        previous_handle_ref = Some(next_ref);
    }

    let final_handle = previous_handle_ref.ok_or(SshBackendError::InvalidInput)?;
    Ok((final_handle, tunnel_handles))
}

async fn connect_direct(
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    timeout_secs: u64,
) -> SshResult<client::Handle<ClientHandler>> {
    let address = format!("{host}:{port}");
    timeout(
        Duration::from_secs(timeout_secs),
        client::connect(config, address, ClientHandler),
    )
    .await
    .map_err(|_| SshBackendError::Timeout)
    .and_then(|result| result.map_err(|err| map_russh_error(&err)))
}

async fn connect_via_parent(
    parent: Arc<Mutex<client::Handle<ClientHandler>>>,
    config: Arc<client::Config>,
    host: &str,
    port: u16,
    timeout_secs: u64,
) -> SshResult<client::Handle<ClientHandler>> {
    let direct_channel = {
        let guard = parent.lock().await;
        timeout(
            Duration::from_secs(timeout_secs),
            guard.channel_open_direct_tcpip(
                host.to_string(),
                u32::from(port),
                "127.0.0.1".to_string(),
                0,
            ),
        )
        .await
        .map_err(|_| SshBackendError::Timeout)
        .and_then(|result| result.map_err(|err| map_russh_error(&err)))?
    };

    let stream = direct_channel.into_stream();
    timeout(
        Duration::from_secs(timeout_secs),
        client::connect_stream(config, stream, ClientHandler),
    )
    .await
    .map_err(|_| SshBackendError::Timeout)
    .and_then(|result| result.map_err(|err| map_russh_error(&err)))
}

async fn authenticate_identity(
    handle: &mut client::Handle<ClientHandler>,
    identity: &crate::models::IdentityConfig,
    timeout_secs: u64,
    app: &AppHandle,
    session_id: &str,
    hop_label: &str,
) -> SshResult<()> {
    let timeout_duration = Duration::from_secs(timeout_secs);
    let auth_method = auth_method_label(&identity.auth_config.method);
    emit_diagnostic_log(
        app,
        session_id,
        "info",
        "auth",
        format!(
            "{hop_label} 开始认证: username={}, method={auth_method}",
            identity.username
        ),
    );

    let auth_result = match identity.auth_config.method {
        AuthMethod::Password => {
            let password = identity
                .auth_config
                .password
                .clone()
                .ok_or(SshBackendError::InvalidInput)?;
            let result = timeout(
                timeout_duration,
                handle.authenticate_password(identity.username.clone(), password),
            )
            .await
            .map_err(|_| SshBackendError::Timeout)
            .and_then(|result| result.map_err(|err| map_russh_error(&err)));

            match result {
                Ok(value) => value,
                Err(err) => {
                    emit_diagnostic_log(
                        app,
                        session_id,
                        "error",
                        "auth",
                        format!("{hop_label} 认证请求失败: {}", err.user_message()),
                    );
                    return Err(err);
                }
            }
        }
        AuthMethod::PrivateKey => {
            let key_text = identity
                .auth_config
                .private_key
                .as_deref()
                .ok_or(SshBackendError::InvalidInput)?;

            let private_key = decode_openssh(
                key_text.as_bytes(),
                identity.auth_config.passphrase.as_deref(),
            )
            .map_err(|_| SshBackendError::AuthFailure)?;

            let key = PrivateKeyWithHashAlg::new(Arc::new(private_key), None);

            let result = timeout(
                timeout_duration,
                handle.authenticate_publickey(identity.username.clone(), key),
            )
            .await
            .map_err(|_| SshBackendError::Timeout)
            .and_then(|result| result.map_err(|err| map_russh_error(&err)));

            match result {
                Ok(value) => value,
                Err(err) => {
                    emit_diagnostic_log(
                        app,
                        session_id,
                        "error",
                        "auth",
                        format!("{hop_label} 认证请求失败: {}", err.user_message()),
                    );
                    return Err(err);
                }
            }
        }
    };

    if !auth_result.success() {
        emit_diagnostic_log(
            app,
            session_id,
            "warn",
            "auth",
            format!("{hop_label} 认证失败（服务器拒绝）。"),
        );
        return Err(SshBackendError::AuthFailure);
    }

    emit_diagnostic_log(
        app,
        session_id,
        "info",
        "auth",
        format!("{hop_label} 认证成功。"),
    );
    Ok(())
}

fn map_sftp_error(err: SftpError) -> SshBackendError {
    match err {
        SftpError::Status(status) => match status.status_code {
            StatusCode::NoSuchFile => SshBackendError::SftpNotFound,
            StatusCode::PermissionDenied => SshBackendError::SftpPermissionDenied,
            StatusCode::OpUnsupported => SshBackendError::SftpUnsupported,
            StatusCode::Failure if status.error_message.to_lowercase().contains("exist") => {
                SshBackendError::SftpAlreadyExists
            }
            _ => SshBackendError::SftpOperation(status.error_message),
        },
        SftpError::Timeout => SshBackendError::Timeout,
        SftpError::IO(detail) => SshBackendError::SftpOperation(detail),
        SftpError::Limited(detail) => SshBackendError::SftpOperation(detail),
        SftpError::UnexpectedPacket => {
            SshBackendError::SftpOperation("SFTP 返回了异常数据包".to_string())
        }
        SftpError::UnexpectedBehavior(detail) => SshBackendError::SftpOperation(detail),
    }
}

fn file_type_label(file_type: FileType) -> &'static str {
    match file_type {
        FileType::Dir => "dir",
        FileType::File => "file",
        FileType::Symlink => "symlink",
        FileType::Other => "other",
    }
}

fn join_remote_path(base: &str, name: &str) -> String {
    if base == "/" {
        return format!("/{name}");
    }
    if base.ends_with('/') {
        return format!("{base}{name}");
    }
    format!("{base}/{name}")
}

async fn remove_remote_path_recursive(sftp: &SftpSession, path: String) -> SshResult<()> {
    let metadata = sftp
        .symlink_metadata(path.clone())
        .await
        .map_err(map_sftp_error)?;
    if !metadata.file_type().is_dir() {
        sftp.remove_file(path).await.map_err(map_sftp_error)?;
        return Ok(());
    }

    let mut dir_stack = vec![path.clone()];
    let mut dirs_for_delete = vec![path];
    let mut files_for_delete: Vec<String> = Vec::new();

    while let Some(current_dir) = dir_stack.pop() {
        let read_dir = sftp
            .read_dir(current_dir.clone())
            .await
            .map_err(map_sftp_error)?;

        for entry in read_dir {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_path = join_remote_path(&current_dir, &name);
            let child_type = entry.file_type();
            if child_type.is_dir() {
                dirs_for_delete.push(child_path.clone());
                dir_stack.push(child_path);
            } else {
                files_for_delete.push(child_path);
            }
        }
    }

    for file in files_for_delete {
        sftp.remove_file(file).await.map_err(map_sftp_error)?;
    }

    dirs_for_delete.sort_by(|left, right| right.len().cmp(&left.len()));
    for dir in dirs_for_delete {
        sftp.remove_dir(dir).await.map_err(map_sftp_error)?;
    }

    Ok(())
}

fn format_algorithm_list<T: core::fmt::Debug>(items: &[T], max_count: usize) -> String {
    let mut list = Vec::new();
    for item in items.iter().take(max_count) {
        list.push(format!("{item:?}"));
    }
    if items.len() > max_count {
        list.push("...".to_string());
    }
    if list.is_empty() {
        return "unknown".to_string();
    }
    list.join(", ")
}

fn auth_method_label(method: &AuthMethod) -> &'static str {
    match method {
        AuthMethod::Password => "password",
        AuthMethod::PrivateKey => "private_key",
    }
}

fn emit_diagnostic_log(
    app: &AppHandle,
    session_id: &str,
    level: &str,
    stage: &str,
    message: String,
) {
    let payload = SshDiagnosticLogEvent {
        session_id: session_id.to_string(),
        level: level.to_string(),
        stage: stage.to_string(),
        message,
        timestamp: now_unix_ts(),
    };

    let _ = app.emit("ssh-diagnostic", payload);
}

fn now_unix_ts() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_secs() as i64,
        Err(_) => 0,
    }
}

fn emit_error(app: &AppHandle, session_id: Option<String>, err: SshBackendError) {
    let payload = SshErrorEvent {
        session_id,
        code: err.code().to_string(),
        message: err.user_message(),
    };

    let _ = app.emit("ssh-error", payload);
}

pub fn pty_backend_name() -> &'static str {
    #[cfg(windows)]
    {
        // portable-pty 在 Windows 下默认使用 ConPTY 后端。
        return "ConPTY";
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        return "SystemPTY";
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        "NativePTY"
    }
}
