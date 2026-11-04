import { invoke, Channel } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

export const inTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Thin wrappers over the Rust commands in src-tauri/src/lib.rs. */
export const api = {
  setWorkspace: (path) => invoke('set_workspace', { path }),
  allowFile: (path) => invoke('allow_file', { path }),
  listDir: (path) => invoke('list_dir', { path }),
  readFile: (path) => invoke('read_text_file', { path }),
  writeFile: (path, content) => invoke('write_text_file', { path, content }),
  mtime: (path) => invoke('file_mtime', { path }),
  createEntry: (path, isDir) => invoke('create_entry', { path, isDir }),
  renameEntry: (from, to) => invoke('rename_entry', { from, to }),
  deleteEntry: (path) => invoke('delete_entry', { path }),
  reveal: (path) => invoke('reveal_in_finder', { path }),
  listFiles: (root, limit = 20000) => invoke('list_files', { root, limit }),
  gitBranch: (root) => invoke('git_branch', { root }),
  openExternal: (url) => invoke('open_external', { url }),

  secretSet: (name, value) => invoke('secret_set', { name, value }),
  secretHas: (name) => invoke('secret_has', { name }),
  secretDelete: (name) => invoke('secret_delete', { name }),

  settingsRead: () => invoke('settings_read'),
  settingsWrite: (json) => invoke('settings_write', { json }),

  httpRequest: (req) => invoke('http_request', { req }),
  cliPath: () => invoke('claude_cli_path'),

  pickFolder: async () => {
    const r = await openDialog({ directory: true, multiple: false });
    return typeof r === 'string' ? r : null;
  },
  pickFile: async () => {
    const r = await openDialog({ directory: false, multiple: false });
    return typeof r === 'string' ? r : null;
  },
};

/**
 * Start a streaming Rust command (http_stream or claude_cli_run).
 * `onEvent` receives { event, data } objects. Returns { id, promise, cancel }.
 */
export function runStream(command, args, onEvent) {
  const id = crypto.randomUUID();
  const channel = new Channel();
  channel.onmessage = onEvent;
  const promise = invoke(command, { ...args, id, onEvent: channel });
  return {
    id,
    promise,
    cancel: () => invoke('job_cancel', { id }).catch(() => {}),
  };
}
