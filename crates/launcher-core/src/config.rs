use crate::servers::{normalize_address, Server};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::Path};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub nickname: String,
    pub assets_dir: String,
    pub engine_override: String,
    pub auto_update_engine: bool,
    pub auto_update_launcher: bool,
    pub hide_after_launch: bool,
    pub servers: Vec<Server>,
    pub favorites: Vec<String>,
    pub recent: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            nickname: "RustPlayer".into(),
            assets_dir: String::new(),
            engine_override: String::new(),
            auto_update_engine: true,
            auto_update_launcher: true,
            hide_after_launch: false,
            servers: vec![],
            favorites: vec![],
            recent: vec![],
        }
    }
}
pub fn validate_nickname(nick: &str) -> Result<()> {
    ensure!(
        (3..=24).contains(&nick.len()) && nick.bytes().all(|b| b.is_ascii_graphic()),
        "Ник должен содержать 3–24 латинских символа без пробелов"
    );
    Ok(())
}
impl Config {
    pub fn normalize(&mut self) -> Result<()> {
        self.nickname = self.nickname.trim().to_owned();
        validate_nickname(&self.nickname)?;
        ensure!(
            self.servers.len() <= 500 && self.favorites.len() <= 500,
            "Слишком много серверов (максимум 500)"
        );
        let mut seen = std::collections::HashSet::new();
        for server in &mut self.servers {
            server.address = normalize_address(&server.address)?;
            server.name = server.name.chars().take(128).collect();
            server.source = "custom".into();
        }
        self.servers.retain(|s| seen.insert(s.address.clone()));
        for addr in &mut self.favorites {
            *addr = normalize_address(addr)?;
        }
        seen.clear();
        self.favorites.retain(|s| seen.insert(s.clone()));
        self.recent = self
            .recent
            .iter()
            .filter_map(|a| normalize_address(a).ok())
            .take(20)
            .collect();
        Ok(())
    }
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let mut config: Self = serde_json::from_slice(&fs::read(path)?)
            .context("Не удалось прочитать настройки лаунчера")?;
        config.normalize()?;
        Ok(config)
    }
    pub fn save(&mut self, path: &Path) -> Result<()> {
        self.normalize()?;
        atomic_json(path, self)
    }
}
pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().context("Нет каталога настроек")?;
    fs::create_dir_all(parent)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(&serde_json::to_vec_pretty(value)?)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_roundtrip_replaces_and_deduplicates() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("config.json");
        let mut c = Config::default();
        c.favorites = vec!["EXAMPLE.com".into(), "example.com:7777".into()];
        c.save(&file).unwrap();
        c.nickname = "New_Player".into();
        c.save(&file).unwrap();
        let c = Config::load(&file).unwrap();
        assert_eq!(c.nickname, "New_Player");
        assert_eq!(c.favorites, ["example.com:7777"]);
    }
    #[test]
    fn broken_settings_are_reported_without_overwrite() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("config.json");
        fs::write(&p, b"broken").unwrap();
        assert!(Config::load(&p).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"broken");
    }
}
