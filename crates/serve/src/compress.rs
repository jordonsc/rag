//! Response compression (ledger ubu-l3848).
//!
//! The service answered everything uncompressed: the queue view, the items
//! list, the attachments list, the web UI's JS and CSS. Over a remote link the
//! transfer, not the server, was the dashboard's load time. Every response is
//! now compressed when the client's `Accept-Encoding` takes it, **br** preferred
//! over **gzip** (tower-http picks by the client's q-values, then br first), and
//! sent as it was when the client accepts neither. A compressed response
//! carries `Vary: Accept-Encoding`.
//!
//! What is compressed is an allow-list by media type, because what is not text
//! is either compressed already (PNG, JPEG, WebP, zip, a PDF's streams) or of no
//! known shape (an attachment's `application/octet-stream`), and compressing it
//! again costs CPU for nothing:
//!
//! * `text/*` (HTML, CSS, JavaScript, plain text, Markdown), but not
//!   `text/event-stream`, whose events must not wait in an encoder's buffer;
//! * `application/json`, `application/javascript`, `application/xml` and any
//!   `+json` or `+xml` type (SVG among them).
//!
//! Bodies under [`MIN_BYTES`] go as they are: the framing would eat the saving.
//! A response without a `Content-Type` (a 304, the feed's WebSocket upgrade) is
//! never touched.

use axum::http::{header, Extensions, HeaderMap, StatusCode, Version};
use axum::Router;
use tower_http::compression::predicate::{Predicate, SizeAbove};
use tower_http::compression::{CompressionLayer, CompressionLevel};

/// Below this, a body is sent as it is.
pub const MIN_BYTES: u16 = 1024;

/// One level for both encoders: gzip 5 is within a few percent of gzip's
/// default (6) and br 5 beats it on size, while br's own default (11) is far too
/// slow to run on every response of a 4 MB list.
const LEVEL: i32 = 5;

/// Wrap every route of `router`, the web UI's fallback included, in the
/// compression layer. Call it last, once every route is in place.
pub fn attach(router: Router) -> Router {
    router.layer(
        CompressionLayer::new()
            .no_deflate()
            .no_zstd()
            .quality(CompressionLevel::Precise(LEVEL))
            .compress_when(SizeAbove::new(MIN_BYTES).and(compressible as Allow)),
    )
}

type Allow = fn(StatusCode, Version, &HeaderMap, &Extensions) -> bool;

/// Whether a response's media type is one worth compressing (module docs).
fn compressible(_: StatusCode, _: Version, headers: &HeaderMap, _: &Extensions) -> bool {
    let Some(value) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    let essence = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    match essence.split_once('/') {
        Some(("text", "event-stream")) => false,
        Some(("text", _)) => true,
        Some(("application", "json" | "javascript" | "xml")) => true,
        Some((_, sub)) => sub.ends_with("+json") || sub.ends_with("+xml"),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use axum::body::Body;
    use axum::http::Request;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    use super::*;

    /// A large, compressible body: the same shape the items list has.
    fn big() -> String {
        let row = r#"{"id":"p-t0001","title":"A ticket","status":"done"},"#;
        format!("[{}]", row.repeat(200).trim_end_matches(','))
    }

    fn app() -> Router {
        let typed = |media: &'static str, body: String| {
            move || async move { ([(header::CONTENT_TYPE, media)], body).into_response() }
        };
        attach(
            Router::new()
                .route("/json", get(typed("application/json", big())))
                .route("/js", get(typed("text/javascript", big())))
                .route("/css", get(typed("text/css; charset=utf-8", big())))
                .route("/svg", get(typed("image/svg+xml", big())))
                .route("/png", get(typed("image/png", big())))
                .route("/bin", get(typed("application/octet-stream", big())))
                .route("/zip", get(typed("application/zip", big())))
                .route("/sse", get(typed("text/event-stream", big())))
                .route("/small", get(typed("application/json", "[]".into())))
                .route(
                    "/untyped",
                    get(|| async {
                        let mut res = big().into_response();
                        res.headers_mut().remove(header::CONTENT_TYPE);
                        res
                    }),
                )
                .fallback(typed("text/html", big())),
        )
    }

    struct Got {
        encoding: Option<String>,
        vary: Option<String>,
        bytes: Vec<u8>,
    }

    async fn fetch(uri: &str, accept: Option<&str>) -> Got {
        let mut req = Request::get(uri);
        if let Some(accept) = accept {
            req = req.header(header::ACCEPT_ENCODING, accept);
        }
        let res = app()
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK, "{uri}");
        let text = |name| {
            res.headers()
                .get(name)
                .map(|v: &axum::http::HeaderValue| v.to_str().unwrap().to_string())
        };
        let (encoding, vary) = (text(header::CONTENT_ENCODING), text(header::VARY));
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        Got {
            encoding,
            vary,
            bytes,
        }
    }

    fn gunzip(bytes: &[u8]) -> String {
        let mut out = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut out)
            .unwrap();
        out
    }

    fn unbrotli(bytes: &[u8]) -> String {
        let mut out = String::new();
        brotli::Decompressor::new(bytes, 4096)
            .read_to_string(&mut out)
            .unwrap();
        out
    }

    #[tokio::test]
    async fn gzip_when_the_client_takes_only_gzip() {
        let got = fetch("/json", Some("gzip")).await;
        assert_eq!(got.encoding.as_deref(), Some("gzip"));
        assert_eq!(got.vary.as_deref(), Some("accept-encoding"));
        assert!(got.bytes.len() < big().len() / 4, "{}", got.bytes.len());
        assert_eq!(gunzip(&got.bytes), big());
    }

    #[tokio::test]
    async fn br_when_the_client_takes_both() {
        let got = fetch("/json", Some("gzip, deflate, br")).await;
        assert_eq!(got.encoding.as_deref(), Some("br"));
        assert_eq!(unbrotli(&got.bytes), big());
        // The client's q-values win over the server's preference.
        let got = fetch("/json", Some("br;q=0.5, gzip;q=1.0")).await;
        assert_eq!(got.encoding.as_deref(), Some("gzip"));
        assert_eq!(gunzip(&got.bytes), big());
    }

    #[tokio::test]
    async fn plain_when_the_client_takes_no_encoding_this_server_offers() {
        for accept in [
            None,
            Some("identity"),
            Some("deflate"),
            Some("zstd"),
            Some("br;q=0"),
        ] {
            let got = fetch("/json", accept).await;
            assert_eq!(got.encoding, None, "{accept:?}");
            assert_eq!(String::from_utf8(got.bytes).unwrap(), big(), "{accept:?}");
        }
    }

    #[tokio::test]
    async fn the_ui_bundle_and_documents_are_compressed() {
        for uri in ["/js", "/css", "/svg", "/projects/ubu"] {
            let got = fetch(uri, Some("gzip")).await;
            assert_eq!(got.encoding.as_deref(), Some("gzip"), "{uri}");
            assert_eq!(gunzip(&got.bytes), big(), "{uri}");
        }
    }

    /// Negative: binary bodies, an event stream, an untyped body and a small
    /// one go as they are, whatever the client accepts.
    #[tokio::test]
    async fn binary_streams_untyped_and_small_bodies_are_left_alone() {
        for uri in ["/png", "/bin", "/zip", "/sse", "/untyped"] {
            let got = fetch(uri, Some("gzip, br")).await;
            assert_eq!(got.encoding, None, "{uri}");
            assert_eq!(String::from_utf8(got.bytes).unwrap(), big(), "{uri}");
        }
        let got = fetch("/small", Some("gzip, br")).await;
        assert_eq!(got.encoding, None);
        assert_eq!(got.bytes, b"[]");
    }

    #[test]
    fn the_allow_list_reads_the_media_type_essence() {
        let allowed = |media: &str| {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, media.parse().unwrap());
            compressible(
                StatusCode::OK,
                Version::HTTP_11,
                &headers,
                &Extensions::new(),
            )
        };
        for yes in [
            "application/json",
            "Application/JSON; charset=utf-8",
            "text/markdown",
            "application/manifest+json",
            "application/javascript",
        ] {
            assert!(allowed(yes), "{yes}");
        }
        for no in [
            "image/jpeg",
            "image/webp",
            "application/pdf",
            "video/mp4",
            "text/event-stream",
            "garbage",
        ] {
            assert!(!allowed(no), "{no}");
        }
        assert!(!compressible(
            StatusCode::OK,
            Version::HTTP_11,
            &HeaderMap::new(),
            &Extensions::new()
        ));
    }
}
