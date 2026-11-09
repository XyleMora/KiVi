//! git's smart HTTP protocol for libgit2, over reqwest (rustls).
//!
//! libgit2's own HTTPS needs OpenSSL on Linux, which would add a build
//! dependency and a second TLS stack next to reqwest's. Instead KiVi registers
//! this transport for `https://` (as git2-curl does with curl): libgit2 still
//! speaks the git protocol, and each step of it is one HTTP request here.
//!
//! The forge token travels in the remote URL's user part
//! (`https://x-access-token:TOKEN@github.com/…`, `https://oauth2:TOKEN@gitlab.com/…`), which libgit2 hands to
//! `action`; it is moved into an `Authorization` header and never sent in a URL.

use std::io::{self, Read, Write};
use std::sync::Once;

use git2::transport::{Service, SmartSubtransport, SmartSubtransportStream, Transport};
use reqwest::blocking::{Client, Response};
use reqwest::Url;

/// Make libgit2 use this transport for https:// remotes (once per process).
pub fn register() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let client = Client::builder()
            .user_agent(concat!("git/2.0 (KiVi ", env!("CARGO_PKG_VERSION"), ")"))
            // A clone can download for minutes; only connecting is time-limited.
            .timeout(None)
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("HTTP client");
        // SAFETY: called once, before any https:// remote is used.
        let registered = unsafe { git2::transport::register("https", move |remote| Transport::smart(remote, true, Http { client: client.clone() })) };
        if let Err(e) = registered {
            eprintln!("KiVi: couldn't register the git HTTPS transport: {e}");
        }
    });
}

struct Http {
    client: Client,
}

/// Credentials in a URL's user part, and the URL without them.
pub(crate) fn split_auth(url: &str) -> Result<(String, Option<(String, String)>), String> {
    let mut u = Url::parse(url).map_err(|e| format!("{e}"))?;
    let auth = (!u.username().is_empty()).then(|| (u.username().to_string(), u.password().unwrap_or("").to_string()));
    let _ = u.set_username("");
    let _ = u.set_password(None);
    Ok((u.as_str().trim_end_matches('/').to_string(), auth))
}

impl SmartSubtransport for Http {
    fn action(&self, url: &str, service: Service) -> Result<Box<dyn SmartSubtransportStream>, git2::Error> {
        let (suffix, post) = match service {
            Service::UploadPackLs => ("/info/refs?service=git-upload-pack", None),
            Service::UploadPack => ("/git-upload-pack", Some("upload-pack")),
            Service::ReceivePackLs => ("/info/refs?service=git-receive-pack", None),
            Service::ReceivePack => ("/git-receive-pack", Some("receive-pack")),
        };
        let (base, auth) = split_auth(url).map_err(|e| git2::Error::from_str(&e))?;
        Ok(Box::new(Stream {
            client: self.client.clone(),
            url: format!("{base}{suffix}"),
            post,
            auth,
            body: Vec::new(),
            response: None,
        }))
    }

    fn close(&self) -> Result<(), git2::Error> {
        Ok(())
    }
}

/// One request: libgit2 writes the request body (for POSTs), then reads the
/// response; the request is sent on the first read.
struct Stream {
    client: Client,
    url: String,
    /// Some("upload-pack" | "receive-pack") for the POST steps, None for the ref lists.
    post: Option<&'static str>,
    auth: Option<(String, String)>,
    body: Vec<u8>,
    response: Option<Response>,
}

impl Stream {
    fn send(&mut self) -> io::Result<Response> {
        let mut req = match self.post {
            Some(service) => self
                .client
                .post(&self.url)
                .header("Content-Type", format!("application/x-git-{service}-request"))
                .header("Accept", format!("application/x-git-{service}-result"))
                .body(std::mem::take(&mut self.body)),
            None => self.client.get(&self.url),
        };
        if let Some((user, pass)) = &self.auth {
            req = req.basic_auth(user, Some(pass));
        }
        let res = req.send().map_err(|e| io::Error::other(format!("{}", e.without_url())))?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let gitlab = self.url.starts_with("https://gitlab.com/");
        let why = match (status.as_u16(), gitlab) {
            (401, false) => "GitHub asked for authentication: sign in to GitHub in KiVi",
            (403, false) => "GitHub refused access: the KiVi app may lack write access to this repository (Contents: read and write), or isn't installed on it",
            (401, true) => "GitLab asked for authentication: sign in to GitLab in KiVi",
            (403, true) => "GitLab refused access: your account needs the Developer role on this project, or the branch is protected",
            (404, _) => "repository not found, or private and KiVi can't reach it",
            (_, false) => "unexpected reply from GitHub",
            (_, true) => "unexpected reply from GitLab",
        };
        Err(io::Error::other(format!("{why} (HTTP {status})")))
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.response.is_none() {
            self.response = Some(self.send()?);
        }
        self.response.as_mut().expect("sent").read(buf)
    }
}

impl Write for Stream {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.body.extend_from_slice(data);
        Ok(data.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::split_auth;

    #[test]
    fn credentials_come_out_of_the_url() {
        let (url, auth) = split_auth("https://x-access-token:ghu_abc123@github.com/owner/repo.git").unwrap();
        assert_eq!(url, "https://github.com/owner/repo.git");
        assert_eq!(auth, Some(("x-access-token".into(), "ghu_abc123".into())));
        let (url, auth) = split_auth("https://github.com/owner/repo.git/").unwrap();
        assert_eq!(url, "https://github.com/owner/repo.git");
        assert_eq!(auth, None);
    }
}
