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
