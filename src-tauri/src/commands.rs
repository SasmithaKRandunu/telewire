//! The `#[tauri::command]` surface — the contract in Plan.md §9, kept
//! one-to-one with `src/lib/ipc.ts`.
//!
//! Every command returns `Result<T, String>`: Tauri rejects the JS promise with
//! that string, and `ipc.ts` turns it into a displayable `IpcError`. Errors are
//! formatted with `{:#}` so anyhow's context chain survives ("could not create
//! D:\...: access denied" rather than bare "access denied").
//!
//! Nothing here ever returns a session key, an api_hash, or a 2FA password.

use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::model::{
    AuthState, ChannelInfo, GrabLinkResult, Job, MediaFilter, MediaPage, Settings, EV_AUTH,
};
use crate::store;
use crate::telegram::{channel, download::Engine, Telegram};

pub struct AppState {
    pub tg: Arc<Telegram>,
    pub engine: Arc<Engine>,
}

/// `anyhow::Error` → a message the UI can show.
fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

/// Push auth transitions to the UI as well as returning them, so a state change
/// triggered from the backend (a revoked session, say) reaches the window even
/// when nothing called a command.
async fn broadcast(app: &AppHandle, state: &AuthState) {
    let _ = app.emit(EV_AUTH, state);
}

/// Point the download queue at the account that just became ready. The queue is
/// scoped per Telegram account, so this both loads that account's snapshot and
/// drops anything belonging to a previous one.
async fn sync_queue_account(state: &AppState, next: &AuthState) {
    if let AuthState::Ready { user } = next {
        state.engine.bind_account(user.id).await;
    }
}

/* ------------------------------------------------------------------ auth */

#[tauri::command]
pub async fn get_auth_state(state: State<'_, AppState>) -> Result<AuthState, String> {
    let next = state.tg.state().await;
    sync_queue_account(&state, &next).await;
    Ok(next)
}

#[tauri::command]
pub async fn save_credentials(
    app: AppHandle,
    state: State<'_, AppState>,
    api_id: i32,
    api_hash: String,
) -> Result<AuthState, String> {
    let next = state
        .tg
        .save_credentials(api_id, api_hash.trim())
        .await
        .map_err(err)?;
    broadcast(&app, &next).await;
    Ok(next)
}

#[tauri::command]
pub async fn login_start(
    state: State<'_, AppState>,
    phone: String,
) -> Result<AuthState, String> {
    state.tg.start_login(phone.trim()).await.map_err(err)
}

#[tauri::command]
pub async fn login_submit_code(
    app: AppHandle,
    state: State<'_, AppState>,
    code: String,
) -> Result<AuthState, String> {
    let next = state.tg.submit_code(code.trim()).await.map_err(err)?;
    sync_queue_account(&state, &next).await;
    broadcast(&app, &next).await;
    Ok(next)
}

#[tauri::command]
pub async fn login_submit_password(
    app: AppHandle,
    state: State<'_, AppState>,
    password: String,
) -> Result<AuthState, String> {
    // Not trimmed: leading/trailing spaces are legitimate password characters.
    let next = state.tg.submit_password(&password).await.map_err(err)?;
    sync_queue_account(&state, &next).await;
    broadcast(&app, &next).await;
    Ok(next)
}

#[tauri::command]
pub async fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<AuthState, String> {
    let next = state.tg.logout().await.map_err(err)?;
    // Stop and forget the queue in memory; this account's snapshot stays on
    // disk for when it signs back in.
    state.engine.unbind_account().await;
    broadcast(&app, &next).await;
    Ok(next)
}

/* -------------------------------------------------------------- channels */

#[tauri::command]
pub async fn list_dialogs(state: State<'_, AppState>) -> Result<Vec<ChannelInfo>, String> {
    let client = state.tg.client().await.map_err(err)?;
    channel::list_dialogs(&state.tg, &client).await.map_err(err)
}

#[tauri::command]
pub async fn resolve_channel(
    state: State<'_, AppState>,
    query: String,
) -> Result<ChannelInfo, String> {
    let client = state.tg.client().await.map_err(err)?;
    channel::resolve(&state.tg, &client, &query).await.map_err(err)
}

#[tauri::command]
pub async fn grab_telegram_link(
    state: State<'_, AppState>,
    link: String,
) -> Result<GrabLinkResult, String> {
    let client = state.tg.client().await.map_err(err)?;
    channel::grab_link(&state.tg, &client, &link).await.map_err(err)
}

/// Lazily-fetched chat avatar, cached in the client so the rail can request one
/// per visible row without refetching on every scroll.
#[tauri::command]
pub async fn get_chat_photo(
    state: State<'_, AppState>,
    channel_id: i64,
) -> Result<Option<String>, String> {
    if let Some(cached) = state.tg.cached_photo(channel_id).await {
        return Ok(cached);
    }
    let client = state.tg.client().await.map_err(err)?;
    // A chat with no avatar caches as `None` so it is asked for exactly once.
    let photo = channel::photo_for(&client, channel_id, &state.tg)
        .await
        .unwrap_or(None);
    state.tg.cache_photo(channel_id, photo.clone()).await;
    Ok(photo)
}

#[tauri::command]
pub async fn list_media(
    state: State<'_, AppState>,
    channel_id: i64,
    offset_id: i32,
    limit: usize,
    filter: MediaFilter,
) -> Result<MediaPage, String> {
    let client = state.tg.client().await.map_err(err)?;
    let peer = state
        .tg
        .peer(channel_id)
        .await
        .ok_or_else(|| "That channel is no longer open. Select it again.".to_string())?;
    channel::list_media(&client, peer, offset_id, limit, filter)
        .await
        .map_err(err)
}

/* ------------------------------------------------------------- downloads */

#[tauri::command]
pub async fn enqueue_download(
    state: State<'_, AppState>,
    channel_id: i64,
    message_ids: Vec<i32>,
    start_now: Option<bool>,
) -> Result<Vec<Job>, String> {
    // The engine needs a channel name for the folder layout; it is cheaper to
    // look it up here than to thread it through the UI payload.
    let title = state
        .tg
        .channel_title(channel_id)
        .await
        .unwrap_or_else(|| "Telegram".to_string());
    state
        .engine
        .enqueue(channel_id, title, message_ids, start_now.unwrap_or(true))
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn pause_download(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.engine.pause(&job_id).await.map_err(err)
}

#[tauri::command]
pub async fn resume_download(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.engine.resume(&job_id).await.map_err(err)
}

#[tauri::command]
pub async fn pause_all_downloads(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.pause_all().await.map_err(err)
}

#[tauri::command]
pub async fn resume_all_downloads(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.resume_all().await.map_err(err)
}

#[tauri::command]
pub async fn cancel_download(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.engine.cancel(&job_id).await.map_err(err)
}

#[tauri::command]
pub async fn retry_download(state: State<'_, AppState>, job_id: String) -> Result<(), String> {
    state.engine.retry(&job_id).await.map_err(err)
}

#[tauri::command]
pub async fn reorder_downloads(
    state: State<'_, AppState>,
    new_order: Vec<String>,
) -> Result<Vec<Job>, String> {
    state.engine.reorder_jobs(new_order).await.map_err(err)
}

#[tauri::command]
pub async fn move_download(
    state: State<'_, AppState>,
    job_id: String,
    direction: String,
) -> Result<Vec<Job>, String> {
    state.engine.move_job(&job_id, &direction).await.map_err(err)
}

#[tauri::command]
pub async fn list_jobs(state: State<'_, AppState>) -> Result<Vec<Job>, String> {
    // Belt and braces: if a window ever queries before `get_auth_state`
    // resolved, the queue still gets bound to the right account.
    let auth = state.tg.state().await;
    sync_queue_account(&state, &auth).await;
    Ok(state.engine.list().await)
}

#[tauri::command]
pub async fn clear_finished(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.clear_finished().await.map_err(err)
}

#[tauri::command]
pub async fn clear_all_downloads(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.clear_all().await.map_err(err)
}

/* ---------------------------------------------------------------- system */

#[tauri::command]
pub async fn get_settings() -> Result<Settings, String> {
    Ok(store::load_settings())
}

#[tauri::command]
pub async fn set_settings(settings: Settings) -> Result<Settings, String> {
    store::save_settings(&settings).map_err(err)
}

#[tauri::command]
pub async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    // The dialog plugin is callback-based; bridge it onto the async command.
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx
        .await
        .map_err(|_| "The folder picker closed unexpectedly.".to_string())?;
    Ok(picked.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn reveal_in_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().reveal_item_in_dir(&path).map_err(err)
}

#[tauri::command]
pub async fn open_download_folder(app: AppHandle, path: String) -> Result<(), String> {
    app.opener().open_path(&path, None::<&str>).map_err(err)
}

#[tauri::command]
pub async fn shutdown_computer(delay_seconds: Option<u64>) -> Result<(), String> {
    let delay = delay_seconds.unwrap_or(60).to_string();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("shutdown")
            .args(["/s", "/t", &delay, "/c", "TeleWire: Downloads completed. Shutting down."])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("shutdown")
            .args(["-h", &format!("+{}", delay_seconds.unwrap_or(1))])
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_shutdown() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("shutdown")
            .arg("/a")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sleep_computer() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("rundll32.exe")
            .args(["powrprof.dll,SetSuspendState", "0,1,0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn hibernate_computer() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        std::process::Command::new("shutdown")
            .arg("/h")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(err)?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("systemctl")
            .arg("hibernate")
            .spawn()
            .map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn exit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    // Only ever called with the my.telegram.org link from the login screen.
    // Refusing anything non-https keeps a compromised frontend from turning
    // this into a launcher for arbitrary local programs.
    if !url.starts_with("https://") {
        return Err("Refusing to open a non-HTTPS link.".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(err)
}
