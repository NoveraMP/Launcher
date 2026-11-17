use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    time::{Duration, Instant},
};
use tokio::{net::UdpSocket, time::timeout};

pub const ARIZONA_CATALOG: &str = "https://arizona-ping.react.group/desktop/ping/Arizona/ping.json";
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Server {
    pub address: String,
    pub name: String,
    pub arz_mode: bool,
    pub password: bool,
    pub online: u16,
    pub maxplayers: u16,
    pub ping_ms: Option<u64>,
    pub mode: String,
    pub language: String,
    pub source: String,
    pub reachable: Option<bool>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Player {
    pub name: String,
    pub score: i32,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Details {
    pub players: Vec<Player>,
    pub rules: Vec<(String, String)>,
    pub errors: Vec<String>,
}

pub fn normalize_address(input: &str) -> Result<String> {
    let text = input
        .trim()
        .strip_prefix("samp://")
        .unwrap_or(input.trim())
        .trim_end_matches('/');
    let (host, port) = match text.split_once(':') {
        Some((host, port)) => (host, port.parse::<u16>().context("Некорректный порт")?),
        None => (text, 7777),
    };
    ensure!(
        !host.is_empty()
            && host.len() <= 253
            && host
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
            && port != 0,
        "Укажите IPv4 или домен и порт, например play.example.com:7777"
    );
    Ok(format!("{}:{port}", host.to_ascii_lowercase()))
}
pub async fn resolve(address: &str) -> Result<SocketAddrV4> {
    let address = normalize_address(address)?;
    let mut addresses = timeout(Duration::from_secs(5), tokio::net::lookup_host(&address))
        .await
        .context("Истекло время DNS-запроса")??;
    addresses
        .find_map(|a| match a {
            std::net::SocketAddr::V4(v) => Some(v),
            _ => None,
        })
        .context("У сервера нет IPv4-адреса")
}
pub fn query_packet(target: SocketAddrV4, opcode: u8) -> Vec<u8> {
    let mut bytes = b"SAMP".to_vec();
    bytes.extend(target.ip().octets());
    bytes.extend(target.port().to_le_bytes());
    bytes.push(opcode);
    bytes
}
async fn query(address: &str, opcode: u8) -> Result<(Vec<u8>, u64)> {
    let target = resolve(address).await?;
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).await?;
    socket.connect(target).await?;
    let request = query_packet(target, opcode);
    let start = Instant::now();
    socket.send(&request).await?;
    let mut buf = vec![0; 65535];
    let n = timeout(Duration::from_millis(1500), socket.recv(&mut buf))
        .await
        .context("Сервер не ответил на опрос")??;
    ensure!(n >= 11 && buf[..11] == request, "Некорректный ответ SA-MP");
    Ok((buf[11..n].to_vec(), start.elapsed().as_millis() as u64))
}
struct Reader<'a> {
    bytes: &'a [u8],
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure!(n <= self.bytes.len(), "Неполный ответ сервера");
        let (a, b) = self.bytes.split_at(n);
        self.bytes = b;
        Ok(a)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }
    fn string(&mut self, n: usize) -> Result<String> {
        Ok(encoding_rs::WINDOWS_1251
            .decode(self.take(n)?)
            .0
            .into_owned())
    }
    fn short_string(&mut self) -> Result<String> {
        let n = self.u8()? as usize;
        self.string(n)
    }
    fn long_string(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        ensure!(n <= 4096, "Слишком длинное поле сервера");
        self.string(n)
    }
}
pub fn parse_info(bytes: &[u8], address: &str, ping: u64) -> Result<Server> {
    let mut r = Reader { bytes };
    let password = r.u8()? != 0;
    let online = r.u16()?;
    let maxplayers = r.u16()?;
    let name = r.long_string()?;
    let mode = r.long_string()?;
    let language = r.long_string()?;
    Ok(Server {
        address: normalize_address(address)?,
        name,
        password,
        online,
        maxplayers,
        ping_ms: Some(ping),
        mode,
        language,
        reachable: Some(true),
        source: "custom".into(),
        ..Default::default()
    })
}
pub async fn query_server(address: &str) -> Result<Server> {
    let (bytes, ping) = query(address, b'i').await?;
    parse_info(&bytes, address, ping)
}
fn parse_players(bytes: &[u8]) -> Result<Vec<Player>> {
    let mut r = Reader { bytes };
    let n = r.u16()? as usize;
    ensure!(n <= 2000, "Слишком много игроков в ответе");
    (0..n)
        .map(|_| {
            Ok(Player {
                name: r.short_string()?,
                score: r.u32()? as i32,
            })
        })
        .collect()
}
fn parse_rules(bytes: &[u8]) -> Result<Vec<(String, String)>> {
    let mut r = Reader { bytes };
    let n = r.u16()? as usize;
    ensure!(n <= 512, "Слишком много правил в ответе");
    (0..n)
        .map(|_| Ok((r.short_string()?, r.short_string()?)))
        .collect()
}
pub async fn details(address: &str) -> Details {
    let (players, rules) = tokio::join!(query(address, b'c'), query(address, b'r'));
    let mut result = Details::default();
    match players.and_then(|(b, _)| parse_players(&b)) {
        Ok(v) => result.players = v,
        Err(e) => result.errors.push(format!("Список игроков: {e}")),
    }
    match rules.and_then(|(b, _)| parse_rules(&b)) {
        Ok(v) => result.rules = v,
        Err(e) => result.errors.push(format!("Правила: {e}")),
    }
    result
}
#[derive(Deserialize)]
struct Catalog {
    query: Vec<CatalogServer>,
}
#[derive(Deserialize)]
struct CatalogServer {
    name: String,
    ip: String,
    port: u16,
    online: u16,
    maxplayers: u16,
    #[serde(default)]
    password: bool,
}
pub fn parse_catalog(bytes: &[u8]) -> Result<Vec<Server>> {
    let catalog: Catalog = serde_json::from_slice(bytes)?;
    ensure!(
        catalog.query.len() <= 500,
        "Слишком большой каталог Arizona"
    );
    catalog
        .query
        .into_iter()
        .map(|s| {
            Ok(Server {
                address: normalize_address(&format!("{}:{}", s.ip, s.port))?,
                name: format!("Arizona RP | {}", s.name),
                online: s.online,
                maxplayers: s.maxplayers,
                password: s.password,
                arz_mode: true,
                mode: "Arizona Role Play".into(),
                language: "Русский".into(),
                source: "arizona".into(),
                ..Default::default()
            })
        })
        .collect()
}
pub async fn arizona_catalog() -> Result<Vec<Server>> {
    let bytes = crate::http_client()?
        .get(ARIZONA_CATALOG)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "Слишком большой каталог Arizona"
    );
    parse_catalog(&bytes)
}
/// Same direct HTTP warm-up as RakClient and the engine; best effort.
/// The engine repeats this request and keeps its UDP query alive after launch.
pub async fn preflight(address: &str) -> Result<()> {
    let target = resolve(address).await?;
    preflight_url(&format!("http://{}/", target.ip())).await
}
async fn preflight_url(url: &str) -> Result<()> {
    // The HTTP request must use the same source IP as the UDP socket.
    // An environment HTTP proxy would whitelist its exit instead of the player.
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(3))
        .build()?
        .get(url)
        .header("User-Agent", "Arizona PC")
        .timeout(Duration::from_secs(3))
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_are_normalized_without_shell_or_url_syntax() {
        assert_eq!(
            normalize_address(" samp://LOCALHOST ").unwrap(),
            "localhost:7777"
        );
        for bad in [
            "",
            "host:0",
            "host:65536",
            "a:7777:2",
            "https://host",
            "a && x",
            "../x",
        ] {
            assert!(normalize_address(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn real_catalog_shape_and_malformed_info() {
        let data=br#"{"query":[{"name":"Phoenix","ip":"phoenix.arizona-rp.com","port":7777,"online":777,"maxplayers":1000}]}"#;
        let s = parse_catalog(data).unwrap();
        assert!(s[0].arz_mode);
        assert_eq!(s[0].online, 777);
        for i in 0..17 {
            assert!(parse_info(&vec![0; i], "localhost:7777", 1).is_err());
        }
    }
    #[tokio::test]
    async fn udp_query_decodes_a_real_samp_information_packet() {
        let server = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let addr = server.local_addr().unwrap();
        let task = tokio::spawn(async move {
            let mut buf = [0; 64];
            let (n, client) = server.recv_from(&mut buf).await.unwrap();
            assert_eq!(n, 11);
            assert_eq!(buf[10], b'i');
            let mut reply = buf[..n].to_vec();
            reply.push(1);
            reply.extend(2u16.to_le_bytes());
            reply.extend(100u16.to_le_bytes());
            for s in ["Test Server", "Roleplay", "Russian"] {
                reply.extend((s.len() as u32).to_le_bytes());
                reply.extend(s.as_bytes());
            }
            server.send_to(&reply, client).await.unwrap();
        });
        let info = query_server(&addr.to_string()).await.unwrap();
        assert_eq!(info.name, "Test Server");
        assert_eq!(info.online, 2);
        assert!(info.password);
        task.await.unwrap();
    }
    #[tokio::test]
    async fn http_preflight_identifies_the_arizona_launcher() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = vec![0; 2048];
            let n = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_ascii_lowercase();
            assert!(request.starts_with("get / http/1.1"));
            assert!(request.contains("user-agent: arizona pc"));
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await
                .unwrap();
        });
        preflight_url(&format!("http://{target}/")).await.unwrap();
        server.await.unwrap();
    }
    #[test]
    fn malformed_counts_and_lengths_are_rejected() {
        assert!(parse_players(&[255, 255]).is_err());
        assert!(parse_rules(&[255, 255]).is_err());
        assert!(parse_catalog(
            br#"{"query":[{"name":"x","ip":"bad/path","port":7777,"online":0,"maxplayers":1}]}"#
        )
        .is_err());
    }
}
