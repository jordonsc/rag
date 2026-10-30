//! The event feed over a real socket: a server on a loopback port per test, a
//! `tokio-tungstenite` client, writes through the store or the HTTP routes.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::StreamExt;
use rag_core::tracker::{
    Actor, Approval, FeedFilter, ItemType, ItemUpdate, Link, LinkKind, NewItem, NewMilestone,
    NewSpec, Place, Surface, TrackerStore, DEFAULT_FEED_KINDS,
};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{protocol::CloseFrame as WsClose, Message as WsMsg},
    MaybeTlsStream, WebSocketStream,
};

use super::super::router;
use super::MAX_REPLAY;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Server {
    _dir: tempfile::TempDir,
    db: PathBuf,
    store: TrackerStore,
    addr: SocketAddr,
}

async fn server_with(capacity: Option<usize>) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let db = dir.path().join("tracker.db");
    let mut store = TrackerStore::open(&db, dir.path().join("att"))
        .await
        .unwrap();
    if let Some(c) = capacity {
        store = store.with_feed_capacity(c).await;
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(Some(store.clone()), None);
    tokio::spawn(async move { axum::serve(listener, app).await });
    Server {
        _dir: dir,
        db,
        store,
        addr,
    }
}

async fn server() -> Server {
    server_with(None).await
}

/// Open the feed at `/tracker/{path}`, e.g. `p/events/ws?since=0`, one frame
/// per event: these tests pin each event's own frame, so they turn burst
/// coalescing (rag-t0039) off unless the path names a `coalesce` of its own.
async fn connect(s: &Server, path: &str) -> Ws {
    if path.contains("coalesce=") {
        return connect_as_given(s, path).await;
    }
    let sep = if path.contains('?') { '&' } else { '?' };
    connect_as_given(s, &format!("{path}{sep}coalesce=0")).await
}

/// Open the feed at exactly `/tracker/{path}`, the server's defaults applying.
async fn connect_as_given(s: &Server, path: &str) -> Ws {
    let url = format!("ws://{}/tracker/{path}", s.addr);
    let (ws, _) = connect_async(&url)
        .await
        .unwrap_or_else(|e| panic!("{url}: {e}"));
    ws
}

/// The next text frame, skipping control frames. Panics on a close or after 5 s.
async fn next_text(ws: &mut Ws) -> String {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("no frame within 5 s")
            .expect("the socket ended")
            .expect("socket error");
        match msg {
            WsMsg::Text(t) => return t.to_string(),
            WsMsg::Close(c) => panic!("closed: {c:?}"),
            _ => {}
        }
    }
}

/// The close frame the server ends with, skipping anything before it.
async fn next_close(ws: &mut Ws) -> WsClose {
    loop {
        let msg = tokio::time::timeout(Duration::from_secs(5), ws.next())
            .await
            .expect("no close within 5 s")
            .expect("the socket ended without a close frame")
            .expect("socket error");
        if let WsMsg::Close(c) = msg {
            return c.expect("a close frame with a code");
        }
    }
}

/// No text frame arrives within `ms`.
async fn quiet(ws: &mut Ws, ms: u64) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        match tokio::time::timeout_at(deadline, ws.next()).await {
            Err(_) => return,
            Ok(Some(Ok(WsMsg::Text(t)))) => panic!("unexpected frame: {t}"),
            Ok(Some(Ok(_))) => {}
            Ok(other) => panic!("the socket ended: {other:?}"),
        }
    }
}

/// The event id a text frame starts with.
fn id_of(line: &str) -> i64 {
    line.strip_prefix('#')
        .and_then(|l| l.split(' ').next())
        .and_then(|n| n.parse().ok())
        .unwrap_or_else(|| panic!("no event id at the start of {line:?}"))
}

fn web() -> Actor {
    Actor::new("owner@example.com", None, Surface::Web)
}

fn mcp() -> Actor {
    Actor::new("dev@example.com", Some("Claude Test"), Surface::Mcp)
}

fn new_item(project: &str, title: &str) -> NewItem {
    NewItem {
        draft: false,
        project: project.into(),
        item_type: ItemType::Dev,
        title: title.into(),
        body: String::new(),
        assignee: None,
        approval: Approval::Unapproved,
        links: Vec::new(),
        intensity: None,
        release: false,
        parallel: false,
        labels: Vec::new(),
        place: Place::Bottom,
        note: None,
    }
}

async fn add(store: &TrackerStore, project: &str, title: &str, who: &Actor) -> String {
    store
        .create_item(new_item(project, title), who)
        .await
        .unwrap()
        .item
        .id
}

fn http(s: &Server, path: &str) -> String {
    format!("http://{}/tracker/{path}", s.addr)
}

// ---- Replay, live, resume ---------------------------------------------------------

#[tokio::test]
async fn the_feed_replays_after_since_then_sends_each_new_event_live() {
    let s = server().await;
    let a = add(&s.store, "p", "Alpha", &web()).await;
    add(&s.store, "p", "Beta", &web()).await;
    let mut ws = connect(&s, "p/events/ws?since=0").await;
    let first = next_text(&mut ws).await;
    assert!(
        first.starts_with(&format!("#1 p web create {a} \"Alpha\": ")),
        "{first}"
    );
    assert!(first.ends_with(" [Owner]"), "{first}");
    assert_eq!(id_of(&next_text(&mut ws).await), 2);
    quiet(&mut ws, 150).await;
    // Live: published as the write commits.
    let c = add(&s.store, "p", "Gamma", &web()).await;
    let live = next_text(&mut ws).await;
    assert!(
        live.starts_with(&format!("#3 p web create {c} \"Gamma\"")),
        "{live}"
    );
    // `since` is exclusive: resuming from 2 replays 3 alone.
    let mut again = connect(&s, "p/events/ws?since=2").await;
    assert_eq!(id_of(&next_text(&mut again).await), 3);
    quiet(&mut again, 150).await;
}

#[tokio::test]
async fn without_since_the_feed_sends_only_what_comes_next() {
    let s = server().await;
    add(&s.store, "p", "Old", &web()).await;
    let mut ws = connect(&s, "p/events/ws").await;
    quiet(&mut ws, 200).await;
    add(&s.store, "p", "New", &web()).await;
    let line = next_text(&mut ws).await;
    assert!(line.contains("\"New\""), "{line}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_feed_resumed_by_id_loses_and_repeats_nothing_under_concurrent_writes() {
    let s = server().await;
    let writer = {
        let store = s.store.clone();
        tokio::spawn(async move {
            for i in 0..60 {
                let who = if i % 3 == 2 { mcp() } else { web() };
                add(&store, "p", &format!("item {i}"), &who).await;
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
        })
    };
    let mut seen: Vec<i64> = Vec::new();
    // Three connections, each dropped part-way and resumed from the last id seen.
    for _ in 0..3 {
        let since = seen.last().copied().unwrap_or(0);
        let mut ws = connect(&s, &format!("p/events/ws?since={since}")).await;
        for _ in 0..8 {
            seen.push(id_of(&next_text(&mut ws).await));
        }
        ws.close(None).await.ok();
    }
    writer.await.unwrap();
    let expected: Vec<i64> = s
        .store
        .events_after(
            &FeedFilter {
                project: Some("p".into()),
                surfaces: Some(vec![Surface::Web]),
                kinds: Some(DEFAULT_FEED_KINDS.to_vec()),
                drafts: false,
            },
            0,
            None,
        )
        .await
        .unwrap()
        .iter()
        .map(|e| e.event_id)
        .collect();
    assert_eq!(expected.len(), 40);
    let since = *seen.last().unwrap();
    let mut ws = connect(&s, &format!("p/events/ws?since={since}")).await;
    while seen.last() != expected.last() {
        seen.push(id_of(&next_text(&mut ws).await));
    }
    quiet(&mut ws, 150).await;
    assert_eq!(seen, expected);
}

// ---- Filters ------------------------------------------------------------------------

#[tokio::test]
async fn by_default_a_web_write_reaches_the_feed_and_an_mcp_write_does_not() {
    let s = server().await;
    let mut ws = connect(&s, "p/events/ws").await;
    let client = reqwest::Client::new();
    let post = |surface: &'static str, title: &'static str| {
        let client = client.clone();
        let url = http(&s, "p/items");
        async move {
            let mut body = json!({ "type": "dev", "title": title, "author_email": "x@example.com", "surface": surface });
            if surface == "mcp" {
                body["agent"] = json!("Claude Test");
            }
            let r = client.post(url).json(&body).send().await.unwrap();
            assert!(r.status().is_success(), "{}", r.text().await.unwrap());
        }
    };
    post("mcp", "From an agent").await;
    post("web", "From the owner").await;
    let line = next_text(&mut ws).await;
    assert!(
        line.contains(" web create ") && line.contains("\"From the owner\""),
        "{line}"
    );
    quiet(&mut ws, 150).await;

    let mut agents = connect(&s, "p/events/ws?since=0&surface=mcp").await;
    let line = next_text(&mut agents).await;
    assert!(
        line.contains(" mcp create ") && line.ends_with("[Claude Test]"),
        "{line}"
    );
    quiet(&mut agents, 150).await;

    let mut both = connect(&s, "p/events/ws?since=0&surface=any").await;
    assert!(next_text(&mut both).await.contains("From an agent"));
    assert!(next_text(&mut both).await.contains("From the owner"));
}

/// A request the owner files on the web wakes the manager, and its frame says
/// it is a request (rag-t0044); the became link its tickets write is
/// housekeeping and stays out of the default feed.
#[tokio::test]
async fn a_web_request_reaches_the_default_feed_saying_request() {
    let s = server().await;
    let mut ws = connect(&s, "p/events/ws").await;
    let r = s
        .store
        .create_item(
            NewItem {
                item_type: ItemType::Request,
                approval: Approval::Owner,
                ..new_item("p", "Weather")
            },
            &web(),
        )
        .await
        .unwrap()
        .item
        .id;
    let line = next_text(&mut ws).await;
    assert!(
        line.contains(&format!(
            " p web create {r} \"Weather\" {{type: request}}: "
        )),
        "{line}"
    );
    assert!(line.ends_with(" [Owner]"), "{line}");
    s.store
        .create_item(
            NewItem {
                links: vec![Link {
                    kind: LinkKind::From,
                    target: r.clone(),
                }],
                ..new_item("p", "Rain")
            },
            &mcp(),
        )
        .await
        .unwrap();
    quiet(&mut ws, 150).await;
}

#[tokio::test]
async fn kinds_choose_the_events_and_the_default_leaves_out_housekeeping() {
    let s = server().await;
    let a = add(&s.store, "p", "A", &web()).await;
    let b = add(&s.store, "p", "B", &web()).await;
    s.store
        .update_item(
            &a,
            ItemUpdate {
                add_links: vec![Link {
                    kind: LinkKind::Item,
                    target: b.clone(),
                }],
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    s.store
        .update_item(
            &a,
            ItemUpdate {
                approval: Some(Approval::Owner),
                ..Default::default()
            },
            &web(),
        )
        .await
        .unwrap();
    // Default: the two creates and the approval, not the link.
    let mut ws = connect(&s, "p/events/ws?since=0").await;
    let lines = [
        next_text(&mut ws).await,
        next_text(&mut ws).await,
        next_text(&mut ws).await,
    ];
    assert!(lines[0].contains(" create ") && lines[1].contains(" create "));
    assert!(lines[2].contains(&format!(" approve {a} ")), "{}", lines[2]);
    quiet(&mut ws, 150).await;
    // A list picks kinds; `all` is every kind.
    let mut approvals = connect(&s, "p/events/ws?since=0&kinds=approve,%20status").await;
    assert!(next_text(&mut approvals).await.contains(" approve "));
    quiet(&mut approvals, 150).await;
    let mut everything = connect(&s, "p/events/ws?since=0&kinds=all").await;
    let all: Vec<String> = [
        next_text(&mut everything).await,
        next_text(&mut everything).await,
        next_text(&mut everything).await,
        next_text(&mut everything).await,
    ]
    .into();
    assert!(all[2].contains(" link "), "{all:?}");
}

#[tokio::test]
async fn a_project_feed_sends_its_own_project_and_star_sends_every_project() {
    let s = server().await;
    add(&s.store, "p", "In p", &web()).await;
    add(&s.store, "q", "In q", &web()).await;
    let mut p = connect(&s, "p/events/ws?since=0").await;
    assert!(next_text(&mut p).await.contains("\"In p\""));
    quiet(&mut p, 150).await;
    let mut every = connect(&s, "*/events/ws?since=0").await;
    assert!(next_text(&mut every).await.starts_with("#1 p "));
    assert!(next_text(&mut every).await.starts_with("#2 q "));
    add(&s.store, "r", "In r", &web()).await;
    assert!(next_text(&mut every).await.starts_with("#3 r "));
    quiet(&mut p, 100).await;
}

#[tokio::test]
async fn format_json_sends_each_event_as_one_json_line() {
    let s = server().await;
    let a = add(&s.store, "p", "Alpha", &web()).await;
    let mut ws = connect(&s, "p/events/ws?since=0&format=json").await;
    let frame = next_text(&mut ws).await;
    assert!(!frame.contains('\n'));
    let v: Value = serde_json::from_str(&frame).unwrap();
    assert_eq!(v["event_id"], 1);
    assert_eq!(v["project"], "p");
    assert_eq!(v["target_kind"], "item");
    assert_eq!(v["target_id"], a.as_str());
    assert_eq!(v["title"], "Alpha");
    assert_eq!(v["surface"], "web");
    assert_eq!(v["kind"], "create");
    assert_eq!(v["author_email"], "owner@example.com");
    assert!(v["ts"].as_str().unwrap().ends_with('Z'));
}

// ---- Refusals ------------------------------------------------------------------------

#[tokio::test]
async fn bad_feed_requests_are_refused_before_the_upgrade() {
    let s = server().await;
    let client = reqwest::Client::new();
    for (path, status, says) in [
        ("p/events/ws", 426, "WebSocket"),
        ("p/events/ws?surface=owner", 400, "invalid surface"),
        ("p/events/ws?kinds=approve,bogus", 400, "invalid event kind"),
        ("p/events/ws?kinds=,", 400, "kinds names no event kind"),
        ("p/events/ws?format=xml", 400, "invalid format"),
        ("p/events/ws?since=-1", 400, "since"),
        ("p/events/ws?limit=5", 400, "limit is for the one-shot read"),
        ("p/events/ws?sinse=3", 400, "invalid query string"),
        ("Bad!/events/ws", 400, "invalid project name"),
        ("p/events?format=text", 400, "format is for the feed"),
        ("p/events?limit=0", 400, "limit is 1 to"),
        ("p/events/ws?coalesce=61", 400, "coalesce is 0 to 60"),
        ("p/events/ws?coalesce=-1", 400, "invalid query string"),
        (
            "p/events/ws?format=json&coalesce=2",
            400,
            "coalesce is for text frames",
        ),
        (
            "p/events?since=0&coalesce=1",
            400,
            "coalesce is for the feed",
        ),
    ] {
        let r = client.get(http(&s, path)).send().await.unwrap();
        assert_eq!(r.status().as_u16(), status, "{path}");
        let v: Value = r.json().await.unwrap();
        let err = v["error"].as_str().unwrap_or_default();
        assert!(err.contains(says), "{path}: {err}");
    }
}

/// A spec with `n` milestones: one transaction, `1 + 2n + 1` events (the spec,
/// each milestone and each document, the master's included).
async fn spec_with_milestones(store: &TrackerStore, n: usize) {
    store
        .create_spec(
            NewSpec {
                draft: false,
                project: "p".into(),
                slug: "big".into(),
                title: "Big".into(),
                state: None,
                approval: Approval::Unapproved,
                body: String::new(),
                milestones: (1..=n)
                    .map(|i| NewMilestone {
                        draft: false,
                        code: format!("m{i:03}"),
                        title: format!("M {i}"),
                        name: None,
                        state: None,
                        approval: Approval::Unapproved,
                        body: String::new(),
                        note: None,
                    })
                    .collect(),
                note: None,
            },
            &web(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn a_replay_longer_than_the_cap_is_refused_and_paged_by_the_read() {
    let s = server().await;
    spec_with_milestones(&s.store, 250).await;
    let total = s.store.latest_event_id().await.unwrap();
    assert!(total > MAX_REPLAY, "{total}");
    // A WebSocket client is answered 400 instead of the upgrade.
    let url = format!("ws://{}/tracker/p/events/ws?since=0", s.addr);
    match connect_async(&url).await {
        Err(tokio_tungstenite::tungstenite::Error::Http(r)) => assert_eq!(r.status().as_u16(), 400),
        other => panic!("expected a 400, got {:?}", other.map(|_| ())),
    }
    let client = reqwest::Client::new();
    let r = client
        .get(http(&s, "p/events/ws?since=0"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 400);
    let v: Value = r.json().await.unwrap();
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("more than the feed replays"),
        "{v}"
    );
    // The read pages through them and says where to resume.
    let mut since = 0;
    let mut read = 0;
    loop {
        let v: Value = client
            .get(http(&s, &format!("p/events?since={since}&limit=200")))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        read += v["events"].as_array().unwrap().len() as i64;
        since = v["next_since"].as_i64().unwrap();
        if !v["more"].as_bool().unwrap() {
            break;
        }
    }
    assert_eq!(read, total);
    assert_eq!(since, total);
    // From there the feed opens.
    let mut ws = connect(&s, &format!("p/events/ws?since={since}")).await;
    add(&s.store, "p", "Next", &web()).await;
    assert_eq!(id_of(&next_text(&mut ws).await), total + 1);
}

// ---- The one-shot read ------------------------------------------------------------------

#[tokio::test]
async fn the_read_gives_the_starting_id_and_the_events_after_since() {
    let s = server().await;
    add(&s.store, "p", "A", &web()).await;
    add(&s.store, "p", "B", &mcp()).await;
    add(&s.store, "p", "C", &web()).await;
    let client = reqwest::Client::new();
    let get = |path: String| {
        let client = client.clone();
        async move {
            let r = client.get(path).send().await.unwrap();
            assert!(r.status().is_success());
            r.json::<Value>().await.unwrap()
        }
    };
    // Without since: nothing, and where to start.
    let v = get(http(&s, "p/events")).await;
    assert_eq!(v["events"], json!([]));
    assert_eq!(
        (v["latest_event_id"].as_i64(), v["next_since"].as_i64()),
        (Some(3), Some(3))
    );
    // The default filter: the owner's (web) events.
    let v = get(http(&s, "p/events?since=0")).await;
    let ids: Vec<i64> = v["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["event_id"].as_i64().unwrap())
        .collect();
    assert_eq!(ids, vec![1, 3]);
    assert_eq!(
        (v["more"].as_bool(), v["next_since"].as_i64()),
        (Some(false), Some(3))
    );
    // A limit pages.
    let v = get(http(&s, "p/events?since=0&limit=1&surface=any")).await;
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
    assert_eq!(
        (v["more"].as_bool(), v["next_since"].as_i64()),
        (Some(true), Some(1))
    );
    // Nothing matching after since still moves next_since past what was scanned.
    let v = get(http(&s, "p/events?since=1&kinds=approve")).await;
    assert_eq!(v["events"], json!([]));
    assert_eq!(v["next_since"].as_i64(), Some(3));
}

// ---- Lag and shutdown ---------------------------------------------------------------------

/// A client that falls further behind than the channel holds is disconnected
/// with a close frame naming the id to resume from, and resuming from it
/// loses nothing. The default single-threaded test runtime makes the lag
/// certain: one publish sends the whole burst without yielding, so the
/// socket's task cannot read any of it until the channel has overflowed.
#[tokio::test]
async fn a_lagging_client_is_closed_with_its_resume_id_and_resumes_without_loss() {
    let s = server_with(Some(4)).await;
    let mut ws = connect(&s, "p/events/ws").await;
    add(&s.store, "p", "First", &web()).await;
    let first = id_of(&next_text(&mut ws).await);
    // Ten writes through a second handle on the same database: committed, but
    // not published on this feed until the next write through the first.
    let other = TrackerStore::open(&s.db, s._dir.path().join("att"))
        .await
        .unwrap();
    for i in 0..10 {
        add(&other, "p", &format!("burst {i}"), &web()).await;
    }
    add(&s.store, "p", "Last", &web()).await;
    let close = next_close(&mut ws).await;
    assert_eq!(u16::from(close.code), 1013);
    assert!(
        close.reason.contains(&format!("resume with since={first}")),
        "{}",
        close.reason
    );
    let mut ws = connect(&s, &format!("p/events/ws?since={first}")).await;
    for want in first + 1..=first + 11 {
        assert_eq!(id_of(&next_text(&mut ws).await), want);
    }
}

#[tokio::test]
async fn closing_the_feed_sends_a_restart_close_with_the_resume_id() {
    let s = server().await;
    add(&s.store, "p", "A", &web()).await;
    let mut ws = connect(&s, "p/events/ws?since=0").await;
    assert_eq!(id_of(&next_text(&mut ws).await), 1);
    assert_eq!(s.store.close_feed(), 1);
    let close = next_close(&mut ws).await;
    assert_eq!(u16::from(close.code), 1012);
    assert!(close.reason.contains("since=1"), "{}", close.reason);
}

#[tokio::test]
async fn frames_say_what_a_change_moved_from_and_to_in_both_formats() {
    let s = server().await;
    let a = add(&s.store, "p", "Alpha", &mcp()).await;
    let b = add(&s.store, "p", "Beta", &mcp()).await;
    let mut text = connect(&s, "p/events/ws").await;
    let mut json_ws = connect(&s, "p/events/ws?format=json").await;
    let client = reqwest::Client::new();
    let write = |path: String, body: Value| {
        let client = client.clone();
        let url = http(&s, &path);
        async move {
            let mut body = body;
            body["author_email"] = json!("owner@example.com");
            body["surface"] = json!("web");
            let r = client.post(url).json(&body).send().await.unwrap();
            assert!(r.status().is_success(), "{}", r.text().await.unwrap());
        }
    };
    // From the web with no agent: the owner, the change from → to, the
    // generated body as the note.
    write(
        format!("items/{a}"),
        json!({ "status": "in_progress", "labels": ["Physics", "Biomes"] }),
    )
    .await;
    let line = next_text(&mut text).await;
    assert!(
        line.contains(&format!(
            " web status {a} \"Alpha\" {{status: pending → in_progress; labels: +Biomes +Physics}}: \
             Status: pending → in_progress. "
        )),
        "{line}"
    );
    assert!(line.ends_with(" [Owner]"), "{line}");
    let v: Value = serde_json::from_str(&next_text(&mut json_ws).await).unwrap();
    assert_eq!(v["agent"], "Owner");
    assert_eq!(v["fields"]["status"], "in_progress");
    assert_eq!(v["before"], json!({ "status": "pending", "labels": [] }));

    // A move, by its new neighbour.
    write(format!("items/{b}/move"), json!({ "top": true })).await;
    let line = next_text(&mut text).await;
    assert!(
        line.contains(&format!(" move {b} \"Beta\" {{moved: after {a} → top}}: ")),
        "{line}"
    );
    let v: Value = serde_json::from_str(&next_text(&mut json_ws).await).unwrap();
    assert_eq!(v["before"], json!({ "prev_id": a }));
    assert_eq!(v["fields"]["prev_id"], json!(null));
    assert!(!line.contains('\n'));
}

// ---- Bursts (rag-t0039) ---------------------------------------------------------------

/// Move `id` to the top as the owner.
async fn to_top(store: &TrackerStore, id: &str) {
    store.move_item(id, Place::Top, None, &web()).await.unwrap();
}

#[tokio::test]
async fn a_burst_of_moves_is_one_frame_that_resumes_exactly() {
    let s = server().await;
    let ids = [
        add(&s.store, "p", "A", &mcp()).await,
        add(&s.store, "p", "B", &mcp()).await,
        add(&s.store, "p", "C", &mcp()).await,
    ];
    let mut ws = connect(&s, "p/events/ws?coalesce=1").await;
    // A drag reorder: three moves in quick succession.
    for id in ids.iter().rev() {
        to_top(&s.store, id).await;
    }
    let line = next_text(&mut ws).await;
    let (first, last) = (4, 6);
    assert!(
        line.starts_with(&format!("#{last} p web burst #{first}–#{last}, 3 events: ")),
        "{line}"
    );
    assert!(
        line.contains(&format!(
            "queue reordered: 3 moves ({}, {}, {})",
            ids[2], ids[1], ids[0]
        )),
        "{line}"
    );
    assert!(line.ends_with(" [Owner]"), "{line}");
    assert_eq!(id_of(&line), last, "the frame starts with the resume id");
    quiet(&mut ws, 1300).await;
    // Resuming from it replays nothing; from before it, the replay coalesces
    // by the events' own timestamps; with coalesce=0, one frame each.
    let mut after = connect(&s, &format!("p/events/ws?since={last}&coalesce=1")).await;
    quiet(&mut after, 300).await;
    let mut again = connect(&s, &format!("p/events/ws?since={}&coalesce=1", first - 1)).await;
    let replayed = next_text(&mut again).await;
    assert!(
        replayed.starts_with(&format!("#{last} p web burst #{first}–#{last}, 3 events: ")),
        "{replayed}"
    );
    let mut each = connect(&s, &format!("p/events/ws?since={}", first - 1)).await;
    for want in first..=last {
        assert_eq!(id_of(&next_text(&mut each).await), want);
    }
}

#[tokio::test]
async fn the_default_text_feed_coalesces_a_burst_within_three_seconds() {
    let s = server().await;
    let a = add(&s.store, "p", "Alpha", &mcp()).await;
    let mut ws = connect_as_given(&s, "p/events/ws").await;
    let started = tokio::time::Instant::now();
    for title in ["Alpha 2", "Alpha 3"] {
        s.store
            .update_item(
                &a,
                ItemUpdate {
                    title: Some(title.into()),
                    ..Default::default()
                },
                &web(),
            )
            .await
            .unwrap();
    }
    let line = next_text(&mut ws).await;
    assert!(
        started.elapsed() >= Duration::from_millis(2500),
        "the burst stays open for its window"
    );
    assert!(
        line.contains(&format!(
            "{a} \"Alpha 3\": 2 edits {{title: Alpha → Alpha 2; title: Alpha 2 → Alpha 3}}"
        )),
        "{line}"
    );
    assert_eq!(id_of(&line), 3);
}

#[tokio::test]
async fn a_burst_never_spans_two_surfaces_or_two_projects() {
    let s = server().await;
    let mut ws = connect(&s, "*/events/ws?surface=any&coalesce=1").await;
    add(&s.store, "p", "Web one", &web()).await;
    add(&s.store, "p", "Agent one", &mcp()).await;
    add(&s.store, "q", "Other project", &mcp()).await;
    add(&s.store, "q", "Other project 2", &mcp()).await;
    let lines = [
        next_text(&mut ws).await,
        next_text(&mut ws).await,
        next_text(&mut ws).await,
    ];
    assert!(lines[0].starts_with("#1 p web create "), "{lines:?}");
    assert!(lines[1].starts_with("#2 p mcp create "), "{lines:?}");
    assert!(
        lines[2].starts_with("#4 q mcp burst #3–#4, 2 events: "),
        "{lines:?}"
    );
    quiet(&mut ws, 1300).await;
}

#[tokio::test]
async fn closing_mid_burst_sends_the_burst_then_resumes_after_it() {
    let s = server().await;
    let mut ws = connect(&s, "p/events/ws?coalesce=30").await;
    add(&s.store, "p", "A", &web()).await;
    add(&s.store, "p", "B", &web()).await;
    // Let the feed take both in before the server goes.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(s.store.close_feed(), 1);
    let line = next_text(&mut ws).await;
    assert!(
        line.starts_with("#2 p web burst #1–#2, 2 events: "),
        "{line}"
    );
    let close = next_close(&mut ws).await;
    assert_eq!(u16::from(close.code), 1012);
    assert!(close.reason.contains("since=2"), "{}", close.reason);
}

/// The owner's drafts (2026-10-30): a ticket created and edited as a draft
/// wakes nobody; `drafts=true` sees it; publishing it is its first frame on a
/// default feed. A concept's document is published over its own route.
#[tokio::test]
async fn a_draft_reaches_only_a_feed_that_asks_until_it_is_published() {
    let s = server().await;
    let mut ws = connect(&s, "p/events/ws").await;
    let mut drafts = connect(&s, "p/events/ws?drafts=true").await;
    let client = reqwest::Client::new();
    let who = json!({ "author_email": "x@example.com", "surface": "web" });
    let send = |path: String, mut body: Value| {
        let client = client.clone();
        let url = http(&s, &path);
        let who = who.clone();
        async move {
            for (k, v) in who.as_object().unwrap() {
                body[k] = v.clone();
            }
            let r = client.post(url).json(&body).send().await.unwrap();
            let ok = r.status().is_success();
            let v: Value = r.json().await.unwrap();
            assert!(ok, "{v}");
            v
        }
    };
    let t = send(
        "p/items".into(),
        json!({ "type": "dev", "title": "Half written", "draft": true }),
    )
    .await;
    assert_eq!(t["draft"], json!(true));
    let id = t["id"].as_str().unwrap().to_string();
    let line = next_text(&mut drafts).await;
    assert!(line.contains("\"Half written\" (draft)"), "{line}");
    quiet(&mut ws, 150).await;

    let read: Value = client
        .get(http(&s, "p/events?since=0"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(read["events"].as_array().unwrap().len(), 0, "{read}");
    let read: Value = client
        .get(http(&s, "p/events?since=0&drafts=true"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(read["events"][0]["draft"], json!(true), "{read}");
    let q: Value = client
        .get(http(&s, "p"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(q["drafts"][0]["id"], json!(id));
    assert_eq!(q["queue"], json!([]));

    send(format!("items/{id}"), json!({ "draft": false })).await;
    let line = next_text(&mut ws).await;
    assert!(
        line.contains(" web edit ") && line.contains("{draft: yes → no}"),
        "{line}"
    );

    let c = send(
        "p/concepts".into(),
        json!({ "slug": "power", "title": "Power", "body": "x\n", "draft": true }),
    )
    .await;
    assert_eq!(c["state"], json!("open"));
    let doc: Value = client
        .get(http(&s, "p/doc?path=concepts/power.md"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(doc["draft"], json!(true), "{doc}");
    quiet(&mut ws, 150).await;
    let doc_id = doc["id"].as_str().unwrap();
    let v = send(format!("docs/{doc_id}/draft"), json!({ "draft": false })).await;
    assert_eq!(v["draft"], json!(false));
    let line = next_text(&mut ws).await;
    assert!(
        line.contains(&format!("doc:{doc_id}")) && line.contains("{draft: yes → no}"),
        "{line}"
    );
}
