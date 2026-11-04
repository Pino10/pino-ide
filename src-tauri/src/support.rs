//! Pure helpers with no Tauri dependency, so they can be unit tested anywhere.

use std::{
    collections::HashSet,
    ffi::OsString,
    fs, io,
    net::IpAddr,
    path::{Component, Path, PathBuf},
};

/// Folders skipped by quick-open indexing (the explorer still shows them).
pub const IGNORED_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".gradle",
    "vendor",
    "Pods",
    ".cache",
];

/// Append `bytes` to `carry` and return the longest valid UTF-8 prefix,
/// keeping any incomplete trailing character for the next chunk.
pub fn push_utf8(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    match std::str::from_utf8(carry) {
        Ok(s) => {
            let out = s.to_string();
            carry.clear();
            out
        }
        Err(e) => {
            let valid = e.valid_up_to();
            if e.error_len().is_none() {
                // Incomplete character at the end: wait for more bytes.
                let out = String::from_utf8_lossy(&carry[..valid]).into_owned();
                carry.drain(..valid);
                out
            } else {
                let out = String::from_utf8_lossy(carry).into_owned();
                carry.clear();
                out
            }
        }
    }
}

/// True for loopback, private-range and `.local` hosts. API keys are only ever
/// sent over plain http to hosts for which this returns true.
pub fn is_local_host(host: &str) -> bool {
    let h = host.trim_matches(|c| c == '[' || c == ']').to_ascii_lowercase();
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V4(v4)) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        Ok(IpAddr::V6(v6)) => v6.is_loopback() || (v6.segments()[0] & 0xfe00) == 0xfc00,
        Err(_) => false,
    }
}

pub fn valid_secret_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'_')
}

fn has_parent_component(p: &Path) -> bool {
    p.components().any(|c| matches!(c, Component::ParentDir))
}

/// Canonicalize a path whose last components may not exist yet.
pub fn canonicalize_lenient(path: &Path) -> io::Result<PathBuf> {
    if has_parent_component(path) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "Path may not contain '..'"));
    }
    if path.exists() {
        return path.canonicalize();
    }
    let mut tail: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        if cur.exists() {
            let mut base = cur.canonicalize()?;
            for part in tail.iter().rev() {
                base.push(part);
            }
            return Ok(base);
        }
        match (cur.file_name().map(|s| s.to_os_string()), cur.parent().map(|p| p.to_path_buf())) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cur = parent;
            }
            _ => return Err(io::Error::new(io::ErrorKind::NotFound, "No existing parent folder")),
        }
    }
}

/// Every file operation is checked against the folder the user opened (plus
/// any single files they opened explicitly).
#[derive(Default)]
pub struct Guard {
    pub roots: Vec<PathBuf>,
    pub files: HashSet<PathBuf>,
}

impl Guard {
    pub fn check(&self, raw: &str) -> Result<PathBuf, String> {
        let p = Path::new(raw);
        if !p.is_absolute() {
            return Err("Path must be absolute".into());
        }
        let c = canonicalize_lenient(p).map_err(|e| e.to_string())?;
        if self.roots.iter().any(|r| c.starts_with(r)) || self.files.contains(&c) {
            Ok(c)
        } else {
            Err("That path is outside the folder you opened".into())
        }
    }

    pub fn is_root(&self, p: &Path) -> bool {
        self.roots.iter().any(|r| r == p)
    }
}

/// Relative file paths (forward slashes) for quick open, skipping heavy folders.
pub fn list_files(root: &Path, limit: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".DS_Store" {
                continue;
            }
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                if !IGNORED_DIRS.contains(&name.as_str()) {
                    stack.push(entry.path());
                }
            } else if ft.is_file() {
                if let Ok(rel) = entry.path().strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                    if out.len() >= limit {
                        out.sort();
                        return out;
                    }
                }
            }
        }
    }
    out.sort();
    out
}

/// Current branch (or short commit) read straight from `.git/HEAD`.
pub fn git_branch(root: &Path) -> Option<String> {
    let head = fs::read_to_string(root.join(".git").join("HEAD")).ok()?;
    let head = head.trim();
    if let Some(r) = head.strip_prefix("ref: refs/heads/") {
        Some(r.to_string())
    } else if head.len() >= 7 && head.bytes().all(|b| b.is_ascii_hexdigit()) {
        Some(head[..7].to_string())
    } else {
        None
    }
}

fn valid_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_' | b':' | b'[' | b']'))
}

/// Build the argument list for `claude` in non-interactive streaming mode.
/// The prompt itself is sent on stdin, never as an argument.
pub fn claude_args(
    model: Option<&str>,
    session: Option<&str>,
    mode: Option<&str>,
    system: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut a: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    if let Some(m) = model.filter(|m| !m.is_empty() && *m != "default") {
        if !valid_token(m, 80) {
            return Err("Invalid model name".into());
        }
        a.push("--model".into());
        a.push(m.into());
    }
    if let Some(s) = session.filter(|s| !s.is_empty()) {
        if !valid_token(s, 80) {
            return Err("Invalid session id".into());
        }
        a.push("--resume".into());
        a.push(s.into());
    }
    if let Some(m) = mode.filter(|m| !m.is_empty()) {
        if !matches!(m, "plan" | "acceptEdits" | "default") {
            return Err("Invalid permission mode".into());
        }
        a.push("--permission-mode".into());
        a.push(m.into());
    }
    if let Some(s) = system.filter(|s| !s.trim().is_empty()) {
        a.push("--append-system-prompt".into());
        a.push(s.into());
    }
    Ok(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_split_across_chunks() {
        let text = "héllo → 世界".as_bytes().to_vec();
        for cut in 1..text.len() {
            let mut carry = Vec::new();
            let mut out = push_utf8(&mut carry, &text[..cut]);
            out.push_str(&push_utf8(&mut carry, &text[cut..]));
            assert_eq!(out, "héllo → 世界", "cut at {cut}");
        }
    }

    #[test]
    fn local_hosts() {
        for h in ["localhost", "127.0.0.1", "[::1]", "192.168.1.20", "10.0.0.5", "172.16.4.1", "mac.local"] {
            assert!(is_local_host(h), "{h}");
        }
        for h in ["api.openai.com", "8.8.8.8", "example.com", "172.32.0.1"] {
            assert!(!is_local_host(h), "{h}");
        }
    }

    #[test]
    fn secret_names() {
        assert!(valid_secret_name("provider.openai"));
        assert!(!valid_secret_name(""));
        assert!(!valid_secret_name("Provider"));
        assert!(!valid_secret_name("a b"));
    }

    #[test]
    fn guard_blocks_escape() {
        let base = std::env::temp_dir().join(format!("pino-test-{}", std::process::id()));
        let root = base.join("ws");
        fs::create_dir_all(&root).unwrap();
        fs::write(base.join("secret.txt"), "x").unwrap();
        let root = root.canonicalize().unwrap();
        let g = Guard { roots: vec![root.clone()], files: HashSet::new() };

        assert!(g.check(root.join("a.txt").to_str().unwrap()).is_ok());
        assert!(g.check(root.join("new/dir/b.txt").to_str().unwrap()).is_ok());
        assert!(g.check(root.join("../secret.txt").to_str().unwrap()).is_err());
        assert!(g.check(base.join("secret.txt").to_str().unwrap()).is_err());
        assert!(g.check("relative/path").is_err());

        #[cfg(unix)]
        {
            let link = root.join("escape");
            let _ = std::os::unix::fs::symlink(&base, &link);
            assert!(g.check(link.join("secret.txt").to_str().unwrap()).is_err());
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn cli_args() {
        let a = claude_args(Some("sonnet"), Some("abc-123"), Some("plan"), Some("be brief")).unwrap();
        assert!(a.windows(2).any(|w| w == ["--model", "sonnet"]));
        assert!(a.windows(2).any(|w| w == ["--resume", "abc-123"]));
        assert!(a.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(claude_args(Some("x; rm -rf /"), None, None, None).is_err());
        assert!(claude_args(None, None, Some("bypassPermissions"), None).is_err());
        assert!(!claude_args(Some("default"), None, None, None).unwrap().contains(&"--model".to_string()));
    }
}
