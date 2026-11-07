//! Route tests through axum's test harness: one happy path and one refusal per
//! route, plus the queue view's `ETag` and the 503 without a store.

use axum::body::Body;
use axum::http::{Method, Request};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::*;

struct T {
    _dir: tempfile::TempDir,
    app: Router,
}

async fn app() -> T {
    let dir = tempfile::tempdir().unwrap();
    let store = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
        .await
        .unwrap();
    T {
        _dir: dir,
        app: router(Some(store), None),
    }
}

struct Reply {
    status: StatusCode,
    headers: HeaderMap,
    bytes: Vec<u8>,
}

impl Reply {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes).unwrap_or_else(|_| {
            panic!(
                "not JSON ({}): {}",
                self.status,
                String::from_utf8_lossy(&self.bytes)
            )
        })
    }
    fn error(&self) -> String {
        self.json()["error"]
            .as_str()
            .unwrap_or_default()
            .to_string()
    }
}

async fn send(app: &Router, req: Request<Body>) -> Reply {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    Reply {
        status,
        headers,
        bytes,
    }
}

async fn get(app: &Router, uri: &str) -> Reply {
    send(app, Request::get(uri).body(Body::empty()).unwrap()).await
}

async fn post(app: &Router, uri: &str, body: Value) -> Reply {
    let req = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    send(app, req).await
}

/// `body` plus the identity fields every write carries.
fn w(mut body: Value) -> Value {
    let m = body.as_object_mut().unwrap();
    m.insert("author_email".into(), json!("dev@example.com"));
    m.insert("agent".into(), json!("Claude Test"));
    m.insert("surface".into(), json!("mcp"));
    body
}

async fn ok(r: Reply) -> Value {
    assert_eq!(
        r.status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&r.bytes)
    );
    r.json()
}

async fn item(app: &Router, project: &str, title: &str) -> String {
    let r = ok(post(
        app,
        &format!("/tracker/{project}/items"),
        w(json!({ "type": "dev", "title": title })),
    )
    .await)
    .await;
    r["id"].as_str().unwrap().to_string()
}

async fn start_and_finish(app: &Router, id: &str) {
    ok(post(
        app,
        &format!("/tracker/items/{id}"),
        w(json!({ "status": "in_progress", "note": "go" })),
    )
    .await)
    .await;
    ok(post(
        app,
        &format!("/tracker/items/{id}"),
        w(json!({ "status": "done", "note": "done" })),
    )
    .await)
    .await;
}

fn ids(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|i| i["id"].as_str().unwrap().to_string())
        .collect()
}

// ---- Availability ---------------------------------------------------------------

#[tokio::test]
async fn every_route_answers_503_without_a_store() {
    let app = router(None, None);
    for uri in [
        "/tracker/projects",
        "/tracker/p",
        "/tracker/p/check",
        "/tracker/p/velocity",
        "/tracker/p/report",
        "/tracker/p/roadmap",
        "/tracker/p/phases/p-p0001",
        "/tracker/p/labels",
        "/tracker/p/events",
        "/tracker/p/events/ws",
        "/tracker/items/p-t0001",
        "/tracker/docs/p-d0001",
    ] {
        let r = get(&app, uri).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
        assert!(r.error().contains("unavailable"));
    }
    let r = post(
        &app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE);
    for (uri, body) in [
        ("/tracker/p/phases", json!({ "title": "x" })),
        ("/tracker/p/phases/p-p0001", json!({ "title": "x" })),
        ("/tracker/p/phases/p-p0001/move", json!({ "top": true })),
        ("/tracker/p/phases/p-p0001/release", json!({})),
        ("/tracker/p/phases/p-p0001/recall", json!({})),
        ("/tracker/p/phases/p-p0001/archive", json!({})),
        ("/tracker/p/phases/p-p0001/unarchive", json!({})),
    ] {
        let r = post(&app, uri, w(body)).await;
        assert_eq!(r.status, StatusCode::SERVICE_UNAVAILABLE, "{uri}");
    }
}

// ---- Projects, the queue view, check, ack -------------------------------------------

#[tokio::test]
async fn projects_lists_what_has_been_written() {
    let t = app().await;
    assert_eq!(
        ok(get(&t.app, "/tracker/projects").await).await["projects"],
        json!([])
    );
    item(&t.app, "ubu", "a").await;
    let p = ok(get(&t.app, "/tracker/projects").await).await;
    assert_eq!(p["projects"][0]["name"], "ubu");
    assert_eq!(p["projects"][0]["queued"], 1);
}

#[tokio::test]
async fn the_queue_view_orders_sections_and_honours_if_none_match() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let g = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "gate", "title": "Gate", "intensity": "standard", "release": true })),
    )
    .await)
    .await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let b = item(&t.app, "p", "b").await;
    let c = item(&t.app, "p", "c").await;
    let d = item(&t.app, "p", "d").await;
    let e = item(&t.app, "p", "e").await;
    start_and_finish(&t.app, &a).await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{c}"),
        w(json!({ "blocked": true, "block_reason": "redesign", "note": "owner" })),
    )
    .await)
    .await;
    // rag-t0024: an item waiting on the owner is in review, its own section.
    ok(post(
        &t.app,
        &format!("/tracker/items/{e}"),
        w(json!({ "status": "review" })),
    )
    .await)
    .await;
    // rag-t0017: a deferred item has its own section, after blocked.
    ok(post(
        &t.app,
        &format!("/tracker/items/{d}"),
        w(json!({ "status": "deferred" })),
    )
    .await)
    .await;

    let r = get(&t.app, "/tracker/p").await;
    assert_eq!(r.status, StatusCode::OK);
    let etag = r
        .headers
        .get(header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    let v = r.json();
    assert_eq!(v["exists"], true);
    assert_eq!(ids(&v["done"]), vec![a.clone()]);
    assert_eq!(ids(&v["queue"]), vec![g.clone(), b.clone()]);
    assert_eq!(v["queue"][0]["type"], "gate");
    assert_eq!(v["queue"][0]["intensity"], "standard");
    assert_eq!(ids(&v["blocked"]), vec![c.clone()]);
    assert_eq!(v["blocked"][0]["block_reason"], "redesign");
    assert_eq!(ids(&v["deferred"]), vec![d.clone()]);
    assert_eq!(v["deferred"][0]["status"], "deferred");
    assert_eq!(v["deferred"][0]["queued"], true);
    assert_eq!(ids(&v["review"]), vec![e.clone()]);
    assert_eq!(v["review"][0]["status"], "review");
    assert_eq!(v["review"][0]["queued"], true);
    // The wire order is done, review, queue, blocked, deferred.
    let raw = String::from_utf8(r.bytes.to_vec()).unwrap();
    let at = |k: &str| raw.find(&format!("\"{k}\":[")).unwrap();
    assert!(at("done") < at("review") && at("review") < at("queue"));
    assert!(at("queue") < at("blocked") && at("blocked") < at("deferred"));
    let p = ok(get(&t.app, "/tracker/projects").await).await;
    assert_eq!(p["projects"][0]["queued"], 5);
    assert_eq!(p["projects"][0]["blocked"], 1);
    assert_eq!(p["projects"][0]["review"], 1);

    // A matching If-None-Match answers 304 with no body.
    let req = Request::get("/tracker/p")
        .header(header::IF_NONE_MATCH, &etag)
        .body(Body::empty())
        .unwrap();
    let r = send(&t.app, req).await;
    assert_eq!(r.status, StatusCode::NOT_MODIFIED);
    assert!(r.bytes.is_empty());
    assert_eq!(r.headers.get(header::ETAG).unwrap(), etag.as_str());

    // A write changes the ETag, and the old one no longer matches.
    ok(post(
        &t.app,
        &format!("/tracker/items/{b}/move"),
        w(json!({ "top": true })),
    )
    .await)
    .await;
    let req = Request::get("/tracker/p")
        .header(header::IF_NONE_MATCH, &etag)
        .body(Body::empty())
        .unwrap();
    let r = send(&t.app, req).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_ne!(r.headers.get(header::ETAG).unwrap(), etag.as_str());
    assert_eq!(ids(&r.json()["queue"]), vec![b, g]);

    // Refusal: an invalid project name.
    assert_eq!(
        get(&t.app, "/tracker/bad%20name").await.status,
        StatusCode::BAD_REQUEST
    );
    // An unknown project reads as empty.
    let v = ok(get(&t.app, "/tracker/nobody").await).await;
    assert_eq!(v["exists"], false);
}

#[tokio::test]
async fn check_reports_the_list() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let b = item(&t.app, "p", "b").await;
    let v = ok(get(&t.app, "/tracker/p/check").await).await;
    assert_eq!(v["ok"], true);
    assert_eq!(v["queued"], 2);
    assert_eq!(v["order"], json!([a, b]));
    assert_eq!(v["problems"], json!([]));
}

// ---- Velocity (spec:velocity m01, VL-06) --------------------------------------------

/// D26's shape, with every key and no others.
fn assert_velocity_shape(v: &Value) {
    let keys = |v: &Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(v),
        [
            "blocked",
            "deferred",
            "in_progress",
            "in_review",
            "now",
            "pending",
            "project",
            "remaining",
            "windows"
        ],
        "{v}"
    );
    assert_eq!(keys(&v["windows"]), ["24h", "7d"], "{v}");
    for w in ["24h", "7d"] {
        assert_eq!(keys(&v["windows"][w]), WINDOW_KEYS, "{v}");
    }
}

#[tokio::test]
async fn velocity_answers_the_figures_for_a_project_with_tickets() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let b = item(&t.app, "p", "b").await;
    item(&t.app, "p", "c").await;
    start_and_finish(&t.app, &a).await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{b}"),
        w(json!({ "status": "review" })),
    )
    .await)
    .await;
    let r = get(&t.app, "/tracker/p/velocity").await;
    assert_eq!(
        r.headers.get(header::CACHE_CONTROL).unwrap(),
        "no-store",
        "the windows move with the clock"
    );
    assert!(r.headers.get(header::ETAG).is_none());
    let v = ok(r).await;
    assert_velocity_shape(&v);
    assert_eq!(v["project"], "p");
    assert!(v["now"].as_str().unwrap().ends_with('Z'), "{v}");
    assert_eq!(
        (
            &v["in_progress"],
            &v["in_review"],
            &v["pending"],
            &v["remaining"]
        ),
        (&json!(1), &json!(1), &json!(1), &json!(2))
    );
    for w in ["24h", "7d"] {
        let win = &v["windows"][w];
        assert_eq!(win["done"], 1, "{v}");
        // Seconds of writes: the one-hour floor, so 24 a day, and 2 left is two
        // hours, the ETA unrounded (rag-t0062).
        assert_eq!(win["velocity_per_day"], 24.0, "{v}");
        assert_eq!(win["eta_days"], 2.0 / 24.0, "{v}");
        // Three added and one done (D33): −2 an hour of the floor is −48 a day,
        // and a growing queue's adjusted ETA is infinite (D34).
        assert_eq!(win["added"], 3, "{v}");
        assert_eq!(win["adj_velocity_per_day"], -48.0, "{v}");
        assert_eq!(win["adj_eta_days"], "infinite", "{v}");
    }
    // A read writes nothing: the queue view's ETag is unchanged.
    let before = get(&t.app, "/tracker/p").await.headers[header::ETAG].clone();
    get(&t.app, "/tracker/p/velocity").await;
    assert_eq!(
        get(&t.app, "/tracker/p").await.headers[header::ETAG],
        before
    );
}

#[tokio::test]
async fn velocity_is_zeros_for_an_unknown_project_and_400_for_an_invalid_name() {
    let t = app().await;
    let v = ok(get(&t.app, "/tracker/nobody/velocity").await).await;
    assert_velocity_shape(&v);
    for k in [
        "in_progress",
        "in_review",
        "pending",
        "blocked",
        "deferred",
        "remaining",
    ] {
        assert_eq!(v[k], 0, "{k}");
    }
    for w in ["24h", "7d"] {
        let win = &v["windows"][w];
        assert_eq!(
            (
                &win["done"],
                &win["active_seconds"],
                &win["velocity_per_day"]
            ),
            (&json!(0), &json!(0), &json!(0.0))
        );
        // Nothing remains: an ETA of 0, not unknown, adjusted or not.
        assert_eq!(win["eta_days"], 0.0);
        assert_eq!(win["adj_eta_days"], 0.0);
        assert_eq!(
            (&win["added"], &win["adj_velocity_per_day"]),
            (&json!(0), &json!(0.0))
        );
    }
    let r = get(&t.app, "/tracker/bad%20name/velocity").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("invalid project name"), "{}", r.error());
}

// ---- The report (spec:velocity m03, VL-11) -----------------------------------------

/// A velocity window's keys (D26, D33, D34), sorted.
const WINDOW_KEYS: [&str; 7] = [
    "active_seconds",
    "added",
    "adj_eta_days",
    "adj_velocity_per_day",
    "done",
    "eta_days",
    "velocity_per_day",
];

/// D27's shape, with every key and no others.
fn assert_report_shape(v: &Value) {
    let keys = |v: &Value| {
        let mut k: Vec<String> = v.as_object().unwrap().keys().cloned().collect();
        k.sort();
        k
    };
    assert_eq!(
        keys(v),
        ["buckets", "end", "mttc", "mttr", "project", "start", "states", "velocity", "window"],
        "{v}"
    );
    assert_eq!(keys(&v["velocity"]), WINDOW_KEYS, "{v}");
    for b in v["buckets"].as_array().unwrap() {
        assert_eq!(keys(b), ["added", "done", "remaining", "start"], "{b}");
    }
    assert_eq!(
        keys(&v["states"]),
        ["blocked", "deferred", "in_progress", "pending", "review"],
        "{v}"
    );
    for (_, s) in v["states"].as_object().unwrap() {
        assert_eq!(
            keys(s),
            [
                "count",
                "mean_seconds",
                "median_seconds",
                "oldest_open_seconds",
                "open",
                "p90_seconds"
            ],
            "{s}"
        );
    }
    assert_eq!(
        keys(&v["mttc"]),
        [
            "count",
            "mean_seconds",
            "median_seconds",
            "never_in_progress"
        ],
        "{v}"
    );
    assert_eq!(
        keys(&v["mttr"]),
        [
            "confirmed",
            "count",
            "mean_seconds",
            "median_seconds",
            "sent_back"
        ],
        "{v}"
    );
}

/// The burn-down's hourly buckets, 7 days whatever the window: one an hour, plus
/// one when they do not start on the hour (a partial hour at each end).
fn assert_hourly(v: &Value) {
    let n = v["buckets"].as_array().unwrap().len();
    assert!(n == 168 || n == 169, "{n} buckets for 168 hours");
}

#[tokio::test]
async fn report_answers_the_week_by_default_and_the_day_when_asked() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    item(&t.app, "p", "b").await;
    start_and_finish(&t.app, &a).await;

    let r = get(&t.app, "/tracker/p/report").await;
    assert_eq!(
        r.headers.get(header::CACHE_CONTROL).unwrap(),
        "no-store",
        "the window moves with the clock"
    );
    assert!(r.headers.get(header::ETAG).is_none());
    let v = ok(r).await;
    assert_report_shape(&v);
    assert_eq!((&v["project"], &v["window"]), (&json!("p"), &json!("7d")));
    assert!(v["end"].as_str().unwrap().ends_with('Z'), "{v}");
    assert_hourly(&v);
    assert_eq!(v["buckets"][0]["start"], v["start"]);
    let buckets = v["buckets"].as_array().unwrap();
    let sum = |k: &str| buckets.iter().map(|b| b[k].as_i64().unwrap()).sum::<i64>();
    assert_eq!((sum("added"), sum("done")), (2, 1), "{v}");
    assert_eq!(buckets.last().unwrap()["remaining"], 1, "{v}");
    assert_eq!(v["velocity"]["done"], 1);
    assert_eq!(v["mttc"]["count"], 1);
    assert_eq!(v["states"]["pending"]["count"], 1);
    assert_eq!(v["states"]["pending"]["open"], 1);

    let v = ok(get(&t.app, "/tracker/p/report?window=24h").await).await;
    assert_report_shape(&v);
    assert_eq!(v["window"], "24h");
    assert_hourly(&v);
    assert_eq!(v["velocity"]["done"], 1);
    let v = ok(get(&t.app, "/tracker/p/report?window=7d").await).await;
    assert_eq!(v["window"], "7d");

    // A read writes nothing: the queue view's ETag is unchanged.
    let before = get(&t.app, "/tracker/p").await.headers[header::ETAG].clone();
    get(&t.app, "/tracker/p/report").await;
    assert_eq!(
        get(&t.app, "/tracker/p").await.headers[header::ETAG],
        before
    );
}

#[tokio::test]
async fn report_refuses_another_window_and_is_empty_for_an_unknown_project() {
    let t = app().await;
    for uri in [
        "/tracker/p/report?window=30d",
        "/tracker/p/report?window=",
        "/tracker/p/report?days=7",
    ] {
        let r = get(&t.app, uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
    let r = get(&t.app, "/tracker/p/report?window=30d").await;
    assert!(r.error().contains("30d"), "{}", r.error());

    let v = ok(get(&t.app, "/tracker/nobody/report").await).await;
    assert_report_shape(&v);
    assert_hourly(&v);
    for b in v["buckets"].as_array().unwrap() {
        assert_eq!(
            (&b["remaining"], &b["added"], &b["done"]),
            (&json!(0), &json!(0), &json!(0))
        );
    }
    for (state, s) in v["states"].as_object().unwrap() {
        assert_eq!(
            s,
            &json!({
                "count": 0, "mean_seconds": null, "median_seconds": null, "p90_seconds": null,
                "open": 0, "oldest_open_seconds": null
            }),
            "{state}"
        );
    }
    assert_eq!(v["mttc"]["mean_seconds"], Value::Null);
    assert_eq!(v["mttr"]["count"], 0);

    let r = get(&t.app, "/tracker/bad%20name/report").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("invalid project name"), "{}", r.error());
}

#[tokio::test]
async fn ack_done_acknowledges_and_needs_an_author() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    start_and_finish(&t.app, &a).await;
    let v = ok(post(&t.app, "/tracker/p/ack-done", w(json!({}))).await).await;
    assert_eq!(v["acknowledged"], json!([a]));
    assert_eq!(ok(get(&t.app, "/tracker/p").await).await["done"], json!([]));

    let r = post(&t.app, "/tracker/p/ack-done", json!({ "surface": "web" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("author_email"), "{}", r.error());
    let r = post(
        &t.app,
        "/tracker/p/ack-done",
        json!({ "author_email": "x@y", "surface": "cli" }),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("unknown variant"), "{}", r.error());
}

// ---- Items ----------------------------------------------------------------------

#[tokio::test]
async fn items_list_filters_by_status() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    item(&t.app, "p", "b").await;
    start_and_finish(&t.app, &a).await;
    let v = ok(get(&t.app, "/tracker/p/items?status=done").await).await;
    assert_eq!(ids(&v["items"]), vec![a]);
    assert_eq!(
        ok(get(&t.app, "/tracker/p/items").await).await["items"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    // rag-t0017: deferred is a status like any other.
    let c = item(&t.app, "p", "c").await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{c}"),
        w(json!({ "status": "deferred" })),
    )
    .await)
    .await;
    let v = ok(get(&t.app, "/tracker/p/items?status=deferred").await).await;
    assert_eq!(ids(&v["items"]), vec![c.clone()]);
    // Negative: deferred -> failed is refused.
    let r = post(
        &t.app,
        &format!("/tracker/items/{c}"),
        w(json!({ "status": "failed" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(
        r.error().contains("cannot go from deferred to failed"),
        "{}",
        r.error()
    );
    // rag-t0024: review too; confirmed, it is done.
    let d = item(&t.app, "p", "d").await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{d}"),
        w(json!({ "status": "review" })),
    )
    .await)
    .await;
    let v = ok(get(&t.app, "/tracker/p/items?status=review").await).await;
    assert_eq!(ids(&v["items"]), vec![d.clone()]);
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{d}"),
        w(json!({ "status": "done" })),
    )
    .await)
    .await;
    assert_eq!(v["status"], "done");
    let r = get(&t.app, "/tracker/p/items?status=blocked").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("invalid status"), "{}", r.error());
}

#[tokio::test]
async fn the_retired_block_reason_approval_is_refused_naming_review() {
    // rag-t0024: approval is no longer a block reason; the refusal says what
    // replaced it.
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let r = post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "blocked": true, "block_reason": "approval", "note": "owner" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("status review"), "{}", r.error());
    let v = ok(get(&t.app, &format!("/tracker/items/{a}")).await).await;
    assert_eq!(v["blocked"], false);
}

#[tokio::test]
async fn item_create_mints_an_id_and_refuses_bad_bodies() {
    let t = app().await;
    let v = ok(post(
        &t.app,
        "/tracker/ubu/items",
        w(json!({ "type": "recon", "title": "Map the code", "body": "brief", "assignee": "recon-1",
                  "links": [{ "kind": "ledger", "target": "rag-0033" }] })),
    )
    .await)
    .await;
    assert_eq!(v["id"], "ubu-t0001");
    assert_eq!(v["status"], "pending");
    assert_eq!(v["approval"], "unapproved");
    assert_eq!(v["queued"], true);
    assert_eq!(
        v["links"],
        json!([{ "kind": "ledger", "target": "rag-0033" }])
    );
    assert_eq!(v["events"][0]["kind"], "create");
    assert_eq!(v["events"][0]["surface"], "mcp");
    assert_eq!(v["events"][0]["agent"], "Claude Test");

    let top = ok(post(
        &t.app,
        "/tracker/ubu/items",
        w(json!({ "type": "dev", "title": "urgent", "top": true })),
    )
    .await)
    .await;
    assert_eq!(top["next_id"], "ubu-t0001");

    for (body, needle) in [
        (
            w(json!({ "type": "epic", "title": "x" })),
            "unknown variant",
        ),
        (
            w(json!({ "type": "dev", "title": "x", "stauts": "done" })),
            "unknown field",
        ),
        (
            w(json!({ "type": "dev", "title": "x", "intensity": "full" })),
            "gate fields",
        ),
        (
            w(json!({ "type": "dev", "title": "x", "top": true, "bottom": true })),
            "at most one",
        ),
        (w(json!({ "type": "dev", "title": " " })), "title"),
    ] {
        let r = post(&t.app, "/tracker/ubu/items", body).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST);
        assert!(r.error().contains(needle), "{needle}: {}", r.error());
    }
    let r = send(
        &t.app,
        Request::post("/tracker/ubu/items")
            .body(Body::from("not json"))
            .unwrap(),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn item_get_with_and_without_history() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let v = ok(get(&t.app, &format!("/tracker/items/{a}")).await).await;
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
    let v = ok(get(&t.app, &format!("/tracker/items/{a}?history=false")).await).await;
    assert_eq!(v["events"], json!([]));
    let r = get(&t.app, "/tracker/items/p-t0999").await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert_eq!(
        get(&t.app, &format!("/tracker/items/{a}?history=maybe"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn item_update_changes_fields_and_takes_optional_notes() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "status": "in_progress", "assignee": "dev-3", "note": "dispatched" })),
    )
    .await)
    .await;
    assert_eq!(v["status"], "in_progress");
    assert_eq!(v["assignee"], "dev-3");
    let e = v["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(e["kind"], "status");
    assert_eq!(e["body"], "dispatched");
    assert_eq!(e["fields"]["assignee"], "dev-3");

    // A note is optional on every change (D7, amended 2026-10-27): the body is
    // generated from the change.
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "approval": "agent" })),
    )
    .await)
    .await;
    let e = v["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(e["kind"], "approve");
    assert_eq!(e["body"], "Approval: unapproved → agent.");
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "status": "done", "note": "" })),
    )
    .await)
    .await;
    assert_eq!(v["status"], "done");
    let e = v["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(e["body"], "Status: in_progress → done.");
    // Only a bare note (Add note) needs text.
    let r = post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "note": "   " })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("no note given"), "{}", r.error());
    let r = post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "blocked_reason": "review", "note": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("unknown field"), "{}", r.error());
    let r = post(&t.app, "/tracker/items/p-t0999", w(json!({ "note": "x" }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn parallel_goes_through_create_update_and_the_queue_view() {
    let t = app().await;
    let v = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "scratch build", "parallel": true })),
    )
    .await)
    .await;
    assert_eq!(v["parallel"], true);
    let b = item(&t.app, "p", "plain").await;
    let q = ok(get(&t.app, "/tracker/p").await).await;
    let flags: Vec<&Value> = q["queue"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| &i["parallel"])
        .collect();
    assert_eq!(flags, vec![&json!(true), &json!(false)]);
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{b}"),
        w(json!({ "parallel": true })),
    )
    .await)
    .await;
    assert_eq!(v["parallel"], true);
    assert_eq!(
        v["events"].as_array().unwrap().last().unwrap()["body"],
        "Parallel: on."
    );
    let r = post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "gate", "title": "g", "intensity": "quick", "parallel": true })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(
        r.error().contains("a gate cannot be parallel"),
        "{}",
        r.error()
    );
}

#[tokio::test]
async fn labels_go_through_create_update_the_vocabulary_and_the_items_filter() {
    let t = app().await;
    let a = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "heat", "labels": ["Physics", " biomes "] })),
    )
    .await)
    .await;
    assert_eq!(a["labels"], json!(["biomes", "Physics"]));
    let a = a["id"].as_str().unwrap().to_string();
    let b = item(&t.app, "p", "plain").await;
    // Every Item carries labels, empty when it has none.
    let q = ok(get(&t.app, "/tracker/p").await).await;
    assert_eq!(q["queue"][1]["labels"], json!([]));
    // An update sets them wholesale, in the project's casing.
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{b}"),
        w(json!({ "labels": ["physics", "Creatures"] })),
    )
    .await)
    .await;
    assert_eq!(v["labels"], json!(["Creatures", "Physics"]));
    assert_eq!(
        v["events"].as_array().unwrap().last().unwrap()["body"],
        "Labels: Creatures, Physics."
    );
    // The vocabulary, with counts.
    let l = ok(get(&t.app, "/tracker/p/labels").await).await;
    assert_eq!(
        l,
        json!({ "project": "p", "labels": [
            { "label": "biomes", "count": 1, "queued": 1 },
            { "label": "Creatures", "count": 1, "queued": 1 },
            { "label": "Physics", "count": 2, "queued": 2 },
        ]})
    );
    let l = ok(get(&t.app, "/tracker/nobody/labels").await).await;
    assert_eq!(l["labels"], json!([]));
    // The items list filters by label, case-insensitively.
    let v = ok(get(&t.app, "/tracker/p/items?label=PHYSICS").await).await;
    assert_eq!(ids(&v["items"]), vec![a.clone(), b.clone()]);
    let v = ok(get(&t.app, "/tracker/p/items?label=Biomes&status=pending").await).await;
    assert_eq!(ids(&v["items"]), vec![a.clone()]);
    let v = ok(get(&t.app, "/tracker/p/items?label=Ghosts").await).await;
    assert_eq!(v["items"], json!([]));
    // Refusals: a bad label, a non-list, an invalid project.
    for body in [
        json!({ "labels": ["a, b"] }),
        json!({ "labels": [""] }),
        json!({ "labels": "Physics" }),
    ] {
        let r = post(&t.app, &format!("/tracker/items/{b}"), w(body.clone())).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
    }
    let r = get(&t.app, "/tracker/bad%20name/labels").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_dependency_block_unblocks_when_its_items_are_done() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let b = item(&t.app, "p", "b").await;
    let c = item(&t.app, "p", "c").await;
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{c}"),
        w(json!({ "blocked": true, "block_reason": "dependency", "depends_on": [a, b] })),
    )
    .await)
    .await;
    assert_eq!(v["block_reason"], "dependency");
    assert_eq!(v["depends_on"], json!([a, b]));
    let q = ok(get(&t.app, "/tracker/p").await).await;
    assert_eq!(q["blocked"][0]["depends_on"], json!([a, b]));
    assert_eq!(ok(get(&t.app, "/tracker/p/check").await).await["ok"], true);

    start_and_finish(&t.app, &a).await;
    let v = ok(get(&t.app, &format!("/tracker/items/{c}")).await).await;
    assert_eq!(v["blocked"], true);
    start_and_finish(&t.app, &b).await;
    let v = ok(get(&t.app, &format!("/tracker/items/{c}")).await).await;
    assert_eq!(v["blocked"], false);
    assert_eq!(v["depends_on"], json!([]));
    let e = v["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(e["kind"], "unblock");
    assert_eq!(
        e["body"],
        format!("Unblocked: {b} is done, the last of {a}, {b}.")
    );
    assert_eq!(e["surface"], "mcp");
    assert_eq!(ok(get(&t.app, "/tracker/p/check").await).await["ok"], true);

    // Refusals: another project's item, and an empty list.
    let other = item(&t.app, "q", "elsewhere").await;
    let d = item(&t.app, "p", "d").await;
    let r = post(
        &t.app,
        &format!("/tracker/items/{d}"),
        w(json!({ "blocked": true, "block_reason": "dependency", "depends_on": [other] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("its own project"), "{}", r.error());
    let r = post(
        &t.app,
        &format!("/tracker/items/{d}"),
        w(json!({ "blocked": true, "block_reason": "dependency", "depends_on": [] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("needs depends_on"), "{}", r.error());
    assert_eq!(ok(get(&t.app, "/tracker/p/check").await).await["ok"], true);
}

#[tokio::test]
async fn item_move_relinks_and_refuses_bad_places() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    let b = item(&t.app, "p", "b").await;
    let c = item(&t.app, "p", "c").await;
    let v = ok(post(
        &t.app,
        &format!("/tracker/items/{c}/move"),
        w(json!({ "before": a, "note": "most urgent" })),
    )
    .await)
    .await;
    assert_eq!(
        v["events"].as_array().unwrap().last().unwrap()["kind"],
        "move"
    );
    ok(post(
        &t.app,
        &format!("/tracker/items/{a}/move"),
        w(json!({ "after": b })),
    )
    .await)
    .await;
    assert_eq!(
        ok(get(&t.app, "/tracker/p/check").await).await["order"],
        json!([c, b, a])
    );

    for body in [
        w(json!({ "before": a })),
        w(json!({})),
        w(json!({ "top": true, "after": b })),
    ] {
        let r = post(&t.app, &format!("/tracker/items/{a}/move"), body).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{}", r.error());
    }
    let other = item(&t.app, "q", "other").await;
    let r = post(
        &t.app,
        &format!("/tracker/items/{a}/move"),
        w(json!({ "before": other })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(ok(get(&t.app, "/tracker/p/check").await).await["ok"], true);
}

// ---- Documents ------------------------------------------------------------------

async fn doc(app: &Router, path: &str, body: &str) -> Value {
    ok(post(
        app,
        "/tracker/p/docs",
        w(json!({ "path": path, "title": "Doc", "body": body })),
    )
    .await)
    .await
}

#[tokio::test]
async fn docs_create_list_and_refuse() {
    let t = app().await;
    let v = doc(&t.app, "notes/a.md", "hello\n").await;
    assert_eq!(v["id"], "p-d0001");
    assert_eq!(v["revision"], 1);
    assert_eq!(v["kind"], "doc");
    assert_eq!(v["body"], "hello\n");
    doc(&t.app, "other.md", "").await;
    let l = ok(get(&t.app, "/tracker/p/docs?prefix=notes/").await).await;
    assert_eq!(l["documents"].as_array().unwrap().len(), 1);
    assert_eq!(l["documents"][0]["path"], "notes/a.md");
    assert!(
        l["documents"][0].get("body").is_none(),
        "the list carries no bodies"
    );
    assert_eq!(
        get(&t.app, "/tracker/p/docs?kind=book").await.status,
        StatusCode::BAD_REQUEST
    );

    let r = post(
        &t.app,
        "/tracker/p/docs",
        w(json!({ "path": "../x.md", "title": "t" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = post(
        &t.app,
        "/tracker/p/docs",
        w(json!({ "path": "notes/a.md", "title": "t" })),
    )
    .await;
    assert!(r.error().contains("taken"), "{}", r.error());
}

#[tokio::test]
async fn doc_by_path_and_by_id_follow_redirects_and_revisions() {
    let t = app().await;
    let id = doc(&t.app, "concepts/old.md", "one\n").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/write"),
        w(json!({ "base_revision": 1, "body": "two\n" })),
    )
    .await)
    .await;
    ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/rename"),
        w(json!({ "path": "concepts/new.md" })),
    )
    .await)
    .await;

    let v = ok(get(&t.app, "/tracker/p/doc?path=concepts/old.md").await).await;
    assert_eq!(v["id"], id);
    assert_eq!(v["path"], "concepts/new.md");
    assert_eq!(v["redirected_from"], "concepts/old.md");
    assert_eq!(v["body"], "two\n");
    let v = ok(get(
        &t.app,
        "/tracker/p/doc?path=concepts/new.md&revision=1&history=false",
    )
    .await)
    .await;
    assert_eq!(v["body"], "one\n");
    assert_eq!(v["body_revision"], 1);
    assert_eq!(v["revision"], 2);
    assert_eq!(v["events"], json!([]));
    assert_eq!(
        get(&t.app, "/tracker/p/doc?path=nope.md").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&t.app, "/tracker/p/doc").await.status,
        StatusCode::BAD_REQUEST
    );

    let v = ok(get(&t.app, &format!("/tracker/docs/{id}?revision=1")).await).await;
    assert_eq!(v["body"], "one\n");
    assert_eq!(
        v["events"].as_array().unwrap().len(),
        3,
        "create, edit, rename"
    );
    assert_eq!(
        get(&t.app, "/tracker/docs/p-d0999").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&t.app, &format!("/tracker/docs/{id}?revision=9"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn doc_edit_applies_replacements_and_a_stale_base_is_a_409_with_the_current_document() {
    let t = app().await;
    let id = doc(&t.app, "a.md", "alpha\nbeta\n").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let v = ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/edit"),
        w(json!({ "base_revision": 1, "message": "caps",
                  "replacements": [{ "old": "alpha", "new": "ALPHA" }, { "old": "beta", "new": "BETA" }] })),
    )
    .await)
    .await;
    assert_eq!(v["body"], "ALPHA\nBETA\n");
    assert_eq!(v["revision"], 2);

    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/edit"),
        w(json!({ "base_revision": 1, "replacements": [{ "old": "ALPHA", "new": "a" }] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    let v = r.json();
    assert_eq!(v["current_revision"], 2);
    assert_eq!(v["current"]["body"], "ALPHA\nBETA\n");
    assert!(v["error"].as_str().unwrap().contains("revision 2"));

    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/edit"),
        w(json!({ "base_revision": 2, "replacements": [{ "old": "nope", "new": "x" }] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("exactly once"), "{}", r.error());
}

#[tokio::test]
async fn doc_write_replaces_the_body_and_refuses_a_stale_base() {
    let t = app().await;
    let id = doc(&t.app, "a.md", "one\n").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    let v = ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/write"),
        w(json!({ "base_revision": 1, "body": "two\n", "message": "rewrite" })),
    )
    .await)
    .await;
    assert_eq!(v["revision"], 2);
    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/write"),
        w(json!({ "base_revision": 1, "body": "mine\n" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["current"]["body"], "two\n");
}

#[tokio::test]
async fn doc_rename_and_its_refusals() {
    let t = app().await;
    let id = doc(&t.app, "a.md", "").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    doc(&t.app, "b.md", "").await;
    let v = ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/rename"),
        w(json!({ "path": "c.md", "title": "Sea" })),
    )
    .await)
    .await;
    assert_eq!(v["path"], "c.md");
    assert_eq!(v["title"], "Sea");
    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/rename"),
        w(json!({ "path": "b.md" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("taken"), "{}", r.error());
}

#[tokio::test]
async fn doc_revisions_diff_and_restore() {
    let t = app().await;
    let id = doc(&t.app, "a.md", "a\nb\n").await["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/write"),
        w(json!({ "base_revision": 1, "body": "a\nB\n" })),
    )
    .await)
    .await;

    let v = ok(get(&t.app, &format!("/tracker/docs/{id}/revisions")).await).await;
    let revs = v["revisions"].as_array().unwrap();
    assert_eq!(revs.len(), 2);
    assert_eq!(revs[1]["revision"], 2);
    assert_eq!(revs[1]["agent"], "Claude Test");
    assert!(revs[1].get("body").is_none());
    assert_eq!(
        get(&t.app, "/tracker/docs/p-d0999/revisions").await.status,
        StatusCode::NOT_FOUND
    );

    let d = ok(get(&t.app, &format!("/tracker/docs/{id}/diff")).await).await;
    assert_eq!(d["from"], 1);
    assert_eq!(d["to"], 2);
    assert_eq!(
        d["diff"],
        "--- revision 1\n+++ revision 2\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n"
    );
    assert_eq!(
        get(&t.app, &format!("/tracker/docs/{id}/diff?from=1&to=7"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&t.app, &format!("/tracker/docs/{id}/diff?from=x"))
            .await
            .status,
        StatusCode::BAD_REQUEST
    );

    let v = ok(post(
        &t.app,
        &format!("/tracker/docs/{id}/restore"),
        w(json!({ "revision": 1, "base_revision": 2 })),
    )
    .await)
    .await;
    assert_eq!(v["revision"], 3);
    assert_eq!(v["body"], "a\nb\n");
    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/restore"),
        w(json!({ "revision": 1, "base_revision": 2 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
    assert_eq!(r.json()["current_revision"], 3);
    let r = post(
        &t.app,
        &format!("/tracker/docs/{id}/restore"),
        w(json!({ "revision": 3, "base_revision": 3 })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

// ---- Specs, milestones, concepts ---------------------------------------------------

async fn spec(app: &Router) -> Value {
    ok(post(
        app,
        "/tracker/p/specs",
        w(json!({ "slug": "tracker", "title": "Tracker", "body": "# Tracker\n",
                  "milestones": [
                      { "code": "m01", "title": "The store and the HTTP API", "name": "store-and-api", "body": "m1\n" },
                      { "code": "m02", "title": "The MCP server", "body": "m2\n" }
                  ] })),
    )
    .await)
    .await
}

#[tokio::test]
async fn specs_create_list_get_and_update() {
    let t = app().await;
    let v = spec(&t.app).await;
    assert_eq!(v["slug"], "tracker");
    assert_eq!(v["state"], "draft");
    assert_eq!(v["path"], "specs/tracker/master.md");
    assert_eq!(
        v["milestones"][0]["path"],
        "specs/tracker/m01-store-and-api.md"
    );
    assert_eq!(
        v["milestones"][1]["path"],
        "specs/tracker/m02-the-mcp-server.md"
    );
    let r = post(
        &t.app,
        "/tracker/p/specs",
        w(json!({ "slug": "tracker", "title": "Again" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    let r = post(
        &t.app,
        "/tracker/p/specs",
        w(json!({ "slug": "Bad Slug", "title": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let l = ok(get(&t.app, "/tracker/p/specs").await).await;
    assert_eq!(l["specs"][0]["milestones"].as_array().unwrap().len(), 2);

    let g = ok(get(&t.app, "/tracker/p/specs/tracker").await).await;
    assert_eq!(g["events"][0]["kind"], "create");
    assert_eq!(
        get(&t.app, "/tracker/p/specs/nope").await.status,
        StatusCode::NOT_FOUND
    );

    let u = ok(post(
        &t.app,
        "/tracker/p/specs/tracker",
        w(json!({ "state": "ready", "approval": "owner", "note": "owner approved in chat" })),
    )
    .await)
    .await;
    assert_eq!(u["state"], "ready");
    assert_eq!(u["approval"], "owner");
    // No note: accepted, the body generated from the change (D7, amended 2026-10-27).
    let u = ok(post(
        &t.app,
        "/tracker/p/specs/tracker",
        w(json!({ "state": "done" })),
    )
    .await)
    .await;
    assert_eq!(u["state"], "done");
    let e = u["events"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(e["body"], "State: ready → done.");
    let r = post(
        &t.app,
        "/tracker/p/specs/tracker",
        w(json!({ "note": " " })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("no note given"), "{}", r.error());
    let r = post(
        &t.app,
        "/tracker/p/specs/tracker",
        w(json!({ "state": "active", "note": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn milestones_create_get_and_update() {
    let t = app().await;
    spec(&t.app).await;
    let m = ok(post(
        &t.app,
        "/tracker/p/specs/tracker/milestones",
        w(json!({ "code": "m03", "title": "The dashboard", "body": "d\n" })),
    )
    .await)
    .await;
    assert_eq!(m["order"], 3);
    assert_eq!(m["path"], "specs/tracker/m03-the-dashboard.md");
    let r = post(
        &t.app,
        "/tracker/p/specs/nope/milestones",
        w(json!({ "code": "m01", "title": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = post(
        &t.app,
        "/tracker/p/specs/tracker/milestones",
        w(json!({ "code": "m03", "title": "dup" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    let g = ok(get(&t.app, "/tracker/p/specs/tracker/milestones/m01").await).await;
    assert_eq!(g["state"], "not_started");
    assert_eq!(g["events"][0]["kind"], "create");
    assert_eq!(
        get(&t.app, "/tracker/p/specs/tracker/milestones/m09")
            .await
            .status,
        StatusCode::NOT_FOUND
    );

    let u = ok(post(
        &t.app,
        "/tracker/p/specs/tracker/milestones/m01",
        w(json!({ "state": "done", "note": "gated" })),
    )
    .await)
    .await;
    assert_eq!(u["state"], "done");
    let r = post(
        &t.app,
        "/tracker/p/specs/tracker/milestones/m01",
        w(json!({ "approval": "ratified", "note": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("not agent"), "{}", r.error());
}

#[tokio::test]
async fn concepts_create_list_get_and_update() {
    let t = app().await;
    spec(&t.app).await;
    let c = ok(post(
        &t.app,
        "/tracker/p/concepts",
        w(json!({ "slug": "power-generation", "title": "Power generation", "body": "musings\n" })),
    )
    .await)
    .await;
    assert_eq!(c["path"], "concepts/power-generation.md");
    assert_eq!(c["state"], "open");
    let r = post(
        &t.app,
        "/tracker/p/concepts",
        w(json!({ "slug": "Power Gen", "title": "x" })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);

    assert_eq!(
        ok(get(&t.app, "/tracker/p/concepts?state=open").await).await["concepts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        get(&t.app, "/tracker/p/concepts?state=closed").await.status,
        StatusCode::BAD_REQUEST
    );

    let g = ok(get(&t.app, "/tracker/p/concepts/power-generation").await).await;
    assert_eq!(g["title"], "Power generation");
    assert_eq!(
        get(&t.app, "/tracker/p/concepts/nope").await.status,
        StatusCode::NOT_FOUND
    );

    let u = ok(post(
        &t.app,
        "/tracker/p/concepts/power-generation",
        w(json!({ "state": "refined", "note": "became the tracker spec", "add_links": [{ "kind": "spec", "target": "tracker" }] })),
    )
    .await)
    .await;
    assert_eq!(u["state"], "refined");
    assert_eq!(u["links"], json!([{ "kind": "spec", "target": "tracker" }]));
    let r = post(
        &t.app,
        "/tracker/p/concepts/power-generation",
        w(json!({ "add_links": [{ "kind": "spec", "target": "nope" }] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

// ---- Attachments ------------------------------------------------------------------

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR fake image body";

/// One multipart part: its name, `(file name, content type)` for a file, and its bytes.
type Part<'a> = (&'a str, Option<(&'a str, &'a str)>, &'a [u8]);

fn multipart(parts: &[Part<'_>]) -> (String, Vec<u8>) {
    let boundary = "XtrackerBOUNDARYx";
    let mut body = Vec::new();
    for (name, file, data) in parts {
        body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match file {
            Some((filename, ctype)) => body.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{name}\"; filename=\"{filename}\"\r\nContent-Type: {ctype}\r\n\r\n").as_bytes(),
            ),
            None => body.extend_from_slice(format!("Content-Disposition: form-data; name=\"{name}\"\r\n\r\n").as_bytes()),
        }
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

async fn upload(app: &Router, project: &str, filename: &str, ctype: &str, data: &[u8]) -> Reply {
    let (ct, body) = multipart(&[
        ("file", Some((filename, ctype)), data),
        ("author_email", None, b"dev@example.com"),
        ("agent", None, b"Claude Test"),
        ("surface", None, b"mcp"),
    ]);
    let req = Request::post(format!("/tracker/{project}/attachments"))
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    send(app, req).await
}

#[tokio::test]
async fn attachments_upload_list_and_fetch() {
    let t = app().await;
    let a = ok(upload(&t.app, "p", "terrain.png", "image/png", PNG).await).await;
    let sha = a["sha256"].as_str().unwrap().to_string();
    assert_eq!(a["ref"], format!("att:{}", &sha[..12]));
    assert_eq!(a["media_type"], "image/png");
    assert_eq!(a["size"], PNG.len());
    let b = ok(upload(&t.app, "p", "copy.png", "application/octet-stream", PNG).await).await;
    assert_eq!(b["sha256"], sha);
    assert_eq!(b["media_type"], "image/png", "octet-stream is sniffed");

    let l = ok(get(&t.app, "/tracker/p/attachments").await).await;
    assert_eq!(l["attachments"].as_array().unwrap().len(), 2);
    assert_eq!(l["attachments"][0]["name"], "copy.png", "newest first");

    let r = get(&t.app, &format!("/tracker/attachments/{}", &sha[..12])).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(r.bytes, PNG);
    assert_eq!(r.headers[header::CONTENT_TYPE], "image/png");
    assert!(r.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("inline"));
    assert_eq!(r.headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert!(r.headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .contains("sandbox"));

    // A non-image downloads rather than rendering.
    let h = ok(upload(
        &t.app,
        "p",
        "x.html",
        "text/html",
        b"<script>alert(1)</script>",
    )
    .await)
    .await;
    let r = get(
        &t.app,
        &format!("/tracker/attachments/{}", h["sha256"].as_str().unwrap()),
    )
    .await;
    assert!(r.headers[header::CONTENT_DISPOSITION]
        .to_str()
        .unwrap()
        .starts_with("attachment"));

    assert_eq!(
        get(&t.app, "/tracker/attachments/0123456789ab")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(&t.app, "/tracker/attachments/xyz").await.status,
        StatusCode::BAD_REQUEST
    );
}

#[tokio::test]
async fn attachment_uploads_are_refused_when_wrong() {
    let t = app().await;
    let r = upload(&t.app, "p", "x.png", "image/png", b"not an image").await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(
        r.error().contains("not a recognised image"),
        "{}",
        r.error()
    );

    // Not multipart at all.
    let r = post(&t.app, "/tracker/p/attachments", w(json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("multipart"), "{}", r.error());

    // No surface part.
    let (ct, body) = multipart(&[
        ("file", Some(("a.txt", "text/plain")), b"hi"),
        ("author_email", None, b"a@b"),
    ]);
    let req = Request::post("/tracker/p/attachments")
        .header("content-type", ct)
        .body(Body::from(body))
        .unwrap();
    let r = send(&t.app, req).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("surface"), "{}", r.error());

    // Over 50 MB.
    let big = vec![b'x'; MAX_ATTACHMENT_BYTES + 1];
    let r = upload(&t.app, "p", "big.txt", "text/plain", &big).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("50 MB"), "{}", r.error());
}

// ---- The reconcile trigger (m05 TS-01) ----------------------------------------

#[tokio::test]
async fn a_successful_write_touches_the_reconcile_trigger_and_nothing_else_does() {
    let dir = tempfile::tempdir().unwrap();
    let store = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
        .await
        .unwrap();
    let trigger = dir.path().join("tracker-reindex");
    let app = router(Some(store), Some(trigger.clone()));

    // A read does not fire it.
    assert_eq!(get(&app, "/tracker/ubu").await.status, StatusCode::OK);
    assert!(!trigger.exists(), "a GET must not trigger a reconcile");

    // A refused write does not fire it.
    let r = post(
        &app,
        "/tracker/ubu/items",
        w(json!({"type": "nope", "title": "x"})),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(!trigger.exists(), "a refused write changed nothing");

    // A successful write does.
    let r = post(
        &app,
        "/tracker/ubu/items",
        w(json!({"type": "dev", "title": "x"})),
    )
    .await;
    assert!(r.status.is_success(), "{}", r.error());
    assert!(trigger.exists(), "a write must trigger a reconcile");
}

#[tokio::test]
async fn without_a_trigger_writes_still_succeed() {
    let t = app().await;
    let r = post(
        &t.app,
        "/tracker/ubu/items",
        w(json!({"type": "dev", "title": "x"})),
    )
    .await;
    assert!(r.status.is_success());
}

// ---- rag-t0038: web writes are the owner's; events say what they changed from ----

#[tokio::test]
async fn a_web_write_without_an_agent_is_recorded_as_owner_with_its_prior_values() {
    let t = app().await;
    let web = |mut body: Value| {
        let m = body.as_object_mut().unwrap();
        m.insert("author_email".into(), json!("owner@example.com"));
        m.insert("surface".into(), json!("web"));
        body
    };
    let r = ok(post(
        &t.app,
        "/tracker/p/items",
        web(json!({ "type": "dev", "title": "From the web" })),
    )
    .await)
    .await;
    let id = r["id"].as_str().unwrap().to_string();
    let r = ok(post(
        &t.app,
        &format!("/tracker/items/{id}"),
        web(json!({ "status": "in_progress", "labels": ["Physics"] })),
    )
    .await)
    .await;
    let e = &r["event"];
    let e = if e.is_null() {
        r["events"].as_array().unwrap().last().unwrap()
    } else {
        e
    };
    assert_eq!(e["agent"], "Owner");
    assert_eq!(e["surface"], "web");
    assert_eq!(e["fields"]["status"], "in_progress");
    assert_eq!(e["before"], json!({ "status": "pending", "labels": [] }));
    let rec = ok(get(&t.app, &format!("/tracker/items/{id}")).await).await;
    let events = rec["events"].as_array().unwrap();
    assert!(events.iter().all(|e| e["agent"] == "Owner"), "{events:?}");
    assert_eq!(
        events[0]["before"],
        json!(null),
        "a create has no prior values"
    );
    // An agent's write without a name is still Unknown, never Owner.
    ok(post(
        &t.app,
        &format!("/tracker/items/{id}"),
        json!({ "note": "agent note", "author_email": "dev@example.com", "surface": "mcp" }),
    )
    .await)
    .await;
    let rec = ok(get(&t.app, &format!("/tracker/items/{id}")).await).await;
    assert_eq!(
        rec["events"].as_array().unwrap().last().unwrap()["agent"],
        "Unknown"
    );
}

// ---- Requests (rag-t0044) ---------------------------------------------------------

#[tokio::test]
async fn a_request_has_its_own_section_and_its_tickets_link_back() {
    let t = app().await;
    let a = item(&t.app, "p", "queued work").await;
    let r = ok(post(
        &t.app,
        "/tracker/p/items",
        json!({
            "type": "request", "title": "Weather", "body": "Rain, then snow. Before audio.",
            "approval": "owner", "author_email": "owner@example.com", "surface": "web"
        }),
    )
    .await)
    .await;
    let rid = r["id"].as_str().unwrap().to_string();
    assert_eq!(r["type"], "request");
    assert_eq!(r["events"][0]["agent"], "Owner");
    let q = ok(get(&t.app, "/tracker/p").await).await;
    assert_eq!(ids(&q["requests"]), vec![rid.clone()]);
    assert_eq!(ids(&q["queue"]), vec![a.clone()]);
    let projects = ok(get(&t.app, "/tracker/projects").await).await;
    assert_eq!(projects["projects"][0]["requests"], 1);

    // A ticket from the request: agent-approved unless it says otherwise.
    let tk = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({
            "type": "design", "title": "Rain art",
            "links": [{ "kind": "from", "target": rid }]
        })),
    )
    .await)
    .await;
    assert_eq!(tk["approval"], "agent");
    assert_eq!(tk["links"], json!([{ "kind": "from", "target": rid }]));
    let owner = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({
            "type": "dev", "title": "Snow", "approval": "owner",
            "links": [{ "kind": "from", "target": rid }], "before": a
        })),
    )
    .await)
    .await;
    assert_eq!(owner["approval"], "owner");
    // Without a from link the default stays unapproved.
    let plain = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "x" })),
    )
    .await)
    .await;
    assert_eq!(plain["approval"], "unapproved");

    let req = ok(get(&t.app, &format!("/tracker/items/{rid}")).await).await;
    let became: Vec<&str> = req["links"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|l| l["kind"] == "became")
        .map(|l| l["target"].as_str().unwrap())
        .collect();
    assert_eq!(
        became,
        vec![tk["id"].as_str().unwrap(), owner["id"].as_str().unwrap()]
    );
    // Done with a note naming them; it leaves the requests for Done.
    ok(post(
        &t.app,
        &format!("/tracker/items/{rid}"),
        w(json!({ "status": "done", "note": "Became the two tickets." })),
    )
    .await)
    .await;
    let q = ok(get(&t.app, "/tracker/p").await).await;
    assert!(q["requests"].as_array().unwrap().is_empty());
    assert!(ids(&q["done"]).contains(&rid));
    let check = ok(get(&t.app, "/tracker/p/check").await).await;
    assert_eq!(check["ok"], true, "{check}");
}

#[tokio::test]
async fn request_writes_are_refused_where_they_do_not_belong() {
    let t = app().await;
    let a = item(&t.app, "p", "a").await;
    for (body, why) in [
        (
            json!({ "type": "request", "title": "r", "parallel": true }),
            "a request cannot be parallel",
        ),
        (
            json!({ "type": "request", "title": "r", "intensity": "quick" }),
            "gate fields",
        ),
        (
            json!({ "type": "dev", "title": "t", "links": [{ "kind": "from", "target": a }] }),
            "names a request",
        ),
        (
            json!({ "type": "dev", "title": "t", "links": [{ "kind": "became", "target": a }] }),
            "written by the server",
        ),
    ] {
        let r = post(&t.app, "/tracker/p/items", w(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{why}");
        assert!(r.error().contains(why), "{why}: {}", r.error());
    }
    let r = post(
        &t.app,
        &format!("/tracker/items/{a}"),
        w(json!({ "add_links": [{ "kind": "became", "target": a }] })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("written by the server"), "{}", r.error());
}

// ---- The roadmap (spec:roadmap m02) ---------------------------------------------------

/// A new planned phase's id.
async fn phase(app: &Router, project: &str, title: &str) -> String {
    let r = ok(post(
        app,
        &format!("/tracker/{project}/phases"),
        w(json!({ "title": title })),
    )
    .await)
    .await;
    r["id"].as_str().unwrap().to_string()
}

/// A new ticket's id, created in `phase_id`.
async fn in_phase(app: &Router, project: &str, phase_id: &str, title: &str) -> String {
    let r = ok(post(
        app,
        &format!("/tracker/{project}/items"),
        w(json!({ "type": "dev", "title": title, "phase": phase_id })),
    )
    .await)
    .await;
    r["id"].as_str().unwrap().to_string()
}

async fn ticket(app: &Router, id: &str) -> Value {
    ok(get(app, &format!("/tracker/items/{id}")).await).await
}

/// The integrity check, which must pass.
async fn sound(app: &Router, project: &str) -> Value {
    let v = ok(get(app, &format!("/tracker/{project}/check")).await).await;
    assert_eq!(v["ok"], true, "{v}");
    v
}

fn last_event(v: &Value) -> &Value {
    v["events"].as_array().unwrap().last().unwrap()
}

#[tokio::test]
async fn every_phase_route_answers() {
    let t = app().await;
    let a = phase(&t.app, "p", "Creatures").await;
    let b = phase(&t.app, "p", "Weather").await;
    assert_eq!((a.as_str(), b.as_str()), ("p-p0001", "p-p0002"));
    let uri = |tail: &str| format!("/tracker/p/phases/{a}{tail}");

    let v = ok(get(&t.app, "/tracker/p/roadmap").await).await;
    assert_eq!(ids(&v["planned"]), vec![a.clone(), b.clone()]);

    let v = ok(get(&t.app, &uri("")).await).await;
    assert_eq!(v["title"], "Creatures");

    let v = ok(post(
        &t.app,
        &uri(""),
        w(json!({ "title": "Beasts", "body": "Big ones." })),
    )
    .await)
    .await;
    assert_eq!(
        (&v["title"], &v["body"]),
        (&json!("Beasts"), &json!("Big ones."))
    );
    assert_eq!(last_event(&v)["kind"], "edit");

    let v = ok(post(&t.app, &uri("/move"), w(json!({ "after": b }))).await).await;
    assert_eq!(v["prev_id"], json!(b));
    assert_eq!(v["next_id"], Value::Null);
    assert_eq!(last_event(&v)["kind"], "move");

    let v = ok(post(&t.app, &uri("/release"), w(json!({ "note": "Go." }))).await).await;
    assert_eq!(v["state"], "released");
    assert!(v["released_at"].is_string(), "{v}");
    assert_eq!(v["moved"], 0);
    assert_eq!(v["placed"], "bottom");
    assert_eq!(v["waiting"], json!([]));
    assert_eq!(last_event(&v)["kind"], "release");
    assert_eq!(last_event(&v)["body"], "Phase released. Go.");

    let v = ok(post(&t.app, &uri("/recall"), w(json!({}))).await).await;
    assert_eq!(v["state"], "planned");
    assert!(v["released_at"].is_null(), "{v}");
    assert_eq!(v["moved"], 0);
    assert!(v["placed"].is_null(), "{v}");
    assert_eq!(v["next_id"], json!(b), "a recall joins the roadmap's top");
    assert_eq!(last_event(&v)["kind"], "recall");
    assert_eq!(last_event(&v)["body"], "Phase recalled.");

    let v = ok(post(&t.app, &uri("/archive"), w(json!({}))).await).await;
    assert_eq!(v["state"], "archived");
    assert_eq!(last_event(&v)["fields"]["state"], "archived");

    let v = ok(post(&t.app, &uri("/unarchive"), w(json!({}))).await).await;
    assert_eq!(v["state"], "planned");
    assert_eq!(v["prev_id"], json!(b), "unarchived, it joins the bottom");
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn a_phase_of_another_project_or_none_is_a_404_on_every_route() {
    let t = app().await;
    let a = phase(&t.app, "p", "Creatures").await;
    phase(&t.app, "q", "Theirs").await;
    let before = ok(get(&t.app, &format!("/tracker/p/phases/{a}")).await).await;
    for (project, id) in [("q", a.as_str()), ("nobody", a.as_str()), ("p", "p-p0099")] {
        let uri = format!("/tracker/{project}/phases/{id}");
        let want = format!("no phase {id:?} in project {project}");
        let r = get(&t.app, &uri).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(r.error(), want);
        for (tail, body) in [
            ("", json!({ "title": "Stolen" })),
            ("/move", json!({ "top": true })),
            ("/release", json!({})),
            ("/recall", json!({})),
            ("/archive", json!({})),
            ("/unarchive", json!({})),
        ] {
            let r = post(&t.app, &format!("{uri}{tail}"), w(body)).await;
            assert_eq!(r.status, StatusCode::NOT_FOUND, "{uri}{tail}");
            assert_eq!(r.error(), want, "{uri}{tail}");
        }
    }
    let after = ok(get(&t.app, &format!("/tracker/p/phases/{a}")).await).await;
    assert_eq!(after, before, "a refused write changed the phase");
}

#[tokio::test]
async fn phase_routes_validate_the_project_name() {
    let t = app().await;
    for uri in ["/tracker/Bad!/roadmap", "/tracker/Bad!/phases/x"] {
        let r = get(&t.app, uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
    for (uri, body) in [
        ("/tracker/Bad!/phases", json!({ "title": "x" })),
        ("/tracker/Bad!/phases/x", json!({ "title": "x" })),
        ("/tracker/Bad!/phases/x/move", json!({ "top": true })),
        ("/tracker/Bad!/phases/x/release", json!({})),
        ("/tracker/Bad!/phases/x/recall", json!({})),
        ("/tracker/Bad!/phases/x/archive", json!({})),
        ("/tracker/Bad!/phases/x/unarchive", json!({})),
    ] {
        let r = post(&t.app, uri, w(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
        assert!(
            r.error().contains("invalid project"),
            "{uri}: {}",
            r.error()
        );
    }
}

#[tokio::test]
async fn a_phase_read_has_its_shape_and_tickets_only_when_asked() {
    let t = app().await;
    let r = ok(post(
        &t.app,
        "/tracker/p/phases",
        w(json!({ "title": "Creatures", "body": "Many." })),
    )
    .await)
    .await;
    assert_eq!(r["id"], "p-p0001");
    assert_eq!(r["project"], "p");
    assert_eq!(r["state"], "planned");
    assert_eq!(last_event(&r)["kind"], "create");

    let v = ok(get(&t.app, "/tracker/p/phases/p-p0001").await).await;
    // m03 tells a phase from a ticket by this key: it is there even while null.
    assert!(v.as_object().unwrap().contains_key("released_at"), "{v}");
    assert!(v["released_at"].is_null());
    assert_eq!(
        v["size"],
        json!({ "frozen": 0, "open": 0, "done": 0, "cancelled": 0, "drafts": 0, "blocked": 0,
                "total": 0, "complete": false })
    );
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
    assert!(v.get("tickets").is_none(), "{v}");
    assert!(v.get("would_wait").is_none(), "{v}");

    let f = in_phase(&t.app, "p", "p-p0001", "Wolf").await;
    let v = ok(get(&t.app, "/tracker/p/phases/p-p0001?tickets=true").await).await;
    assert_eq!(ids(&v["tickets"]), vec![f]);
    assert_eq!(v["would_wait"], json!([]));
    assert_eq!(v["size"]["frozen"], 1);
    assert_eq!(v["size"]["total"], 1);
    assert_eq!(v["head_id"], v["tail_id"]);

    let v = ok(get(&t.app, "/tracker/p/phases/p-p0001?history=false").await).await;
    assert_eq!(v["events"], json!([]));
    for uri in [
        "/tracker/p/phases/p-p0001?ticket=true",
        "/tracker/p/phases/p-p0001?tickets=maybe",
    ] {
        let r = get(&t.app, uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
}

#[tokio::test]
async fn phase_writes_are_refused_when_wrong() {
    let t = app().await;
    for (body, says) in [
        (json!({}), "title"),
        (json!({ "title": "   " }), "title"),
        (json!({ "title": "x", "colour": "red" }), "colour"),
        (
            json!({ "title": "x", "top": true, "bottom": true }),
            "at most one",
        ),
        (json!({ "title": "x", "before": "p-p0099" }), "no phase"),
    ] {
        let r = post(&t.app, "/tracker/p/phases", w(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{says}");
        assert!(r.error().contains(says), "{says}: {}", r.error());
    }
    let r = post(&t.app, "/tracker/p/phases", json!({ "title": "x" })).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "the author fields");

    // A refused create took no id.
    let a = phase(&t.app, "p", "Creatures").await;
    assert_eq!(a, "p-p0001");
    let f = in_phase(&t.app, "p", &a, "Wolf").await;
    let uri = |tail: &str| format!("/tracker/p/phases/{a}{tail}");

    for (tail, body, says) in [
        ("", json!({}), "nothing to update"),
        ("", json!({ "title": "x", "state": "released" }), "state"),
        ("/move", json!({}), "a move needs one of"),
        ("/move", json!({ "after": a }), "relative to itself"),
        ("/move", json!({ "before": "p-p0099" }), "no phase"),
        ("/release", json!({ "colour": "red" }), "colour"),
        (
            "/release",
            json!({ "top": true, "bottom": true }),
            "at most one",
        ),
        ("/release", json!({ "before": "p-t0099" }), "no ticket"),
        ("/recall", json!({ "top": true }), "top"),
        ("/recall", json!({}), "only a released phase"),
        ("/archive", json!({}), "1 open ticket"),
        ("/unarchive", json!({}), "only an archived phase"),
    ] {
        let r = post(&t.app, &uri(tail), w(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{tail}: {says}");
        assert!(r.error().contains(says), "{tail} {says}: {}", r.error());
    }

    ok(post(&t.app, &uri("/release"), w(json!({}))).await).await;
    for (tail, body, says) in [
        ("/move", json!({ "top": true }), "only a planned phase"),
        ("/release", json!({}), "only a planned phase"),
    ] {
        let r = post(&t.app, &uri(tail), w(body)).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{tail}");
        assert!(r.error().contains(says), "{tail}: {}", r.error());
    }
    ok(post(&t.app, &uri("/archive"), w(json!({}))).await).await;
    let r = post(&t.app, &uri("/archive"), w(json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("already archived"), "{}", r.error());
    assert_eq!(ticket(&t.app, &f).await["queued"], true);
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn every_phase_update_is_a_post_and_patch_is_a_405() {
    let t = app().await;
    let a = phase(&t.app, "p", "Creatures").await;
    let req = Request::builder()
        .method(Method::PATCH)
        .uri(format!("/tracker/p/phases/{a}"))
        .header("content-type", "application/json")
        .body(Body::from(w(json!({ "title": "x" })).to_string()))
        .unwrap();
    assert_eq!(
        send(&t.app, req).await.status,
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[tokio::test]
async fn each_phase_write_touches_the_reconcile_trigger_and_no_read_or_refusal_does() {
    let dir = tempfile::tempdir().unwrap();
    let store = TrackerStore::open(dir.path().join("tracker.db"), dir.path().join("att"))
        .await
        .unwrap();
    let trigger = dir.path().join("tracker-reindex");
    let app = router(Some(store), Some(trigger.clone()));
    // Whether it fired since the last look, ready for the next.
    let fired = || {
        let yes = trigger.exists();
        if yes {
            std::fs::remove_file(&trigger).unwrap();
        }
        yes
    };

    let r = post(&app, "/tracker/p/phases", w(json!({ "title": " " }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(!fired(), "a refused create");
    ok(post(&app, "/tracker/p/phases", w(json!({ "title": "A" }))).await).await;
    assert!(fired(), "a create");

    let id = "p-p0001";
    let uri = |tail: &str| format!("/tracker/p/phases/{id}{tail}");
    for read in [
        "/tracker/p/roadmap".to_string(),
        uri(""),
        uri("?tickets=true"),
        "/tracker/p/items?phase=p-p0001".to_string(),
    ] {
        ok(get(&app, &read).await).await;
        assert!(!fired(), "{read}");
    }
    let r = post(
        &app,
        &format!("/tracker/q/phases/{id}/release"),
        w(json!({})),
    )
    .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    assert!(!fired(), "a phase of another project");
    let r = post(&app, &uri("/recall"), w(json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(!fired(), "a refused recall");

    for (tail, body) in [
        ("", json!({ "title": "B" })),
        ("/move", json!({ "top": true })),
        ("/release", json!({})),
        ("/recall", json!({})),
        ("/archive", json!({})),
        ("/unarchive", json!({})),
    ] {
        ok(post(&app, &uri(tail), w(body)).await).await;
        assert!(fired(), "{tail}");
    }
}

#[tokio::test]
async fn a_release_and_a_recall_say_what_they_moved_and_where() {
    let t = app().await;
    let q1 = item(&t.app, "p", "q1").await;
    let q2 = item(&t.app, "p", "q2").await;
    let a = phase(&t.app, "p", "Creatures").await;
    let f1 = in_phase(&t.app, "p", &a, "f1").await;
    let f2 = in_phase(&t.app, "p", &a, "f2").await;
    let f3 = in_phase(&t.app, "p", &a, "f3").await;
    let release = format!("/tracker/p/phases/{a}/release");
    let recall = format!("/tracker/p/phases/{a}/recall");

    let v = ok(post(&t.app, &release, w(json!({ "top": true }))).await).await;
    assert_eq!((&v["moved"], &v["placed"]), (&json!(3), &json!("top")));
    assert_eq!(v["waiting"], json!([]));
    assert_eq!(v["state"], "released");
    let c = sound(&t.app, "p").await;
    assert_eq!(c["order"], json!([f1, f2, f3, q1, q2]));
    assert_eq!(c["frozen"], 0);
    assert_eq!(ticket(&t.app, &f1).await["frozen"], false);
    assert_eq!(ticket(&t.app, &f1).await["phase"], json!(a));

    let v = ok(post(&t.app, &recall, w(json!({}))).await).await;
    assert_eq!(v["moved"], 3);
    assert!(v["placed"].is_null(), "{v}");
    assert_eq!(v["waiting"], json!([]));
    assert_eq!((&v["head_id"], &v["tail_id"]), (&json!(f1), &json!(f3)));
    let c = sound(&t.app, "p").await;
    assert_eq!(c["order"], json!([q1, q2]));
    assert_eq!(c["frozen"], 3);

    let v = ok(post(&t.app, &release, w(json!({ "before": q2 }))).await).await;
    assert_eq!(v["placed"], json!(format!("before {q2}")));
    let c = sound(&t.app, "p").await;
    assert_eq!(c["order"], json!([q1, f1, f2, f3, q2]));
    ok(post(&t.app, &recall, w(json!({}))).await).await;

    // A frozen anchor is refused, and nothing changed.
    let b = phase(&t.app, "p", "Weather").await;
    let g = in_phase(&t.app, "p", &b, "g").await;
    let before = sound(&t.app, "p").await;
    let r = post(&t.app, &release, w(json!({ "before": g }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("frozen"), "{}", r.error());
    assert_eq!(sound(&t.app, "p").await, before);
    let v = ok(get(&t.app, &format!("/tracker/p/phases/{a}")).await).await;
    assert_eq!(v["state"], "planned");

    // The default is the bottom, and a recall leaves what is under way.
    let v = ok(post(&t.app, &release, w(json!({}))).await).await;
    assert_eq!(v["placed"], "bottom");
    assert_eq!(
        sound(&t.app, "p").await["order"],
        json!([q1, q2, f1, f2, f3])
    );
    ok(post(
        &t.app,
        &format!("/tracker/items/{f1}"),
        w(json!({ "status": "in_progress" })),
    )
    .await)
    .await;
    let v = ok(post(&t.app, &recall, w(json!({}))).await).await;
    assert_eq!(v["moved"], 2);
    assert_eq!(sound(&t.app, "p").await["order"], json!([q1, q2, f1]));
    let v = ok(get(&t.app, &format!("/tracker/p/phases/{a}?tickets=true")).await).await;
    assert_eq!(ids(&v["tickets"]), vec![f2, f3, f1]);

    let r = post(&t.app, &recall, w(json!({}))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn a_release_and_a_recall_name_what_is_left_waiting_as_the_read_said() {
    let t = app().await;
    let a = phase(&t.app, "p", "Creatures").await;
    let b = phase(&t.app, "p", "Weather").await;
    let h = in_phase(&t.app, "p", &a, "h").await;
    let g = in_phase(&t.app, "p", &b, "g").await;
    let y = item(&t.app, "p", "y").await;
    for waiter in [&h, &y] {
        ok(post(
            &t.app,
            &format!("/tracker/items/{waiter}"),
            w(json!({ "blocked": true, "block_reason": "dependency", "depends_on": [g] })),
        )
        .await)
        .await;
    }
    let h_on_g = json!({ "ticket": h, "on": g });
    let y_on_g = json!({ "ticket": y, "on": g });

    let read = ok(get(&t.app, &format!("/tracker/p/phases/{a}?tickets=true")).await).await;
    assert_eq!(read["would_wait"], json!([h_on_g]));
    let v = ok(post(
        &t.app,
        &format!("/tracker/p/phases/{a}/release"),
        w(json!({})),
    )
    .await)
    .await;
    assert_eq!(v["waiting"], json!([h_on_g]));

    let v = ok(post(
        &t.app,
        &format!("/tracker/p/phases/{b}/release"),
        w(json!({})),
    )
    .await)
    .await;
    assert_eq!(v["waiting"], json!([]));

    let read = ok(get(&t.app, &format!("/tracker/p/phases/{b}?tickets=true")).await).await;
    assert_eq!(read["would_wait"], json!([h_on_g, y_on_g]));
    let v = ok(post(
        &t.app,
        &format!("/tracker/p/phases/{b}/recall"),
        w(json!({})),
    )
    .await)
    .await;
    assert_eq!(v["waiting"], json!([h_on_g, y_on_g]));
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn a_ticket_is_created_in_a_phase_as_its_state_says() {
    let t = app().await;
    let planned = phase(&t.app, "p", "Planned").await;
    let released = phase(&t.app, "p", "Released").await;
    let archived = phase(&t.app, "p", "Archived").await;
    ok(post(
        &t.app,
        &format!("/tracker/p/phases/{released}/release"),
        w(json!({})),
    )
    .await)
    .await;
    ok(post(
        &t.app,
        &format!("/tracker/p/phases/{archived}/archive"),
        w(json!({})),
    )
    .await)
    .await;
    let q = item(&t.app, "p", "q").await;

    let create = |body: Value| post(&t.app, "/tracker/p/items", w(body));

    let v = ok(create(json!({ "type": "dev", "title": "a", "phase": planned })).await).await;
    assert_eq!(v["frozen"], true);
    assert_eq!(v["queued"], false);
    assert_eq!(v["phase"], json!(planned));
    assert_eq!(v["approval"], "unapproved");
    let first = v["id"].clone();
    // A place names a place in the phase's list, and a phase id is trimmed.
    let v = ok(create(
        json!({ "type": "dev", "title": "b", "phase": format!(" {planned} "), "before": first }),
    )
    .await)
    .await;
    assert_eq!(v["next_id"], first);
    assert_eq!(v["phase"], json!(planned));
    assert_eq!(sound(&t.app, "p").await["order"], json!([q]));

    let v =
        ok(create(json!({ "type": "dev", "title": "c", "phase": released, "before": q })).await)
            .await;
    assert_eq!(v["frozen"], false);
    assert_eq!(v["queued"], true);
    assert_eq!(v["phase"], json!(released));
    assert_eq!(v["next_id"], json!(q));
    assert_eq!(sound(&t.app, "p").await["order"], json!([v["id"], q]));

    for (body, status, says) in [
        (
            json!({ "type": "dev", "title": "x", "phase": archived }),
            StatusCode::BAD_REQUEST,
            "archived",
        ),
        (
            json!({ "type": "request", "title": "x", "phase": planned }),
            StatusCode::BAD_REQUEST,
            "a request cannot have a phase",
        ),
        (
            json!({ "type": "dev", "title": "x", "phase": "" }),
            StatusCode::BAD_REQUEST,
            "phase is a phase id",
        ),
        (
            json!({ "type": "dev", "title": "x", "phase": "   " }),
            StatusCode::BAD_REQUEST,
            "phase is a phase id",
        ),
        (
            json!({ "type": "dev", "title": "x", "phase": "p-p0099" }),
            StatusCode::NOT_FOUND,
            "no phase",
        ),
        (
            json!({ "type": "dev", "title": "x", "phase": planned, "before": q }),
            StatusCode::BAD_REQUEST,
            "is not in phase",
        ),
    ] {
        let r = create(body).await;
        assert_eq!(r.status, status, "{says}");
        assert!(r.error().contains(says), "{says}: {}", r.error());
    }
    // Another project's phase is no phase of this one.
    let r = post(
        &t.app,
        "/tracker/q/items",
        w(json!({ "type": "dev", "title": "x", "phase": planned })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("belongs to project"), "{}", r.error());
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn phase_and_frozen_are_written_alone() {
    let t = app().await;
    let a = phase(&t.app, "p", "Creatures").await;
    let id = item(&t.app, "p", "t").await;
    let uri = format!("/tracker/items/{id}");

    let v = ok(post(&t.app, &uri, w(json!({ "phase": a }))).await).await;
    assert_eq!((&v["frozen"], &v["queued"]), (&json!(true), &json!(false)));
    assert_eq!(v["phase"], json!(a));
    assert_eq!(last_event(&v)["kind"], "move");
    assert_eq!(last_event(&v)["roadmap"], true);

    let v = ok(post(&t.app, &uri, w(json!({ "frozen": false }))).await).await;
    assert_eq!((&v["frozen"], &v["queued"]), (&json!(false), &json!(true)));
    assert_eq!(v["phase"], json!(a), "a pull keeps the link");

    let v = ok(post(&t.app, &uri, w(json!({ "frozen": true }))).await).await;
    assert_eq!(v["frozen"], true);

    // Blank is a clear, and a frozen ticket then joins the queue.
    let v = ok(post(&t.app, &uri, w(json!({ "phase": "  " }))).await).await;
    assert!(v["phase"].is_null(), "{v}");
    assert_eq!((&v["frozen"], &v["queued"]), (&json!(false), &json!(true)));

    // A note may stand beside it, and is the event's body.
    let v = ok(post(&t.app, &uri, w(json!({ "phase": a, "note": "Later." }))).await).await;
    assert_eq!(last_event(&v)["body"], "Later.");

    let before = ticket(&t.app, &id).await;
    let refused = "phase and frozen are written alone, with at most a note";
    let r = post(&t.app, &uri, w(json!({ "phase": a, "frozen": true }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert_eq!(r.error(), refused);
    for (field, value) in [
        ("status", json!("in_progress")),
        ("blocked", json!(false)),
        ("block_reason", json!("review")),
        ("depends_on", json!([])),
        ("approval", json!("agent")),
        ("assignee", json!("dev")),
        ("title", json!("New")),
        ("body", json!("New")),
        (
            "add_links",
            json!([{ "kind": "ledger", "target": "rag-l0001" }]),
        ),
        (
            "remove_links",
            json!([{ "kind": "ledger", "target": "rag-l0001" }]),
        ),
        ("intensity", json!("quick")),
        ("release", json!(true)),
        ("parallel", json!(true)),
        ("labels", json!(["New"])),
        ("draft", json!(true)),
    ] {
        for mut body in [
            json!({ "phase": a }),
            json!({ "phase": "" }),
            json!({ "frozen": true }),
            json!({ "frozen": false }),
        ] {
            body[field] = value.clone();
            let r = post(&t.app, &uri, w(body.clone())).await;
            assert_eq!(r.status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(r.error(), refused, "{body}");
        }
    }
    assert_eq!(ticket(&t.app, &id).await, before, "a refusal changed it");

    // The store's refusals, and its missing records.
    let closed = item(&t.app, "p", "closed").await;
    start_and_finish(&t.app, &closed).await;
    let r = post(
        &t.app,
        &format!("/tracker/items/{closed}"),
        w(json!({ "phase": a })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(
        r.error().contains("only a pending or deferred ticket"),
        "{}",
        r.error()
    );

    // A deferred ticket freezes, resumed by the same write.
    let put_aside = item(&t.app, "p", "put aside").await;
    let aside = format!("/tracker/items/{put_aside}");
    let r = post(&t.app, &aside, w(json!({ "status": "deferred" }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.error());
    let r = post(&t.app, &aside, w(json!({ "phase": a }))).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.error());
    let frozen = ticket(&t.app, &put_aside).await;
    assert_eq!(frozen["status"], json!("pending"));
    assert_eq!(frozen["frozen"], json!(true));
    sound(&t.app, "p").await;

    let r = post(&t.app, &uri, w(json!({ "phase": "p-p0099" }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = post(&t.app, "/tracker/items/p-t0099", w(json!({ "phase": a }))).await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let theirs = phase(&t.app, "q", "Theirs").await;
    let r = post(&t.app, &uri, w(json!({ "phase": theirs }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("belongs to project"), "{}", r.error());
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn a_frozen_ticket_goes_only_to_done_or_cancelled_and_moves_only_in_its_phase() {
    let t = app().await;
    let q = item(&t.app, "p", "q").await;
    let a = phase(&t.app, "p", "Creatures").await;
    let f = in_phase(&t.app, "p", &a, "f").await;
    let g = in_phase(&t.app, "p", &a, "g").await;
    let uri = format!("/tracker/items/{f}");

    let before = ticket(&t.app, &f).await;
    for status in ["in_progress", "deferred", "review", "failed"] {
        let r = post(&t.app, &uri, w(json!({ "status": status }))).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{status}");
        assert!(
            r.error().contains("pull it to the queue first"),
            "{status}: {}",
            r.error()
        );
    }
    assert_eq!(ticket(&t.app, &f).await, before);

    // Moves: within its own list, either way.
    let r = post(&t.app, &format!("{uri}/move"), w(json!({ "before": q }))).await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("is not in phase"), "{}", r.error());
    let r = post(
        &t.app,
        &format!("/tracker/items/{q}/move"),
        w(json!({ "before": f })),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
    assert!(r.error().contains("frozen"), "{}", r.error());
    let v = ok(post(&t.app, &format!("{uri}/move"), w(json!({ "after": g }))).await).await;
    assert_eq!(v["prev_id"], json!(g));

    let v = ok(post(&t.app, &uri, w(json!({ "status": "done" }))).await).await;
    assert_eq!(v["frozen"], false);
    assert_eq!(v["phase"], json!(a), "done keeps the link");
    sound(&t.app, "p").await;
}

#[tokio::test]
async fn the_items_list_leaves_frozen_tickets_out_unless_it_names_their_phase() {
    let t = app().await;
    let q = item(&t.app, "p", "q").await;
    let a = phase(&t.app, "p", "Creatures").await;
    let f = in_phase(&t.app, "p", &a, "f").await;
    let g = in_phase(&t.app, "p", &a, "g").await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{g}"),
        w(json!({ "labels": ["Physics"] })),
    )
    .await)
    .await;
    ok(post(
        &t.app,
        &format!("/tracker/items/{g}/move"),
        w(json!({ "top": true })),
    )
    .await)
    .await;

    let list = |query: String| {
        let app = t.app.clone();
        async move {
            let v = ok(get(&app, &format!("/tracker/p/items{query}")).await).await;
            ids(&v["items"])
        }
    };
    assert_eq!(list(String::new()).await, vec![q.clone()]);
    assert_eq!(list("?status=pending".into()).await, vec![q.clone()]);
    // In the phase's own order, not by age.
    assert_eq!(
        list(format!("?phase={a}")).await,
        vec![g.clone(), f.clone()]
    );
    assert_eq!(
        list(format!("?phase={a}&status=pending")).await,
        vec![g.clone(), f.clone()]
    );
    assert_eq!(
        list(format!("?phase={a}&status=done")).await,
        Vec::<String>::new()
    );
    assert_eq!(
        list(format!("?phase={a}&label=physics")).await,
        vec![g.clone()]
    );

    for uri in [
        "/tracker/p/items?phase=p-p0099".to_string(),
        "/tracker/p/items?phase=".to_string(),
        format!("/tracker/q/items?phase={a}"),
    ] {
        let r = get(&t.app, &uri).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{uri}");
    }
    let r = get(
        &t.app,
        &format!("/tracker/p/items?phase={a}&status=blocked"),
    )
    .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_frozen_ticket_is_in_no_queue_figure_but_frozen() {
    let t = app().await;
    let q = item(&t.app, "p", "q").await;
    let mut before = ok(get(&t.app, "/tracker/p").await).await;
    assert_eq!(before["frozen"], 0);

    let a = phase(&t.app, "p", "Creatures").await;
    in_phase(&t.app, "p", &a, "f").await;
    let v = ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "d", "phase": a, "draft": true, "labels": ["Physics"] })),
    )
    .await)
    .await;
    assert_eq!((&v["frozen"], &v["draft"]), (&json!(true), &json!(true)));

    // The view is what it was, but for `frozen`.
    let view = ok(get(&t.app, "/tracker/p").await).await;
    assert_eq!(view["frozen"], 2);
    before["frozen"] = json!(2);
    assert_eq!(view, before);

    let projects = ok(get(&t.app, "/tracker/projects").await).await;
    let row = &projects["projects"][0];
    assert_eq!(row["name"], "p");
    assert_eq!(row["frozen"], 2);
    assert_eq!(row["queued"], 1, "a frozen draft is not queued");
    assert_eq!(row["drafts"], 0, "a frozen draft is not among the drafts");

    let c = sound(&t.app, "p").await;
    assert_eq!(c["frozen"], 2);
    assert_eq!(c["queued"], 1);
    assert_eq!(c["order"], json!([q]));

    let labels = ok(get(&t.app, "/tracker/p/labels").await).await;
    assert_eq!(
        labels["labels"],
        json!([{ "label": "Physics", "count": 1, "queued": 0 }])
    );
    let v = ok(get(&t.app, "/tracker/p/velocity").await).await;
    assert_eq!(v["remaining"], 1);
}

#[tokio::test]
async fn the_roadmap_read_answers_each_window_and_every_key_on_an_empty_project() {
    let t = app().await;
    for (uri, window) in [
        ("/tracker/p/roadmap?window=24h", "24h"),
        ("/tracker/p/roadmap?window=7d", "7d"),
        ("/tracker/p/roadmap", "7d"),
    ] {
        let r = get(&t.app, uri).await;
        assert_eq!(r.status, StatusCode::OK, "{uri}");
        assert_eq!(r.headers.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert!(r.headers.get(header::ETAG).is_none(), "{uri}");
        let v = r.json();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "archived",
                "complete",
                "frozen",
                "now",
                "planned",
                "planned_out_days",
                "project",
                "queue",
                "released",
                "velocity_per_day",
                "window",
            ]
        );
        assert_eq!(v["project"], "p");
        assert_eq!(v["window"], window);
        assert_eq!(v["frozen"], 0);
        assert_eq!(v["queue"]["remaining"], 0);
        assert!(v["queue"].as_object().unwrap().contains_key("eta_days"));
        for list in ["released", "planned", "complete", "archived"] {
            assert_eq!(v[list], json!([]), "{list}");
        }
    }
    for uri in [
        "/tracker/p/roadmap?window=1h",
        "/tracker/p/roadmap?window=",
        "/tracker/p/roadmap?days=7",
    ] {
        let r = get(&t.app, uri).await;
        assert_eq!(r.status, StatusCode::BAD_REQUEST, "{uri}");
    }
    let r = get(&t.app, "/tracker/p/roadmap?window=1h").await;
    assert!(r.error().contains("1h"), "{}", r.error());
}

#[tokio::test]
async fn the_roadmap_read_sorts_each_phase_into_its_list_with_its_figures() {
    let t = app().await;
    // Complete: released, its one ticket done.
    let c = phase(&t.app, "p", "Complete").await;
    let cf = in_phase(&t.app, "p", &c, "cf").await;
    ok(post(
        &t.app,
        &format!("/tracker/p/phases/{c}/release"),
        w(json!({})),
    )
    .await)
    .await;
    start_and_finish(&t.app, &cf).await;
    // Released: one ticket still open.
    let r = phase(&t.app, "p", "Released").await;
    in_phase(&t.app, "p", &r, "rf").await;
    ok(post(
        &t.app,
        &format!("/tracker/p/phases/{r}/release"),
        w(json!({})),
    )
    .await)
    .await;
    // Archived, and planned with one ticket and one draft.
    let x = phase(&t.app, "p", "Archived").await;
    ok(post(
        &t.app,
        &format!("/tracker/p/phases/{x}/archive"),
        w(json!({})),
    )
    .await)
    .await;
    let a = phase(&t.app, "p", "Planned").await;
    in_phase(&t.app, "p", &a, "af").await;
    ok(post(
        &t.app,
        "/tracker/p/items",
        w(json!({ "type": "dev", "title": "ad", "phase": a, "draft": true })),
    )
    .await)
    .await;

    let v = ok(get(&t.app, "/tracker/p/roadmap").await).await;
    assert_eq!(ids(&v["released"]), vec![r]);
    assert_eq!(ids(&v["planned"]), vec![a]);
    assert_eq!(ids(&v["complete"]), vec![c]);
    assert_eq!(ids(&v["archived"]), vec![x]);
    assert_eq!(v["frozen"], 2, "drafts included");
    assert_eq!(v["queue"]["remaining"], 1);

    let planned = &v["planned"][0];
    let mut keys: Vec<&str> = planned
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "ahead",
            "created_at",
            "eta_days",
            "id",
            "project",
            "released_at",
            "size",
            "state",
            "title",
            "updated_at",
        ]
    );
    assert_eq!(
        planned["size"],
        json!({ "frozen": 1, "open": 0, "done": 0, "cancelled": 0, "drafts": 1, "blocked": 0,
                "total": 2, "complete": false })
    );
    // The queue's one, then the phase's one that is counted.
    assert_eq!(planned["ahead"], 2);
    assert_eq!(v["planned_out_days"], planned["eta_days"]);
    assert_eq!(v["released"][0]["ahead"], 1);
    assert_eq!(v["complete"][0]["size"]["complete"], true);
    assert!(v["complete"][0]["eta_days"].is_null());
}
