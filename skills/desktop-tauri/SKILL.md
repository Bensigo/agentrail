# Desktop Tauri

Use this skill when working on Tauri desktop applications, including `src-tauri`, Rust commands, webview integration, permissions, capabilities, packaging, or desktop build behavior.

## Workflow

1. Identify whether the change touches the web frontend, Rust backend, Tauri config, capabilities, or packaging.
2. Keep frontend and Rust contracts explicit: command names, payload shapes, errors, and permissions.
3. Check `tauri.conf.json`, capability files, and platform-specific settings before changing privileged behavior.
4. Avoid widening permissions unless the issue requires it and the reason is documented.
5. Verify both the affected code path and the relevant desktop build or check command when practical.

## Verification

- Run targeted frontend and Rust checks for touched surfaces.
- Run the closest available Tauri build, dev, or validation command when the issue affects packaging, commands, or capabilities.
