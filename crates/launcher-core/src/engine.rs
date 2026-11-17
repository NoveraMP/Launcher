use anyhow::{bail, ensure, Context, Result};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub const ENGINE_REPOSITORY: &str = "NoveraMP/engine-releases";
const MAX_DOWNLOAD: u64 = 768 * 1024 * 1024;
const MAX_UNPACKED: u64 = 3 * 1024 * 1024 * 1024;
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ReleaseAsset {
    pub name: String,
    pub browser_download_url: String,
    pub size: u64,
    #[serde(default)]
    pub digest: Option<String>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Release {
    pub id: u64,
    pub tag_name: String,
    pub html_url: String,
    pub assets: Vec<ReleaseAsset>,
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub release_id: u64,
    pub version: String,
    pub directory: PathBuf,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub percent: u8,
    pub message: String,
}
pub type Reporter = Arc<dyn Fn(Progress) + Send + Sync>;
pub fn report(reporter: &Reporter, stage: &str, percent: u8, message: impl Into<String>) {
    reporter(Progress {
        stage: stage.into(),
        percent,
        message: message.into(),
    });
}
pub fn asset_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "noveramp-windows-x86_64.zip"
    } else {
        "noveramp-linux-x86_64.tar.gz"
    }
}
pub fn executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "noveramp.exe"
    } else {
        "noveramp"
    }
}
pub fn installed(root: &Path) -> Result<Option<Installed>> {
    let file = root.join("current.json");
    if !file.exists() {
        return Ok(None);
    }
    let value: Installed = serde_json::from_slice(&fs::read(file)?)?;
    // Keep managed executables inside our version store even if state is damaged.
    ensure!(
        value.directory == root.join("versions").join(value.release_id.to_string()),
        "Некорректный путь установленного движка"
    );
    if !value.directory.join(executable_name()).is_file() {
        return Ok(None);
    }
    Ok(Some(value))
}
pub async fn latest() -> Result<Release> {
    Ok(crate::http_client()?
        .get(format!(
            "https://api.github.com/repos/{ENGINE_REPOSITORY}/releases/latest"
        ))
        .send()
        .await?
        .error_for_status()
        .context("GitHub: релиз движка не найден или репозиторий недоступен")?
        .json()
        .await?)
}
pub async fn ensure_engine(root: &Path, update: bool, reporter: Reporter) -> Result<Installed> {
    let current = installed(root)?;
    if !update {
        return current.context("Движок не установлен. Включите автообновление или выберите исполняемый файл в настройках");
    }
    report(&reporter, "checking", 5, "Проверка обновлений движка…");
    let release = match latest().await {
        Ok(v) => v,
        Err(e) if current.is_some() => {
            report(
                &reporter,
                "offline",
                5,
                format!("GitHub недоступен: {e}. Используется установленный движок"),
            );
            return Ok(current.unwrap());
        }
        Err(e) => return Err(e),
    };
    if let Some(current) = &current {
        if current.release_id == release.id {
            return Ok(current.clone());
        }
    }
    match install_release(root, &release, reporter.clone()).await {
        Ok(value) => Ok(value),
        Err(error) => match current {
            Some(previous) => {
                report(
                    &reporter,
                    "offline",
                    5,
                    format!(
                        "Обновление не удалось: {error}. Используется движок {}",
                        previous.version
                    ),
                );
                Ok(previous)
            }
            None => Err(error),
        },
    }
}
pub async fn install_release(
    root: &Path,
    release: &Release,
    reporter: Reporter,
) -> Result<Installed> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == asset_name())
        .context("В релизе нет архива движка для этой платформы")?;
    let url = reqwest::Url::parse(&asset.browser_download_url)?;
    ensure!(
        url.scheme() == "https"
            && url.host_str() == Some("github.com")
            && url
                .path()
                .starts_with(&format!("/{ENGINE_REPOSITORY}/releases/download/")),
        "Некорректный адрес архива движка"
    );
    ensure!(
        asset.size > 0 && asset.size <= MAX_DOWNLOAD,
        "Архив движка имеет недопустимый размер"
    );
    fs::create_dir_all(root.join("versions"))?;
    let staging = tempfile::tempdir_in(root)?;
    let archive_path = staging.path().join("download.part");
    let client = crate::http_client()?;
    let response = client
        .get(url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await?
        .error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut file = fs::File::create(&archive_path)?;
    let mut hash = Sha256::new();
    let mut downloaded = 0u64;
    let mut last_percent = 0;
    while let Some(bytes) = stream.next().await {
        let bytes = bytes?;
        downloaded += bytes.len() as u64;
        ensure!(
            downloaded <= MAX_DOWNLOAD && downloaded <= asset.size,
            "Превышен размер архива"
        );
        hash.update(&bytes);
        file.write_all(&bytes)?;
        let percent = (10 + downloaded * 60 / asset.size).min(70) as u8;
        if percent != last_percent {
            report(
                &reporter,
                "downloading",
                percent,
                format!(
                    "Загрузка движка: {} / {} МБ",
                    downloaded / 1048576,
                    asset.size / 1048576
                ),
            );
            last_percent = percent;
        }
    }
    ensure!(downloaded == asset.size, "Архив скачан не полностью");
    file.sync_all()?;
    drop(file);
    if let Some(expected) = &asset.digest {
        verify_digest(expected, &hex::encode(hash.finalize()))?;
    }
    report(&reporter, "installing", 75, "Установка движка…");
    let unpacked = staging.path().join("unpacked");
    let source = archive_path.clone();
    let target = unpacked.clone();
    tokio::task::spawn_blocking(move || {
        extract_archive(&source, &target, cfg!(target_os = "windows"))
    })
    .await??;
    ensure!(
        unpacked.join(executable_name()).is_file(),
        "В архиве нет исполняемого файла noveramp"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(
            unpacked.join(executable_name()),
            fs::Permissions::from_mode(0o755),
        )?;
    }
    let destination = root.join("versions").join(release.id.to_string());
    // A completed version is immutable. A crashed prior extraction lives only
    // in a temporary directory and never replaces the active installation.
    if !destination.exists() {
        fs::rename(&unpacked, &destination)?;
    }
    ensure!(
        destination.join(executable_name()).is_file(),
        "Установленная версия повреждена"
    );
    let result = Installed {
        release_id: release.id,
        version: release.tag_name.clone(),
        directory: destination,
    };
    crate::config::atomic_json(&root.join("current.json"), &result)?;
    report(
        &reporter,
        "ready",
        90,
        format!("Движок {} готов", release.tag_name),
    );
    Ok(result)
}
pub fn verify_digest(expected: &str, actual: &str) -> Result<()> {
    let expected = expected
        .strip_prefix("sha256:")
        .context("Неизвестный алгоритм контрольной суммы GitHub")?;
    ensure!(
        expected.eq_ignore_ascii_case(actual),
        "Контрольная сумма архива не совпала"
    );
    Ok(())
}
fn safe_path(path: &Path) -> Result<PathBuf> {
    ensure!(!path.is_absolute(), "Абсолютный путь в архиве");
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(p) => {
                // Reject Windows syntax on every host, including tests on Linux.
                let name = p.to_string_lossy();
                ensure!(!name.contains([':', '\\']), "Недопустимый путь в архиве");
                result.push(p);
            }
            Component::CurDir => {}
            _ => bail!("Выход за каталог установки в архиве"),
        }
    }
    ensure!(!result.as_os_str().is_empty(), "Пустой путь в архиве");
    Ok(result)
}
pub fn extract_archive(source: &Path, destination: &Path, is_zip: bool) -> Result<()> {
    fs::create_dir_all(destination)?;
    let mut total = 0u64;
    let mut count = 0usize;
    if is_zip {
        let mut archive = zip::ZipArchive::new(fs::File::open(source)?)?;
        ensure!(archive.len() <= 20000, "Слишком много файлов в архиве");
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let target = destination.join(safe_path(Path::new(entry.name()))?);
            ensure!(!entry.is_symlink(), "Символическая ссылка в архиве");
            if entry.is_dir() {
                fs::create_dir_all(&target)?;
                continue;
            }
            total = total
                .checked_add(entry.size())
                .context("Переполнение размера")?;
            ensure!(total <= MAX_UNPACKED, "Распакованный архив слишком большой");
            fs::create_dir_all(target.parent().unwrap())?;
            let mut out = fs::File::create(target)?;
            let size = entry.size();
            let copied = std::io::copy(&mut entry.by_ref().take(size + 1), &mut out)?;
            ensure!(copied == size, "Неверный размер файла в архиве");
        }
    } else {
        let decoder = flate2::read::GzDecoder::new(fs::File::open(source)?);
        let mut archive = tar::Archive::new(decoder);
        for entry in archive.entries()? {
            let mut entry = entry?;
            count += 1;
            ensure!(count <= 20000, "Слишком много файлов в архиве");
            let path = entry.path()?.into_owned();
            if path == Path::new(".") {
                continue;
            }
            let target = destination.join(safe_path(&path)?);
            let kind = entry.header().entry_type();
            if kind.is_dir() {
                fs::create_dir_all(target)?;
                continue;
            }
            ensure!(
                kind.is_file(),
                "В архиве разрешены только обычные файлы и каталоги"
            );
            total = total
                .checked_add(entry.size())
                .context("Переполнение размера")?;
            ensure!(total <= MAX_UNPACKED, "Распакованный архив слишком большой");
            fs::create_dir_all(target.parent().unwrap())?;
            let mut out = fs::File::create(target)?;
            let size = entry.size();
            let copied = std::io::copy(&mut entry.by_ref().take(size + 1), &mut out)?;
            ensure!(copied == size, "Неверный размер файла в архиве");
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsafe_paths_and_bad_checksums_are_rejected() {
        for path in ["../outside", "/tmp/outside", "C:/outside", "a\\..\\outside"] {
            assert!(safe_path(Path::new(path)).is_err(), "{path}");
        }
        assert_eq!(
            safe_path(Path::new("./resources/file")).unwrap(),
            Path::new("resources/file")
        );
        assert!(verify_digest("sha256:abcd", "ABCD").is_ok());
        assert!(verify_digest("sha256:abcd", "ffff").is_err());
    }
    #[test]
    fn archives_extract_complete_runtime_and_reject_zip_traversal() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("test.zip");
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&p).unwrap());
            z.start_file("resources/file", zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"runtime").unwrap();
            z.finish().unwrap();
        }
        extract_archive(&p, &d.path().join("ok"), true).unwrap();
        assert_eq!(
            fs::read(d.path().join("ok/resources/file")).unwrap(),
            b"runtime"
        );
        {
            let mut z = zip::ZipWriter::new(fs::File::create(&p).unwrap());
            z.start_file("../escape", zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"bad").unwrap();
            z.finish().unwrap();
        }
        assert!(extract_archive(&p, &d.path().join("bad"), true).is_err());
        assert!(!d.path().join("escape").exists());
    }
    #[test]
    fn tar_runtime_and_failed_install_preserve_active_version() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("runtime.tar.gz");
        {
            let gz = flate2::write::GzEncoder::new(
                fs::File::create(&p).unwrap(),
                flate2::Compression::default(),
            );
            let mut t = tar::Builder::new(gz);
            let mut h = tar::Header::new_gnu();
            h.set_size(7);
            h.set_mode(0o755);
            h.set_cksum();
            t.append_data(&mut h, "./noveramp", &b"runtime"[..])
                .unwrap();
            t.into_inner().unwrap().finish().unwrap();
        }
        extract_archive(&p, &d.path().join("runtime"), false).unwrap();
        assert_eq!(
            fs::read(d.path().join("runtime/noveramp")).unwrap(),
            b"runtime"
        );
        let active = d.path().join("versions/1");
        fs::create_dir_all(&active).unwrap();
        fs::write(active.join(executable_name()), b"old").unwrap();
        crate::config::atomic_json(
            &d.path().join("current.json"),
            &Installed {
                release_id: 1,
                version: "v1".into(),
                directory: active.clone(),
            },
        )
        .unwrap();
        fs::write(&p, b"interrupted download").unwrap();
        assert!(extract_archive(&p, &d.path().join("staging"), false).is_err());
        assert_eq!(installed(d.path()).unwrap().unwrap().directory, active);
    }
}
