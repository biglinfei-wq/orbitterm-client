mod ai;
mod diagnostics;
#[allow(dead_code)]
mod e2ee;
mod error;
mod key_manager;
mod models;
mod ssh;
mod vault;

#[cfg(any(target_os = "android", target_os = "ios"))]
use std::collections::HashMap;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::fs;
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::path::PathBuf;

use error::SshBackendError;
use models::{
    AiExplainSshErrorRequest, AiExplainSshErrorResponse, AiTranslateRequest, AiTranslateResponse,
    CloudUnlockBindRequest, CloudUnlockUnlockRequest, HealthCheckResponse, SaveVaultRequest,
    SaveVaultResponse, SftpActionResponse, SftpCompressRequest, SftpCopyRequest,
    SftpDownloadRequest, SftpExtractRequest, SftpLsRequest, SftpLsResponse, SftpMkdirRequest,
    SftpPathUsageRequest, SftpPathUsageResponse, SftpReadTextRequest, SftpReadTextResponse,
    SftpRenameRequest, SftpRmRequest, SftpTransferResponse, SftpUploadRequest, SshConnectRequest,
    SshConnectedResponse, SshDeployPublicKeyRequest, SshDerivePublicKeyRequest,
    SshDerivePublicKeyResponse, SshDisconnectRequest, SshExportPrivateKeyRequest,
    SshExportPrivateKeyResponse, SshGenerateKeypairRequest, SshGenerateKeypairResponse,
    SshHostInfoRequest, SshHostInfoResponse, SshPasswordAuthStatusRequest,
    SshPasswordAuthStatusResponse, SshPulseActivityRequest, SshQueryCwdRequest,
    SshQueryCwdResponse, SshResizeRequest, SshSetPasswordAuthRequest, SshWriteRequest,
    UnlockAndLoadRequest, UnlockAndLoadResponse, VaultSyncExportResponse, VaultSyncImportRequest,
};
use ssh::SshSessionRegistry;
use serde::Serialize;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::menu::{Menu, MenuItem};
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::{AppHandle, State};
use vault::VaultSessionState;
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri_plugin_biometric::{AuthOptions, BiometricExt, BiometryType};
#[cfg(any(target_os = "android", target_os = "ios"))]
use tauri_plugin_keychain::{KeychainExt, KeychainRequest};

#[tauri::command]
async fn ssh_connect(
    app: AppHandle,
    registry: State<'_, SshSessionRegistry>,
    request: SshConnectRequest,
) -> Result<SshConnectedResponse, String> {
    registry
        .connect(app, request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_write(
    registry: State<'_, SshSessionRegistry>,
    request: SshWriteRequest,
) -> Result<(), String> {
    registry
        .write_input(&request.session_id, request.data)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_resize(
    registry: State<'_, SshSessionRegistry>,
    request: SshResizeRequest,
) -> Result<(), String> {
    registry
        .resize(&request.session_id, request.cols, request.rows)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_disconnect(
    registry: State<'_, SshSessionRegistry>,
    request: SshDisconnectRequest,
) -> Result<(), String> {
    registry
        .disconnect(&request.session_id)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_set_pulse_activity(
    registry: State<'_, SshSessionRegistry>,
    request: SshPulseActivityRequest,
) -> Result<(), String> {
    registry
        .set_pulse_activity(&request.session_id, request.active)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
fn ssh_generate_keypair(
    request: SshGenerateKeypairRequest,
) -> Result<SshGenerateKeypairResponse, String> {
    key_manager::generate_ssh_keypair(request).map_err(|err| err.user_message())
}

#[tauri::command]
fn ssh_derive_public_key(
    request: SshDerivePublicKeyRequest,
) -> Result<SshDerivePublicKeyResponse, String> {
    key_manager::derive_public_key(request).map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_deploy_public_key(
    registry: State<'_, SshSessionRegistry>,
    request: SshDeployPublicKeyRequest,
) -> Result<(), String> {
    registry
        .deploy_public_key(&request.session_id, request.public_key)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_password_auth_status(
    registry: State<'_, SshSessionRegistry>,
    request: SshPasswordAuthStatusRequest,
) -> Result<SshPasswordAuthStatusResponse, String> {
    registry
        .query_password_auth_status(&request.session_id)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_set_password_auth(
    registry: State<'_, SshSessionRegistry>,
    request: SshSetPasswordAuthRequest,
) -> Result<SshPasswordAuthStatusResponse, String> {
    registry
        .set_password_auth_enabled(&request.session_id, request.enabled)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_query_cwd(
    registry: State<'_, SshSessionRegistry>,
    request: SshQueryCwdRequest,
) -> Result<SshQueryCwdResponse, String> {
    registry
        .query_cwd(&request.session_id)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_query_host_info(
    registry: State<'_, SshSessionRegistry>,
    request: SshHostInfoRequest,
) -> Result<SshHostInfoResponse, String> {
    registry
        .query_host_info(&request.session_id)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ssh_export_private_key(
    request: SshExportPrivateKeyRequest,
) -> Result<SshExportPrivateKeyResponse, String> {
    key_manager::export_private_key(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ai_translate_command(request: AiTranslateRequest) -> Result<AiTranslateResponse, String> {
    ai::translate_command(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn ai_explain_ssh_error(
    request: AiExplainSshErrorRequest,
) -> Result<AiExplainSshErrorResponse, String> {
    ai::explain_ssh_error(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_ls(
    registry: State<'_, SshSessionRegistry>,
    request: SftpLsRequest,
) -> Result<SftpLsResponse, String> {
    registry
        .sftp_ls(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_mkdir(
    registry: State<'_, SshSessionRegistry>,
    request: SftpMkdirRequest,
) -> Result<(), String> {
    registry
        .sftp_mkdir(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_rm(
    registry: State<'_, SshSessionRegistry>,
    request: SftpRmRequest,
) -> Result<(), String> {
    registry
        .sftp_rm(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_rename(
    registry: State<'_, SshSessionRegistry>,
    request: SftpRenameRequest,
) -> Result<(), String> {
    registry
        .sftp_rename(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_copy(
    registry: State<'_, SshSessionRegistry>,
    request: SftpCopyRequest,
) -> Result<(), String> {
    registry
        .sftp_copy(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_compress(
    registry: State<'_, SshSessionRegistry>,
    request: SftpCompressRequest,
) -> Result<SftpActionResponse, String> {
    registry
        .sftp_compress(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_extract(
    registry: State<'_, SshSessionRegistry>,
    request: SftpExtractRequest,
) -> Result<SftpActionResponse, String> {
    registry
        .sftp_extract(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_path_usage(
    registry: State<'_, SshSessionRegistry>,
    request: SftpPathUsageRequest,
) -> Result<SftpPathUsageResponse, String> {
    registry
        .sftp_path_usage(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_upload(
    app: AppHandle,
    registry: State<'_, SshSessionRegistry>,
    request: SftpUploadRequest,
) -> Result<SftpTransferResponse, String> {
    registry
        .sftp_upload(app, request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_download(
    app: AppHandle,
    registry: State<'_, SshSessionRegistry>,
    request: SftpDownloadRequest,
) -> Result<SftpTransferResponse, String> {
    registry
        .sftp_download(app, request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn sftp_read_text(
    registry: State<'_, SshSessionRegistry>,
    request: SftpReadTextRequest,
) -> Result<SftpReadTextResponse, String> {
    registry
        .sftp_read_text(request)
        .await
        .map_err(|err| err.user_message())
}

#[tauri::command]
async fn unlock_and_load(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    request: UnlockAndLoadRequest,
) -> Result<UnlockAndLoadResponse, String> {
    vault::unlock_and_load(app, state, request).await
}

#[tauri::command]
async fn vault_bind_cloud_unlock(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    request: CloudUnlockBindRequest,
) -> Result<(), String> {
    vault::bind_cloud_unlock(app, state, request).await
}

#[tauri::command]
async fn vault_unlock_with_cloud(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    request: CloudUnlockUnlockRequest,
) -> Result<UnlockAndLoadResponse, String> {
    vault::unlock_with_cloud(app, state, request).await
}

#[tauri::command]
async fn save_vault(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    request: SaveVaultRequest,
) -> Result<SaveVaultResponse, String> {
    vault::save_vault(app, state, request).await
}

#[tauri::command]
async fn vault_export_sync_blob(app: AppHandle) -> Result<VaultSyncExportResponse, String> {
    vault::export_sync_blob(app).await
}

#[tauri::command]
async fn vault_import_sync_blob(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    request: VaultSyncImportRequest,
) -> Result<UnlockAndLoadResponse, String> {
    vault::import_sync_blob(app, state, request).await
}

#[tauri::command]
async fn vault_clear_session(state: State<'_, VaultSessionState>) -> Result<(), String> {
    vault::clear_vault_session(state).await
}

#[tauri::command]
async fn vault_unlock_with_biometric() -> Result<(), String> {
    Err("当前构建未启用生物识别插件，请先使用金库密码或账号密码解锁。".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MobileBiometricStatusResponse {
    is_available: bool,
    biometry_type: String,
    error: Option<String>,
    error_code: Option<String>,
}

#[cfg(any(target_os = "android", target_os = "ios"))]
const MOBILE_SECURE_STORE_FALLBACK_FILE: &str = "mobile-secure-store-fallback.json";

#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_secure_store_fallback_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "无法定位应用数据目录".to_string())?;
    fs::create_dir_all(&dir).map_err(|err| format!("创建应用数据目录失败: {}", err))?;
    Ok(dir.join(MOBILE_SECURE_STORE_FALLBACK_FILE))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn read_mobile_secure_store_fallback_map(path: &PathBuf) -> HashMap<String, String> {
    let bytes = match fs::read(path) {
        Ok(content) => content,
        Err(_) => return HashMap::new(),
    };
    serde_json::from_slice::<HashMap<String, String>>(&bytes).unwrap_or_default()
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn write_mobile_secure_store_fallback_map(
    path: &PathBuf,
    map: &HashMap<String, String>,
) -> Result<(), String> {
    let bytes =
        serde_json::to_vec(map).map_err(|err| format!("写入生物识别回退存储序列化失败: {}", err))?;
    fs::write(path, bytes).map_err(|err| format!("写入生物识别回退存储失败: {}", err))?;
    Ok(())
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_secure_store_fallback_set(
    app: &AppHandle,
    key: String,
    value: String,
) -> Result<(), String> {
    let path = mobile_secure_store_fallback_path(app)?;
    let mut map = read_mobile_secure_store_fallback_map(&path);
    map.insert(key, value);
    write_mobile_secure_store_fallback_map(&path, &map)
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_secure_store_fallback_get(
    app: &AppHandle,
    key: String,
) -> Result<Option<String>, String> {
    let path = mobile_secure_store_fallback_path(app)?;
    let map = read_mobile_secure_store_fallback_map(&path);
    Ok(map
        .get(&key)
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        }))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn mobile_secure_store_fallback_remove(app: &AppHandle, key: String) -> Result<(), String> {
    let path = mobile_secure_store_fallback_path(app)?;
    let mut map = read_mobile_secure_store_fallback_map(&path);
    map.remove(&key);
    write_mobile_secure_store_fallback_map(&path, &map)
}

#[tauri::command]
fn mobile_biometric_status(app: AppHandle) -> Result<MobileBiometricStatusResponse, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let status = app
            .biometric()
            .status()
            .map_err(|err| format!("读取生物识别状态失败: {}", err))?;
        let biometry = match status.biometry_type {
            BiometryType::None => "none",
            BiometryType::TouchID => "touchid",
            BiometryType::FaceID => "faceid",
        };
        return Ok(MobileBiometricStatusResponse {
            is_available: status.is_available,
            biometry_type: biometry.to_string(),
            error: status.error,
            error_code: status.error_code,
        });
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        Ok(MobileBiometricStatusResponse {
            is_available: false,
            biometry_type: "none".to_string(),
            error: Some("当前平台不支持生物识别".to_string()),
            error_code: None,
        })
    }
}

#[tauri::command]
fn mobile_biometric_authenticate(app: AppHandle, reason: String) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let options = AuthOptions {
            allow_device_credential: true,
            cancel_title: Some("取消".to_string()),
            ..Default::default()
        };
        app.biometric()
            .authenticate(reason, options)
            .map_err(|err| format!("生物识别验证失败: {}", err))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let _ = reason;
        Err("当前平台不支持生物识别验证".to_string())
    }
}

#[tauri::command]
fn mobile_secure_store_set(app: AppHandle, key: String, value: String) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        if let Err(err) = app.save_item()
            .save_item(KeychainRequest {
                key: Some(key.clone()),
                password: Some(value.clone()),
            })
        {
            mobile_secure_store_fallback_set(&app, key, value).map_err(|fallback_err| {
                format!("安全存储写入失败: {}; 回退写入失败: {}", err, fallback_err)
            })?;
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let _ = key;
        let _ = value;
        Err("当前平台不支持安全存储".to_string())
    }
}

#[tauri::command]
async fn mobile_secure_store_set_from_vault_session(
    app: AppHandle,
    state: State<'_, VaultSessionState>,
    key: String,
) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let master_password = {
            let guard = state.master_password.read().await;
            let current = guard
                .as_ref()
                .ok_or("金库尚未解锁，无法绑定生物识别。".to_string())?;
            current.to_string()
        };
        if let Err(err) = app.save_item()
            .save_item(KeychainRequest {
                key: Some(key.clone()),
                password: Some(master_password.clone()),
            })
        {
            mobile_secure_store_fallback_set(&app, key, master_password).map_err(|fallback_err| {
                format!("绑定生物识别凭据失败: {}; 回退写入失败: {}", err, fallback_err)
            })?;
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let _ = state;
        let _ = key;
        Err("当前平台不支持安全存储".to_string())
    }
}

#[tauri::command]
fn mobile_secure_store_get(app: AppHandle, key: String) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        if let Ok(response) = app
            .get_item()
            .get_item(KeychainRequest {
                key: Some(key.clone()),
                password: None,
            })
        {
            if let Some(value) = response.password {
                let trimmed = value.trim().to_string();
                if !trimmed.is_empty() {
                    return Ok(Some(trimmed));
                }
            }
        }
        return mobile_secure_store_fallback_get(&app, key);
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let _ = key;
        Ok(None)
    }
}

#[tauri::command]
fn mobile_secure_store_remove(app: AppHandle, key: String) -> Result<(), String> {
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let keychain_result = app.remove_item()
            .remove_item(KeychainRequest {
                key: Some(key.clone()),
                password: None,
            });
        let fallback_result = mobile_secure_store_fallback_remove(&app, key);
        if let Err(err) = keychain_result {
            if let Err(fallback_err) = fallback_result {
                return Err(format!(
                    "安全存储删除失败: {}; 回退删除失败: {}",
                    err, fallback_err
                ));
            }
            return Ok(());
        }
        if let Err(fallback_err) = fallback_result {
            return Err(format!("回退安全存储删除失败: {}", fallback_err));
        }
        return Ok(());
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let _ = app;
        let _ = key;
        Ok(())
    }
}

#[tauri::command]
async fn run_health_check(app: AppHandle) -> Result<HealthCheckResponse, String> {
    Ok(diagnostics::run_health_check(&app).await)
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(SshSessionRegistry::default())
        .manage(VaultSessionState::default())
        .invoke_handler(tauri::generate_handler![
            ssh_connect,
            ssh_write,
            ssh_resize,
            ssh_disconnect,
            ssh_set_pulse_activity,
            ssh_generate_keypair,
            ssh_derive_public_key,
            ssh_deploy_public_key,
            ssh_password_auth_status,
            ssh_set_password_auth,
            ssh_query_cwd,
            ssh_query_host_info,
            ssh_export_private_key,
            ai_translate_command,
            ai_explain_ssh_error,
            sftp_ls,
            sftp_mkdir,
            sftp_rm,
            sftp_rename,
            sftp_copy,
            sftp_compress,
            sftp_extract,
            sftp_path_usage,
            sftp_upload,
            sftp_download,
            sftp_read_text,
            unlock_and_load,
            vault_bind_cloud_unlock,
            vault_unlock_with_cloud,
            save_vault,
            vault_export_sync_blob,
            vault_import_sync_blob,
            vault_clear_session,
            vault_unlock_with_biometric,
            mobile_biometric_status,
            mobile_biometric_authenticate,
            mobile_secure_store_set,
            mobile_secure_store_set_from_vault_session,
            mobile_secure_store_get,
            mobile_secure_store_remove,
            run_health_check,
            app_version
        ]);

    #[cfg(any(target_os = "android", target_os = "ios"))]
    let app = app
        .plugin(tauri_plugin_biometric::init())
        .plugin(tauri_plugin_keychain::init());

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let app = app
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let show_main_window_item = MenuItem::with_id(
                app,
                "show_main_window",
                "显示主窗口",
                true,
                None::<&str>,
            )?;
            let quit_app_item =
                MenuItem::with_id(app, "quit_app", "退出 OrbitTerm", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&show_main_window_item, &quit_app_item])?;

            TrayIconBuilder::new()
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show_main_window" => {
                        show_main_window(app);
                    }
                    "quit_app" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        });

    if let Err(err) = app.run(tauri::generate_context!()) {
        let message = SshBackendError::Protocol(err.to_string()).user_message();
        eprintln!("{message}");
    }
}
