use anyhow::{ensure, Context, Result};
use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    process::Stdio,
};
use tokio::process::{Child, Command};
pub type EngineChild = Child;
use crate::config::{validate_nickname, Config};

pub fn arguments(
    config: &Config,
    address: &str,
    arz_mode: bool,
    password: Option<&str>,
) -> Result<Vec<OsString>> {
    validate_nickname(&config.nickname)?;
    let address = crate::servers::normalize_address(address)?;
    let assets = Path::new(&config.assets_dir);
    ensure!(
        assets.is_dir(),
        "Выберите папку с игровыми ресурсами в настройках"
    );
    let assets = assets.canonicalize()?;
    let mut assets_arg = OsString::from("--assets=");
    assets_arg.push(assets);
    let mut args = vec![
        assets_arg,
        format!("--server={address}").into(),
        format!("--nick={}", config.nickname).into(),
    ];
    if arz_mode {
        args.push("--arz-mode".into());
    }
    if let Some(password) = password.filter(|p| !p.is_empty()) {
        ensure!(
            password.len() < 255 && !password.contains('\0'),
            "Недопустимый пароль сервера"
        );
        args.push(format!("--password={password}").into());
    }
    Ok(args)
}
pub fn spawn(executable: &Path, args: Vec<OsString>, logs: &Path) -> Result<Child> {
    ensure!(executable.is_file(), "Исполняемый файл движка не найден");
    let executable = executable.canonicalize()?;
    std::fs::create_dir_all(logs)?;
    let logfile = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(logs.join("engine.log"))?;
    let mut command = Command::new(&executable);
    command
        .args(args)
        .current_dir(executable.parent().context("Нет каталога движка")?)
        .stdin(Stdio::null())
        .stdout(Stdio::from(logfile.try_clone()?))
        .stderr(Stdio::from(logfile));
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    command.spawn().context("Не удалось запустить NoveraMP")
}
pub fn executable_override(config: &Config) -> Result<Option<PathBuf>> {
    if config.engine_override.trim().is_empty() {
        return Ok(None);
    }
    let path = PathBuf::from(&config.engine_override);
    ensure!(path.is_file(), "Выбранный файл движка не существует");
    Ok(Some(path.canonicalize()?))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn launch_arguments_keep_paths_and_password_as_single_arguments() {
        let d = tempfile::tempdir().unwrap();
        let mut c = Config::default();
        c.assets_dir = d.path().to_str().unwrap().into();
        c.nickname = "Test_Player".into();
        let args = arguments(&c, "localhost", true, Some("a b;$(nothing)")).unwrap();
        assert!(args.contains(&"--arz-mode".into()));
        assert_eq!(args.last().unwrap(), "--password=a b;$(nothing)");
        let flags = arguments(&c, "localhost", false, Some("--help")).unwrap();
        assert_eq!(flags.last().unwrap(), "--password=--help");
        let plain = arguments(&c, "localhost", false, None).unwrap();
        assert!(!plain.contains(&"--arz-mode".into()));
        assert!(!plain.contains(&"--password".into()));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn child_process_gets_its_own_directory_and_literal_arguments() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempfile::tempdir().unwrap();
        let executable = d.path().join("mock engine");
        std::fs::write(&executable, b"#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"$@\"\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut child = spawn(
            &executable,
            vec!["one two".into(), "$(not-a-shell)".into()],
            &d.path().join("logs"),
        )
        .unwrap();
        assert!(child.wait().await.unwrap().success());
        let log = std::fs::read_to_string(d.path().join("logs/engine.log")).unwrap();
        assert!(log.contains("one two\n$(not-a-shell)"));
        assert!(log.contains(d.path().to_str().unwrap()));
    }
}
