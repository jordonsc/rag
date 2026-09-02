//! Serving the built ledger web UI off the disk.
//!
//! `rag-serve` is otherwise a JSON API, and this is the one place it hands a
//! browser something to run. It is deliberately hand-rolled: the whole job is
//! "resolve a path under a root without letting it escape, guess a content type
//! from the extension, and fall back to `index.html` for anything the bundle has
//! no file for", which is less code than the dependency that would do it.
//!
//! The SPA fallback is the single-page-application contract — the client-side
//! router owns what `/topic/rag-0042` means, so a deep link or a refresh has to
//! reach `index.html` rather than a 404. The API paths are excluded from it
//! explicitly ([`API_PREFIXES`]): a typo'd endpoint must stay a JSON 404, or
//! every broken agent request quietly returns an HTML document instead.
//!
//! # The cache headers are load-bearing
//!
//! A response with no freshness information and no validator is not refetched by
//! a browser — it applies a heuristic, and the heuristic caches. The symptom is a
//! redeployed server that keeps handing out the previous bundle until somebody
//! presses ctrl-shift-R, which nobody ever does. Two opposite rules close it:
//!
//! * **A content-hashed asset is immutable.** Vite names it `index-BBQLaZPA.js`,
//!   so the URL changes whenever the bytes do and a cached copy can never be
//!   stale. Cached for a year, never revalidated.
//! * **Everything else revalidates**, `index.html` above all — it is the one file
//!   whose name never changes and whose contents name every other file. `no-cache`
//!   plus an `ETag` makes an unchanged bundle a 304 with no body, so paying the
//!   round trip on every navigation is cheap.
//!
//! Getting the first rule wrong is the expensive direction (a hand-named file
//! pinned in a browser for a year), so [`looks_content_hashed`] refuses to guess:
//! a name it cannot prove is hashed revalidates instead.
//!
//! # The security headers are load-bearing too
//!
//! This response is what puts unauthenticated, client-written ledger prose in
//! front of a browser, so the headers it carries are the last barrier and the
//! only one enforced outside the code that renders it. Every response says
//! `nosniff`; the document also carries a [`CONTENT_SECURITY_POLICY`].

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    http::{header, HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Router,
};

use crate::ApiError;

/// Request paths owned by the JSON API. Anything at or under one of these is
/// never served from disk and never falls back to `index.html` — an unmatched
/// path here is a 404 with a JSON body, the same as every other API error.
const API_PREFIXES: &[&str] = &[
    "/health", "/info", "/search", "/reindex", "/ledger", "/prompts",
];

/// The document policy for the one response that carries ledger prose.
///
/// The prose is the reason. Event bodies and topic states are written by
/// whatever client wrote them, and the ledger endpoints have no authentication —
/// any client on the network can put any string in front of a reader. The UI
/// renders that through `markdown-it` with raw HTML disabled *and* through
/// DOMPurify, two independent barriers; this is the third, and the only one
/// that survives a mistake in the other two, because it is enforced by the
/// browser rather than by the code that was got wrong.
///
/// Directive by directive:
///
/// * `default-src 'self'` — the bundle is served same-origin with the API, so
///   nothing it legitimately needs comes from anywhere else. This covers
///   `connect-src`, `img-src` and `font-src` by inheritance.
/// * `script-src 'self'` — **the load-bearing one.** No `'unsafe-inline'`, no
///   `'unsafe-eval'`: injected script is inert even if it reaches the DOM. Vite
///   emits the entry point as an external module and puts the modulepreload
///   polyfill inside it, so `index.html` carries no inline script to allow.
/// * `style-src 'self' 'unsafe-inline'` — **headroom, not a present need.** An
///   earlier version of this comment claimed the UI collapses without it,
///   because several components set a computed dimension or an overlay position
///   through React's `style` prop. That was tested and is **false**: React
///   assigns through CSSOM (`el.style.top = …`), and CSP governs the style
///   *attribute* and `<style>` elements, not CSSOM assignment. Under a bare
///   `style-src 'self'` the app renders identically, with no violations.
///
///   It is kept anyway, deliberately. `markdown-it` runs with `html: false`, so
///   no attacker-authored style attribute can reach the DOM today — but that is
///   a property of a setting one edit away, and the day a component or a
///   dependency does set an attribute directly, the failure is a silently
///   mis-laid overlay rather than a test failure. Injected CSS is a far weaker
///   primitive than injected script, which is where the policy's real weight
///   sits. If you want to tighten this, the narrower `style-src-attr` is the
///   wrong tool: it is CSP 3, and a browser that does not implement it falls
///   back to `style-src`, breaking the UI in precisely the browsers meant to be
///   protected. Drop to `style-src 'self'` instead, and re-test.
/// * `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'` — no
///   plugin content, no rewriting the base against which every relative URL in
///   the page resolves, and no embedding this UI in somebody else's frame.
const CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self'; ",
    "style-src 'self' 'unsafe-inline'; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "frame-ancestors 'none'"
);

/// `Cache-Control` for a content-hashed asset: forever, and never ask again.
/// A year is the longest a cache is allowed to honour.
const CACHE_IMMUTABLE: &str = "public, max-age=31536000, immutable";

/// `Cache-Control` for everything else. `no-cache` does not mean "do not store" —
/// it means "store it, but never serve it without asking first".
const CACHE_REVALIDATE: &str = "no-cache";

/// How many characters of digest the bundler appends to a chunk name. Vite's
/// default is eight base64url characters, and this is matched *exactly* rather
/// than as a minimum — see [`looks_content_hashed`]. A bundle configured to some
/// other length simply loses the immutable policy and revalidates, which is the
/// safe direction to be wrong in.
const HASH_LEN: usize = 8;

/// A built web bundle on disk.
#[derive(Debug, Clone)]
pub struct Bundle {
    root: PathBuf,
}

/// One resolved file, ready to become a response.
struct Served {
    content_type: &'static str,
    bytes: Vec<u8>,
    cache_control: &'static str,
    /// The quoted entity tag for these bytes. `None` for an immutable asset:
    /// its URL is already its validator, so hashing it on every request would
    /// produce a header nobody will ever send back.
    etag: Option<String>,
}

/// Why a path produced no file.
enum Refusal {
    /// The path tried to leave the root. Refused rather than normalised — a
    /// caller that meant `..` meant something this is not for.
    Unsafe,
    /// Neither the named file nor `index.html` could be read: the bundle has
    /// gone, or was installed broken.
    Missing,
}

impl Bundle {
    /// A bundle at `root`, if there is one there.
    ///
    /// The test is `index.html`, because that is the file the fallback depends
    /// on: a directory that exists but has no entry point would 404 every
    /// request while reporting itself present.
    pub fn at(root: impl Into<PathBuf>) -> Option<Self> {
        let root = root.into();
        root.join("index.html").is_file().then_some(Self { root })
    }

    /// The root, for logging where the bundle was found.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve a request path to bytes plus the policy they must be served with.
    async fn resolve(&self, path: &str) -> Result<Served, Refusal> {
        let relative = path.trim_start_matches('/');
        let mut safe = PathBuf::new();
        for component in Path::new(relative).components() {
            match component {
                std::path::Component::Normal(part) => safe.push(part),
                // Parent dirs, roots and prefixes all get the same answer:
                // whatever this is, it is not a file in the bundle.
                _ => return Err(Refusal::Unsafe),
            }
        }

        let candidate = self.root.join(&safe);
        let named = !relative.is_empty() && candidate.is_file();
        let file = if named {
            candidate
        } else {
            self.root.join("index.html")
        };
        let bytes = tokio::fs::read(&file).await.map_err(|_| Refusal::Missing)?;

        // Note the immutability test is the *filename*, not the directory it
        // sits in: `assets/` holds hand-named files too, and pinning one of
        // those for a year is the failure this whole module exists to avoid.
        if named && looks_content_hashed(&file) {
            return Ok(Served {
                content_type: content_type(&file),
                bytes,
                cache_control: CACHE_IMMUTABLE,
                etag: None,
            });
        }
        Ok(Served {
            content_type: content_type(&file),
            etag: Some(format!("\"{}\"", rag_core::hashing::hash_bytes(&bytes))),
            bytes,
            cache_control: CACHE_REVALIDATE,
        })
    }
}

impl Served {
    /// The headers these bytes must be served with.
    fn headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static(self.content_type),
        );
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static(self.cache_control),
        );
        // On every response, not only the document. `content_type` returns a
        // closed list precisely so a browser is never handed a sniffing
        // decision — and this is the header that actually forbids it taking one
        // anyway. A `.txt` in the bundle that a sniffer decided was HTML would
        // be a same-origin document nobody wrote.
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        // Only on the document: a policy is a property of the page's execution
        // context, and a script or stylesheet response has none to govern.
        if self.content_type.starts_with("text/html") {
            headers.insert(
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(CONTENT_SECURITY_POLICY),
            );
        }
        if let Some(value) = self
            .etag
            .as_deref()
            .and_then(|e| HeaderValue::from_str(e).ok())
        {
            headers.insert(header::ETAG, value);
        }
        headers
    }

    /// Whether an `If-None-Match` header matches these bytes — i.e. the browser
    /// already holds them and should be answered `304` with no body.
    ///
    /// Handles the list form and the `W/` weak prefix: a proxy in the path may
    /// rewrite the tag into either, and a strict string compare would then
    /// silently re-send the whole body for ever.
    fn matches(&self, if_none_match: Option<&str>) -> bool {
        let (Some(etag), Some(header)) = (self.etag.as_deref(), if_none_match) else {
            return false;
        };
        header.split(',').any(|candidate| {
            let candidate = candidate.trim();
            candidate == "*" || candidate.trim_start_matches("W/") == etag
        })
    }
}

/// Attach the web UI to `router`, if one is configured and installed.
///
/// Returns the router untouched when `web_root` is empty (the default) or holds
/// no bundle, so a JSON-only deployment — and an image built before the UI stage
/// existed — behaves exactly as it did before. A missing bundle is a warning,
/// never a startup failure: the API and its healthcheck are the service, and the
/// UI riding along on the same port must not be able to take them down.
pub fn attach(router: Router, web_root: &str) -> Router {
    let root = web_root.trim();
    if root.is_empty() {
        return router;
    }
    let Some(bundle) = Bundle::at(root) else {
        tracing::warn!(
            web_root = root,
            "no index.html under the web root — the ledger UI will not be served"
        );
        return router;
    };
    tracing::info!(web_root = %bundle.root().display(), "serving the ledger web UI");

    let bundle = Arc::new(bundle);
    router.fallback(move |method: Method, uri: Uri, headers: HeaderMap| {
        let bundle = bundle.clone();
        async move {
            let if_none_match = headers
                .get(header::IF_NONE_MATCH)
                .and_then(|value| value.to_str().ok());
            serve(&bundle, &method, uri.path(), if_none_match).await
        }
    })
}

/// The fallback handler proper: everything the router did not route.
async fn serve(
    bundle: &Bundle,
    method: &Method,
    path: &str,
    if_none_match: Option<&str>,
) -> Response {
    if is_api_path(path) {
        return ApiError::NotFound(format!("no such endpoint {path:?}")).into_response();
    }
    if *method != Method::GET && *method != Method::HEAD {
        return ApiError::NotFound(format!("no route for {method} {path:?}")).into_response();
    }
    match bundle.resolve(path).await {
        Ok(served) => {
            let headers = served.headers();
            if served.matches(if_none_match) {
                return (StatusCode::NOT_MODIFIED, headers).into_response();
            }
            (headers, served.bytes).into_response()
        }
        Err(Refusal::Unsafe) => {
            ApiError::BadRequest(format!("refused path {path:?}")).into_response()
        }
        Err(Refusal::Missing) => {
            ApiError::NotFound("the web UI bundle is not installed".into()).into_response()
        }
    }
}

/// Whether a path belongs to the JSON API rather than to the UI's own routing.
///
/// Matches a prefix only at a segment boundary, so `/healthz` is a UI route
/// while `/health` and `/ledger/rag-0042/append` are not.
fn is_api_path(path: &str) -> bool {
    API_PREFIXES.iter().any(|&prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
    })
}

/// Whether a filename carries a content hash — i.e. whether its URL changes when
/// its bytes do, which is the only thing that makes caching it for a year safe.
///
/// Vite emits `index-BBQLaZPA.js`: a stem, a hyphen, then a base64url digest.
/// Two details make the naive test wrong:
///
/// * **The digest may itself contain a hyphen** (base64url includes `-` and `_`),
///   so splitting on the last hyphen misreads a real chunk like `icons-Dr4stP-l.js`
///   as unhashed. The tail is therefore measured from the end, not searched for.
/// * **The length is exact, not a range.** Accepting 8..=24 would match
///   `some-longish-name.js` — `longish-name` is entirely base64url — and pin a
///   hand-written file for a year.
///
/// `index.html` is excluded outright rather than incidentally: it is the one file
/// that must never be immutable, and that should not rest on its name.
fn looks_content_hashed(path: &Path) -> bool {
    if path.file_name().is_some_and(|name| name == "index.html") {
        return false;
    }
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return false;
    };
    // The hyphen plus the digest, taken off the end rather than searched for.
    let Some(boundary) = stem.len().checked_sub(HASH_LEN + 1) else {
        return false;
    };
    if !stem.is_char_boundary(boundary) || stem.as_bytes()[boundary] != b'-' {
        return false;
    }
    stem[boundary + 1..]
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// The content type for a bundle file, from its extension.
///
/// A closed list of what the build actually emits. Anything else is
/// `application/octet-stream`: a browser asked to guess is a browser that has
/// been handed a sniffing decision.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript",
        Some("css") => "text/css",
        Some("json") | Some("map") | Some("webmanifest") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One header as text, or `None` when it was not set.
    fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
        headers.get(name).and_then(|value| value.to_str().ok())
    }

    /// A bundle pointed at a root that does not exist. Enough to exercise the
    /// path guard, which refuses before it ever touches the filesystem.
    fn detached() -> Bundle {
        Bundle {
            root: PathBuf::from("/nonexistent/rag-web-root"),
        }
    }

    #[test]
    fn a_directory_without_an_entry_point_is_not_a_bundle() {
        assert!(Bundle::at("/nonexistent/rag-web-root").is_none());
    }

    #[tokio::test]
    async fn a_path_that_tries_to_leave_the_root_is_refused_rather_than_normalised() {
        let bundle = detached();
        for path in [
            "/../secret",
            "../secret",
            "/assets/../../secret",
            "/./../../etc/shadow",
        ] {
            assert!(
                matches!(bundle.resolve(path).await, Err(Refusal::Unsafe)),
                "{path} must be refused"
            );
        }
    }

    /// The near-miss that is *not* a traversal, asserted so nobody "fixes" it:
    /// `//etc/shadow` has no parent component in it, so it resolves *inside* the
    /// bundle to a file that isn't there — and is therefore the entry point, like
    /// any other unknown path. Refusing it would mean refusing a UI route that
    /// merely looked like a system path.
    #[tokio::test]
    async fn a_path_that_merely_looks_alarming_is_not_a_traversal() {
        let bundle = detached();
        assert!(matches!(
            bundle.resolve("//etc/shadow").await,
            Err(Refusal::Missing)
        ));
    }

    #[test]
    fn api_paths_are_excluded_at_a_segment_boundary() {
        for path in [
            "/health",
            "/info",
            "/search",
            "/reindex",
            "/ledger",
            "/ledger/rag-0042",
            "/ledger/rag-0042/append",
            "/prompts",
            "/prompts/save",
            "/prompts/delete",
        ] {
            assert!(is_api_path(path), "{path} belongs to the API");
        }
        for path in [
            "/",
            "/healthz",
            "/ledgers",
            "/promptsy",
            "/topic/rag-0042",
            "/assets/x.js",
        ] {
            assert!(!is_api_path(path), "{path} belongs to the UI");
        }
    }

    #[test]
    fn a_hashed_name_is_recognised_and_a_hand_written_one_is_not() {
        for name in [
            "index-BBQLaZPA.js",
            "index-BEmFyvWy.css",
            // The digest is base64**url**, so it may carry a hyphen of its own.
            "icons-Dr4stP-l.js",
            // A chunk name with hyphens of its own, ahead of the digest.
            "vendor-react-hePW80VL.js",
        ] {
            assert!(looks_content_hashed(Path::new(name)), "{name}");
        }
        for name in [
            "index.html",
            "main.js",
            "favicon.svg",
            // Would match if the digest length were a range: `longish-name` is
            // twelve characters and entirely base64url.
            "some-longish-name.js",
            // A digest of the wrong length is not proven, so it revalidates.
            "app-BBQLaZ.js",
        ] {
            assert!(!looks_content_hashed(Path::new(name)), "{name}");
        }
    }

    /// The headers that are the last barrier in front of client-written prose.
    ///
    /// Asserted on the values rather than merely on presence: a policy is only
    /// worth having if it says the right thing, and the two things worth
    /// pinning are that script has no inline escape hatch and that style does.
    #[test]
    fn the_document_carries_a_policy_and_nothing_may_be_sniffed() {
        let document = Served {
            content_type: "text/html; charset=utf-8",
            bytes: Vec::new(),
            cache_control: CACHE_REVALIDATE,
            etag: Some("\"abc123\"".to_string()),
        };
        let headers = document.headers();
        assert_eq!(
            header_str(&headers, header::X_CONTENT_TYPE_OPTIONS),
            Some("nosniff")
        );
        assert_eq!(
            header_str(&headers, header::CONTENT_SECURITY_POLICY),
            Some(CONTENT_SECURITY_POLICY)
        );

        // A script or stylesheet has no execution context of its own to govern,
        // and still must not be sniffed into one.
        let asset = Served {
            content_type: "text/javascript",
            bytes: Vec::new(),
            cache_control: CACHE_IMMUTABLE,
            etag: None,
        };
        let headers = asset.headers();
        assert_eq!(
            header_str(&headers, header::X_CONTENT_TYPE_OPTIONS),
            Some("nosniff")
        );
        assert_eq!(header_str(&headers, header::CONTENT_SECURITY_POLICY), None);
    }

    /// What the policy must and must not permit, stated so that loosening it
    /// is a deliberate edit to a test rather than a quiet edit to a string.
    #[test]
    fn the_policy_bars_inline_script_and_permits_inline_style() {
        // The barrier that matters: injected script stays inert.
        assert!(CONTENT_SECURITY_POLICY.contains("script-src 'self';"));
        assert!(!CONTENT_SECURITY_POLICY.contains("'unsafe-eval'"));
        assert!(!CONTENT_SECURITY_POLICY.contains("script-src 'self' 'unsafe-inline'"));

        // The concession that has to be there: components set widths and
        // overlay positions through React's `style` prop, which is an inline
        // style attribute. Tightening this to `style-src 'self'` breaks the UI.
        assert!(CONTENT_SECURITY_POLICY.contains("style-src 'self' 'unsafe-inline'"));

        for directive in ["default-src 'self'", "object-src 'none'", "base-uri 'none'"] {
            assert!(CONTENT_SECURITY_POLICY.contains(directive), "{directive}");
        }
        assert!(CONTENT_SECURITY_POLICY.ends_with("frame-ancestors 'none'"));
    }

    #[test]
    fn a_validator_matches_its_own_tag_in_every_form_a_client_may_send_it() {
        let served = Served {
            content_type: "text/html; charset=utf-8",
            bytes: Vec::new(),
            cache_control: CACHE_REVALIDATE,
            etag: Some("\"abc123\"".to_string()),
        };
        assert!(served.matches(Some("\"abc123\"")));
        assert!(served.matches(Some("W/\"abc123\"")), "the weak form");
        assert!(served.matches(Some("\"stale\", \"abc123\"")), "a list");
        assert!(served.matches(Some("*")));
        assert!(!served.matches(Some("\"something-else\"")));
        assert!(!served.matches(None));

        // An immutable asset has nothing to match, and must never 304 by
        // accident on a client that sent a tag from elsewhere.
        let asset = Served {
            content_type: "text/javascript",
            bytes: Vec::new(),
            cache_control: CACHE_IMMUTABLE,
            etag: None,
        };
        assert!(!asset.matches(Some("\"abc123\"")));
        assert!(!asset.matches(Some("*")));
    }
}
