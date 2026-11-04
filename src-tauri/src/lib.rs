mod support;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::{Duration, UNIX_EPOCH},
};

use futures_util::future::{AbortHandle, AbortRegistration, Abortable};
use serde::{Deserialize, Serialize};
use support::{claude_args, git_branch as read_git_branch, is_local_host, push_utf8, valid_secret_name, Guard};
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const KEYCHAIN_SERVICE: &str = "dev.pino.ide";
const MAX_OPEN_BYTES: u64 = 8 * 1024 * 1024;
const MAX_HTTP_BODY: usize = 4 * 1024 * 1024;

pub struct AppState {
    guard: Mutex<Guard>,
    jobs: Mutex<HashMap<String, AbortHandle>>,
    client: reqwest::Client,
    login_path: Mutex<Option<String>>,
}

type Res<T> = Result<T, String>;

fn check(state: &State<'_, AppState>, path: &str) -> Res<PathBuf> {
    state.guard.lock().map_err(|_| "Internal state error".to_string())?.check(path)
}

fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ───────────────────────── Workspace and files ─────────────────────────

#[tauri::command]
fn set_workspace(state: State<'_, AppState>, path: String) -> Res<String> {
    let canon = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !canon.is_dir() {
        return Err("That is not a folder".into());
    }
    let mut g = state.guard.lock().map_err(|_| "Internal state error".to_string())?;
    g.roots = vec![canon.clone()];
    Ok(canon.to_string_lossy().into_owned())
}

#[tauri::command]
fn allow_file(state: State<'_, AppState>, path: String) -> Res<String> {
    let canon = Path::new(&path).canonicalize().map_err(|e| e.to_string())?;
    if !canon.is_file() {
        return Err("That is not a file".into());
    }
    let mut g = state.guard.lock().map_err(|_| "Internal state error".to_string())?;
    g.files.insert(canon.clone());
    Ok(canon.to_string_lossy().into_owned())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    is_symlink: bool,
}

#[tauri::command]
fn list_dir(state: State<'_, AppState>, path: String) -> Res<Vec<DirEntry>> {
    let dir = check(&state, &path)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".DS_Store" {
            continue;
        }
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let is_symlink = ft.is_symlink();
        let is_dir = if is_symlink {
            std::fs::metadata(entry.path()).map(|m| m.is_dir()).unwrap_or(false)
        } else {
            ft.is_dir()
        };
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            is_symlink,
        });
    }
    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadResult {
    content: String,
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn read_text_file(state: State<'_, AppState>, path: String) -> Res<ReadResult> {
    let p = check(&state, &path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Not a file".into());
    }
    if meta.len() > MAX_OPEN_BYTES {
        return Err("TOO_LARGE".into());
    }
    let bytes = std::fs::read(&p).map_err(|e| e.to_string())?;
    if bytes[..bytes.len().min(8192)].contains(&0) {
        return Err("BINARY".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "NOT_UTF8".to_string())?;
    Ok(ReadResult { content, mtime_ms: mtime_ms(&meta), size: meta.len() })
}

#[tauri::command]
fn write_text_file(state: State<'_, AppState>, path: String, content: String) -> Res<u64> {
    let p = check(&state, &path)?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&p, content).map_err(|e| e.to_string())?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}

#[tauri::command]
fn file_mtime(state: State<'_, AppState>, path: String) -> Res<u64> {
    let p = check(&state, &path)?;
    let meta = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    Ok(mtime_ms(&meta))
}

#[tauri::command]
fn create_entry(state: State<'_, AppState>, path: String, is_dir: bool) -> Res<()> {
    let p = check(&state, &path)?;
    if p.exists() {
        return Err("Something with that name already exists".into());
    }
    if is_dir {
        std::fs::create_dir_all(&p).map_err(|e| e.to_string())
    } else {
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&p)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_entry(state: State<'_, AppState>, from: String, to: String) -> Res<()> {
    let a = check(&state, &from)?;
    let b = check(&state, &to)?;
    if b.exists() {
        return Err("Something with that name already exists".into());
    }
    std::fs::rename(a, b).map_err(|e| e.to_string())
}

/// Moves to the Trash instead of deleting permanently.
#[tauri::command]
fn delete_entry(state: State<'_, AppState>, path: String) -> Res<()> {
    let p = check(&state, &path)?;
    if state.guard.lock().map_err(|_| "Internal state error".to_string())?.is_root(&p) {
        return Err("The open folder itself can't be deleted here".into());
    }
    trash::delete(&p).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_finder(state: State<'_, AppState>, path: String) -> Res<()> {
    let p = check(&state, &path)?;
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_files(state: State<'_, AppState>, root: String, limit: usize) -> Res<Vec<String>> {
    let r = check(&state, &root)?;
    Ok(support::list_files(&r, limit.clamp(1, 50_000)))
}

#[tauri::command]
fn git_branch(state: State<'_, AppState>, root: String) -> Res<Option<String>> {
    let r = check(&state, &root)?;
    Ok(read_git_branch(&r))
}

#[tauri::command]
fn open_external(url: String) -> Res<()> {
    let parsed = reqwest::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("Only http and https links can be opened".into());
    }
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(parsed.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("cmd").args(["/C", "start", "", parsed.as_str()]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let r = std::process::Command::new("xdg-open").arg(parsed.as_str()).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

// ───────────────────────── Keychain secrets ─────────────────────────

fn keychain_entry(name: &str) -> Res<keyring::Entry> {
    if !valid_secret_name(name) {
        return Err("Invalid secret name".into());
    }
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

fn read_secret(name: &str) -> Res<String> {
    keychain_entry(name)?.get_password().map_err(|e| match e {
        keyring::Error::NoEntry => "No API key saved for this provider".to_string(),
        other => other.to_string(),
    })
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Res<()> {
    if value.trim().is_empty() {
        return Err("The key is empty".into());
    }
    keychain_entry(&name)?.set_password(value.trim()).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_has(name: String) -> Res<bool> {
    match keychain_entry(&name)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_delete(name: String) -> Res<()> {
    match keychain_entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ───────────────────────── Settings file ─────────────────────────

fn settings_path(app: &AppHandle) -> Res<PathBuf> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn settings_read(app: AppHandle) -> Res<String> {
    let p = settings_path(&app)?;
    Ok(std::fs::read_to_string(p).unwrap_or_else(|_| "{}".to_string()))
}

#[tauri::command]
fn settings_write(app: AppHandle, json: String) -> Res<()> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| format!("Invalid settings: {e}"))?;
    let p = settings_path(&app)?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, p).map_err(|e| e.to_string())
}

// ───────────────────────── HTTP (all model traffic goes through here) ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Auth {
    secret: String,
    header: String,
    prefix: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HttpReq {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
    auth: Option<Auth>,
    timeout_secs: Option<u64>,
}

#[derive(Serialize)]
struct HttpResp {
    status: u16,
    body: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum StreamEvent {
    Status(u16),
    Chunk(String),
    Line(String),
    Stderr(String),
    Exit(Option<i32>),
    Done,
    Error(String),
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_connect() {
        "Could not connect. Is the server running and the address correct?".into()
    } else if e.is_timeout() {
        "The request timed out".into()
    } else {
        e.to_string()
    }
}

fn build_request(client: &reqwest::Client, req: &HttpReq) -> Res<reqwest::RequestBuilder> {
    let url = reqwest::Url::parse(&req.url).map_err(|e| format!("Invalid URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only http and https addresses are allowed".into());
    }
    let host = url.host_str().ok_or("The address has no host")?.to_string();
    if req.auth.is_some() && url.scheme() == "http" && !is_local_host(&host) {
        return Err("Refusing to send an API key over plain http to a non-local host. Use https.".into());
    }
    let method = reqwest::Method::from_bytes(req.method.to_ascii_uppercase().as_bytes())
        .map_err(|_| "Invalid HTTP method".to_string())?;
    let mut b = client.request(method, url);
    for (k, v) in &req.headers {
        b = b.header(k.as_str(), v.as_str());
    }
    if let Some(a) = &req.auth {
        let secret = read_secret(&a.secret)?;
        let value = format!("{}{}", a.prefix.clone().unwrap_or_default(), secret);
        let name = reqwest::header::HeaderName::from_bytes(a.header.as_bytes())
            .map_err(|_| "Invalid auth header name".to_string())?;
        let mut hv = reqwest::header::HeaderValue::from_str(&value).map_err(|_| "The saved key has invalid characters".to_string())?;
        hv.set_sensitive(true);
        b = b.header(name, hv);
    }
    if let Some(body) = &req.body {
        b = b.body(body.clone());
    }
    Ok(b)
}

#[tauri::command]
async fn http_request(state: State<'_, AppState>, req: HttpReq) -> Res<HttpResp> {
    let b = build_request(&state.client, &req)?;
    let b = b.timeout(Duration::from_secs(req.timeout_secs.unwrap_or(15).clamp(1, 120)));
    let mut resp = b.send().await.map_err(net_err)?;
    let status = resp.status().as_u16();
    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_HTTP_BODY {
            return Err("The response was too large".into());
        }
    }
    Ok(HttpResp { status, body: String::from_utf8_lossy(&body).into_owned() })
}

fn register_job(state: &AppState, id: &str) -> AbortRegistration {
    let (handle, reg) = AbortHandle::new_pair();
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.insert(id.to_string(), handle);
    }
    reg
}

fn finish_job(state: &AppState, id: &str) {
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(id);
    }
}

async fn run_stream(client: reqwest::Client, req: HttpReq, ch: Channel<StreamEvent>) {
    let builder = match build_request(&client, &req) {
        Ok(b) => b,
        Err(e) => {
            let _ = ch.send(StreamEvent::Error(e));
            return;
        }
    };
    let mut resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = ch.send(StreamEvent::Error(net_err(e)));
            return;
        }
    };
    let status = resp.status().as_u16();
    let _ = ch.send(StreamEvent::Status(status));
    if !(200..300).contains(&status) {
        let mut body: Vec<u8> = Vec::new();
        while let Ok(Some(c)) = resp.chunk().await {
            body.extend_from_slice(&c);
            if body.len() > 32 * 1024 {
                break;
            }
        }
        let _ = ch.send(StreamEvent::Error(format!("HTTP {status}: {}", String::from_utf8_lossy(&body))));
        return;
    }
    let mut carry: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(c)) => {
                let s = push_utf8(&mut carry, &c);
                if !s.is_empty() && ch.send(StreamEvent::Chunk(s)).is_err() {
                    return;
                }
            }
            Ok(None) => break,
            Err(e) => {
                let _ = ch.send(StreamEvent::Error(net_err(e)));
                return;
            }
        }
    }
    let _ = ch.send(StreamEvent::Done);
}

#[tauri::command]
async fn http_stream(state: State<'_, AppState>, req: HttpReq, id: String, on_event: Channel<StreamEvent>) -> Res<()> {
    let reg = register_job(&state, &id);
    let fut = Abortable::new(run_stream(state.client.clone(), req, on_event.clone()), reg);
    let res = fut.await;
    finish_job(&state, &id);
    if res.is_err() {
        // Cancelled by the user.
        let _ = on_event.send(StreamEvent::Done);
    }
    Ok(())
}

#[tauri::command]
fn job_cancel(state: State<'_, AppState>, id: String) {
    let handle = state.jobs.lock().ok().and_then(|mut j| j.remove(&id));
    if let Some(h) = handle {
        h.abort();
    }
}

// ───────────────────────── Claude Code CLI ─────────────────────────

/// GUI apps start with a minimal PATH, so ask the user's login shell for the real one.
async fn resolve_login_path(state: &AppState) -> String {
    if let Some(p) = state.login_path.lock().ok().and_then(|g| g.clone()) {
        return p;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = tokio::process::Command::new(shell);
    cmd.args(["-ilc", "printf '__PINO_PATH__%s__PINO_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut found: Option<String> = None;
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(5), cmd.output()).await {
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        if let (Some(a), Some(b)) = (text.find("__PINO_PATH__"), text.rfind("__PINO_PATH__")) {
            if b > a {
                found = Some(text[a + 13..b].to_string());
            }
        }
    }
    let path = found.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    if let Ok(mut g) = state.login_path.lock() {
        *g = Some(path.clone());
    }
    path
}

fn find_claude(path_env: &str) -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(path_env).collect();
    for extra in [
        format!("{home}/.claude/local"),
        format!("{home}/.local/bin"),
        format!("{home}/.npm-global/bin"),
        format!("{home}/.bun/bin"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
    ] {
        dirs.push(PathBuf::from(extra));
    }
    for d in dirs {
        let candidate = d.join("claude");
        if let Ok(meta) = std::fs::metadata(&candidate) {
            if !meta.is_file() {
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o111 == 0 {
                    continue;
                }
            }
            return Some(candidate);
        }
    }
    None
}

#[tauri::command]
async fn claude_cli_path(state: State<'_, AppState>) -> Res<Option<String>> {
    let path_env = resolve_login_path(&state).await;
    Ok(find_claude(&path_env).map(|p| p.to_string_lossy().into_owned()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliReq {
    prompt: String,
    cwd: String,
    model: Option<String>,
    session_id: Option<String>,
    permission_mode: Option<String>,
    system_prompt: Option<String>,
}

async fn run_cli(exe: PathBuf, args: Vec<String>, cwd: PathBuf, prompt: String, path_env: String, ch: Channel<StreamEvent>) {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.args(args)
        .current_dir(cwd)
        .env("PATH", path_env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = ch.send(StreamEvent::Error(format!("Could not start Claude Code: {e}")));
            return;
        }
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        let _ = stdin.shutdown().await;
    }
    let stderr = child.stderr.take();
    let err_task = tokio::spawn(async move {
        let mut tail: Vec<String> = Vec::new();
        if let Some(se) = stderr {
            let mut lines = BufReader::new(se).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                tail.push(l);
                if tail.len() > 20 {
                    tail.remove(0);
                }
            }
        }
        tail.join("\n")
    });
    if let Some(out) = child.stdout.take() {
        let mut lines = BufReader::new(out).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if ch.send(StreamEvent::Line(line)).is_err() {
                return;
            }
        }
    }
    let status = child.wait().await;
    let err = err_task.await.unwrap_or_default();
    if !err.trim().is_empty() {
        let _ = ch.send(StreamEvent::Stderr(err));
    }
    let _ = ch.send(StreamEvent::Exit(status.ok().and_then(|s| s.code())));
}

#[tauri::command]
async fn claude_cli_run(state: State<'_, AppState>, req: CliReq, id: String, on_event: Channel<StreamEvent>) -> Res<()> {
    let cwd = check(&state, &req.cwd)?;
    let args = claude_args(
        req.model.as_deref(),
        req.session_id.as_deref(),
        req.permission_mode.as_deref(),
        req.system_prompt.as_deref(),
    )?;
    let path_env = resolve_login_path(&state).await;
    let exe = find_claude(&path_env)
        .ok_or_else(|| "Claude Code was not found. Install it, run `claude` once in Terminal to sign in, then try again.".to_string())?;
    let reg = register_job(&state, &id);
    let fut = Abortable::new(run_cli(exe, args, cwd, req.prompt, path_env, on_event.clone()), reg);
    let res = fut.await;
    finish_job(&state, &id);
    if res.is_err() {
        let _ = on_event.send(StreamEvent::Done);
    }
    Ok(())
}

// ───────────────────────── App entry ─────────────────────────

pub fn run() {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PinoIDE/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("failed to build the HTTP client");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            guard: Mutex::new(Guard::default()),
            jobs: Mutex::new(HashMap::new()),
            client,
            login_path: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            set_workspace,
            allow_file,
            list_dir,
            read_text_file,
            write_text_file,
            file_mtime,
            create_entry,
            rename_entry,
            delete_entry,
            reveal_in_finder,
            list_files,
            git_branch,
            open_external,
            secret_set,
            secret_has,
            secret_delete,
            settings_read,
            settings_write,
            http_request,
            http_stream,
            job_cancel,
            claude_cli_path,
            claude_cli_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Pino IDE");
}
