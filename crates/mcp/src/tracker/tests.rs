//! Tests for the tracker tools (m02 § Tests): each tool's arguments map to its
//! route's body, the queue's text is pinned by a golden string, a stale edit
//! comes back as the server's refusal with the current revision, and an
//! attachment survives the round trip over stdio.

use std::sync::{Arc, Mutex};

use axum::{
    body::Bytes,
    extract::{Multipart, Path as AxPath, State},
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use rmcp::model::RawContent;
use serde_json::json;

use super::*;

fn who() -> Author {
    Author {
        email: "dev@example.com".into(),
        agent: Some("Claude Test".into()),
    }
}

fn anon() -> Author {
    Author {
        email: "dev@example.com".into(),
        agent: None,
    }
}

fn post_of(r: &Req) -> (&str, &Value) {
    assert_eq!(r.method, Method::Post, "{r:?}");
    (r.path.as_str(), r.body.as_ref().expect("a POST has a body"))
}

fn get_of(r: &Req) -> &str {
    assert_eq!(r.method, Method::Get, "{r:?}");
    assert!(r.body.is_none());
    r.path.as_str()
}

/// The author fields every write carries, merged into `fields`.
fn with_author(mut fields: Value) -> Value {
    let m = fields.as_object_mut().unwrap();
    m.insert("author_email".into(), json!("dev@example.com"));
    m.insert("agent".into(), json!("Claude Test"));
    m.insert("surface".into(), json!("mcp"));
    fields
}

fn texts(r: &CallToolResult) -> String {
    r.content
        .iter()
        .filter_map(|c| match &c.raw {
            RawContent::Text(t) => Some(t.text.clone()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ---- References -----------------------------------------------------------------

#[test]
fn targets_parse_every_form() {
    assert_eq!(
        parse_target("ubu-t0042").unwrap(),
        Target::Item("ubu-t0042".into())
    );
    assert_eq!(
        parse_target(" js_web-d0007 ").unwrap(),
        Target::Doc("js_web-d0007".into())
    );
    assert_eq!(
        parse_target("specs/audio/master.md").unwrap(),
        Target::Path("specs/audio/master.md".into())
    );
    assert_eq!(
        parse_target("spec:audio").unwrap(),
        Target::Spec("audio".into())
    );
    assert_eq!(
        parse_target("milestone:audio/m03").unwrap(),
        Target::Milestone("audio".into(), "m03".into())
    );
    assert_eq!(
        parse_target("concept:power-generation").unwrap(),
        Target::Concept("power-generation".into())
    );
    for bad in ["", "ubu-1592", "ubu-t", "milestone:audio", "spec:", "hello"] {
        assert!(parse_target(bad).is_err(), "{bad} should be refused");
    }
}

/// A ledger id of either form (rag-t0051) is refused with a pointer to the
/// ledger, not the tracker's list of forms; a near miss still gets the list.
#[test]
fn a_ledger_id_is_refused_with_a_pointer_to_the_ledger() {
    for id in ["ubu-l1652", "ubu-1592", "shq-suite-l0012", "shq-suite-0001"] {
        let err = parse_target(id).unwrap_err();
        assert!(err.contains("is a ledger topic id"), "{id}: {err}");
        assert!(err.contains("ledger_get"), "{id}: {err}");
    }
    for id in ["ubu-l12", "ubu-L1652", "hello"] {
        let err = parse_target(id).unwrap_err();
        assert!(!err.contains("ledger topic"), "{id}: {err}");
        assert!(err.contains("ubu-t0042"), "{id}: {err}");
    }
}

// ---- Request builders -----------------------------------------------------------

#[test]
fn queue_and_ack_need_a_project() {
    assert_eq!(get_of(&queue_req(Some("ubu")).unwrap()), "/tracker/ubu");
    assert!(queue_req(None).unwrap_err().contains("project not given"));
    let r = ack_req(Some("ubu"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/ubu/ack-done");
    assert_eq!(*body, with_author(json!({})));
    assert!(ack_req(None, &who()).is_err());
}

#[test]
fn list_builds_each_route_and_refuses_misplaced_filters() {
    let l = |what: &str| TrackerListArgs {
        what: what.into(),
        ..Default::default()
    };
    assert_eq!(
        get_of(&list_req(&l("projects"), None).unwrap()),
        "/tracker/projects"
    );
    let items = TrackerListArgs {
        status: Some("done".into()),
        ..l("items")
    };
    assert_eq!(
        get_of(&list_req(&items, Some("p")).unwrap()),
        "/tracker/p/items?status=done"
    );
    let docs = TrackerListArgs {
        kind: Some("milestone".into()),
        prefix: Some("specs/audio/".into()),
        ..l("docs")
    };
    assert_eq!(
        get_of(&list_req(&docs, Some("p")).unwrap()),
        "/tracker/p/docs?kind=milestone&prefix=specs%2Faudio%2F"
    );
    let concepts = TrackerListArgs {
        state: Some("open".into()),
        ..l("concepts")
    };
    assert_eq!(
        get_of(&list_req(&concepts, Some("p")).unwrap()),
        "/tracker/p/concepts?state=open"
    );
    assert_eq!(
        get_of(&list_req(&l("specs"), Some("p")).unwrap()),
        "/tracker/p/specs"
    );
    assert_eq!(
        get_of(&list_req(&l("attachments"), Some("p")).unwrap()),
        "/tracker/p/attachments"
    );
    // A filter that does not apply is refused, never dropped.
    let wrong = TrackerListArgs {
        status: Some("done".into()),
        ..l("specs")
    };
    let e = list_req(&wrong, Some("p")).unwrap_err();
    assert!(e.contains("`status` does not apply"), "{e}");
    assert!(list_req(&l("widgets"), Some("p")).is_err());
    assert!(list_req(&l("items"), None).is_err());
}

#[test]
fn reads_build_record_and_document_routes() {
    let p = Some("p");
    assert_eq!(
        get_of(&record_get_req(&parse_target("p-t0001").unwrap(), None, true).unwrap()),
        "/tracker/items/p-t0001"
    );
    assert_eq!(
        get_of(&record_get_req(&parse_target("p-t0001").unwrap(), None, false).unwrap()),
        "/tracker/items/p-t0001?history=false"
    );
    assert_eq!(
        get_of(&record_get_req(&parse_target("spec:audio").unwrap(), p, true).unwrap()),
        "/tracker/p/specs/audio"
    );
    assert_eq!(
        get_of(&record_get_req(&parse_target("milestone:audio/m03").unwrap(), p, true).unwrap()),
        "/tracker/p/specs/audio/milestones/m03"
    );
    assert_eq!(
        get_of(&record_get_req(&parse_target("concept:x").unwrap(), p, false).unwrap()),
        "/tracker/p/concepts/x?history=false"
    );
    // A spec needs a project; an item id carries its own.
    assert!(record_get_req(&parse_target("spec:audio").unwrap(), None, true).is_err());
    // Documents, by path and by id, at a revision.
    let path = parse_target("specs/audio/m03-music.md").unwrap();
    assert_eq!(
        get_of(&doc_get_req(&path, p, Some(2), false).unwrap()),
        "/tracker/p/doc?path=specs%2Faudio%2Fm03-music.md&revision=2&history=false"
    );
    assert_eq!(
        get_of(&record_get_req(&path, p, true).unwrap()),
        "/tracker/p/doc?path=specs%2Faudio%2Fm03-music.md"
    );
    assert_eq!(
        get_of(&doc_get_req(&Target::Doc("p-d0003".into()), None, None, true).unwrap()),
        "/tracker/docs/p-d0003"
    );
    assert_eq!(
        get_of(&revisions_req("p-d0003")),
        "/tracker/docs/p-d0003/revisions"
    );
    assert_eq!(
        get_of(&diff_req("p-d0003", Some(1), None)),
        "/tracker/docs/p-d0003/diff?from=1"
    );
    assert_eq!(
        get_of(&diff_req("p-d0003", None, None)),
        "/tracker/docs/p-d0003/diff"
    );
}

#[test]
fn create_maps_each_kind_to_its_route_and_body() {
    let link = LinkArg {
        kind: "ledger".into(),
        target: "rag-0033".into(),
    };
    // An item, placed after another.
    let a = TrackerCreateArgs {
        kind: "item".into(),
        project: Some("ignored-here".into()),
        item_type: Some("dev".into()),
        title: Some("Build m02".into()),
        links: Some(vec![link.clone()]),
        after: Some("p-t0001".into()),
        note: Some("queued".into()),
        agent: Some("not sent: the Author carries it".into()),
        ..Default::default()
    };
    let r = create_req(&a, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/items");
    assert_eq!(
        *body,
        with_author(json!({
            "type": "dev", "title": "Build m02",
            "links": [{"kind": "ledger", "target": "rag-0033"}],
            "after": "p-t0001", "note": "queued"
        }))
    );
    // A gate: kind=gate fills in the type.
    let g = TrackerCreateArgs {
        kind: "gate".into(),
        title: Some("Standard gate".into()),
        intensity: Some("standard".into()),
        release: Some(true),
        top: Some(true),
        ..Default::default()
    };
    let r = create_req(&g, Some("p"), &anon()).unwrap();
    let (_, body) = post_of(&r);
    assert_eq!(
        *body,
        json!({
            "type": "gate", "title": "Standard gate", "intensity": "standard",
            "release": true, "top": true,
            "author_email": "dev@example.com", "surface": "mcp"
        }),
        "an absent agent is left for the server to record as Unknown"
    );
    let g2 = TrackerCreateArgs {
        item_type: Some("dev".into()),
        ..g
    };
    assert!(create_req(&g2, Some("p"), &who()).is_err());
    // A spec with milestones.
    let sp = TrackerCreateArgs {
        kind: "spec".into(),
        slug: Some("audio".into()),
        title: Some("Audio".into()),
        body: Some("# Audio".into()),
        milestones: Some(vec![MilestoneArg {
            code: "m01".into(),
            title: "Sound effects".into(),
            name: Some("sfx".into()),
            state: None,
            approval: None,
            body: Some("m01 body".into()),
            body_path: None,
            note: None,
        }]),
        ..Default::default()
    };
    let r = create_req(&sp, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/specs");
    assert_eq!(
        *body,
        with_author(json!({
            "slug": "audio", "title": "Audio", "body": "# Audio",
            "milestones": [{"code": "m01", "title": "Sound effects", "name": "sfx", "body": "m01 body"}]
        }))
    );
    // A milestone: `spec` goes into the path, not the body.
    let m = TrackerCreateArgs {
        kind: "milestone".into(),
        spec: Some("audio".into()),
        code: Some("m02".into()),
        title: Some("Music".into()),
        ..Default::default()
    };
    let r = create_req(&m, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/specs/audio/milestones");
    assert_eq!(*body, with_author(json!({"code": "m02", "title": "Music"})));
    let no_spec = TrackerCreateArgs { spec: None, ..m };
    assert!(create_req(&no_spec, Some("p"), &who())
        .unwrap_err()
        .contains("needs `spec`"));
    // A concept, and a free-standing document.
    let c = TrackerCreateArgs {
        kind: "concept".into(),
        slug: Some("terrain".into()),
        title: Some("Terrain".into()),
        body: Some("musing".into()),
        links: Some(vec![link]),
        ..Default::default()
    };
    let r = create_req(&c, Some("p"), &who()).unwrap();
    assert_eq!(post_of(&r).0, "/tracker/p/concepts");
    let d = TrackerCreateArgs {
        kind: "doc".into(),
        path: Some("notes/a.md".into()),
        title: Some("A".into()),
        message: Some("first".into()),
        ..Default::default()
    };
    let r = create_req(&d, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/docs");
    assert_eq!(
        *body,
        with_author(json!({"path": "notes/a.md", "title": "A", "message": "first"}))
    );
}

#[test]
fn create_refuses_fields_that_do_not_apply() {
    let c = TrackerCreateArgs {
        kind: "concept".into(),
        slug: Some("x".into()),
        title: Some("X".into()),
        intensity: Some("full".into()),
        assignee: Some("dev-1".into()),
        ..Default::default()
    };
    let e = create_req(&c, Some("p"), &who()).unwrap_err();
    assert!(
        e.contains("`assignee`, `intensity` do not apply to a concept"),
        "{e}"
    );
    let d = TrackerCreateArgs {
        kind: "doc".into(),
        path: Some("a.md".into()),
        title: Some("A".into()),
        note: Some("n".into()),
        ..Default::default()
    };
    assert!(create_req(&d, Some("p"), &who())
        .unwrap_err()
        .contains("`note` does not apply to a doc"));
    let k = TrackerCreateArgs {
        kind: "epic".into(),
        ..Default::default()
    };
    assert!(create_req(&k, Some("p"), &who()).is_err());
    let i = TrackerCreateArgs {
        kind: "item".into(),
        ..Default::default()
    };
    assert!(create_req(&i, None, &who())
        .unwrap_err()
        .contains("project not given"));
}

#[test]
fn update_maps_each_target_and_takes_an_optional_note() {
    let u = TrackerUpdateArgs {
        id: "p-t0004".into(),
        status: Some("in_progress".into()),
        assignee: Some("dev-3".into()),
        add_links: Some(vec![LinkArg {
            kind: "spec".into(),
            target: "tracker".into(),
        }]),
        note: Some("dispatched".into()),
        ..Default::default()
    };
    let r = update_req(&u, None, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/items/p-t0004");
    assert_eq!(
        *body,
        with_author(json!({
            "status": "in_progress", "assignee": "dev-3",
            "add_links": [{"kind": "spec", "target": "tracker"}], "note": "dispatched"
        }))
    );
    // A note alone (a sub-agent reporting on its task).
    let n = TrackerUpdateArgs {
        id: "p-t0004".into(),
        note: Some("half done".into()),
        ..Default::default()
    };
    let r = update_req(&n, None, &who()).unwrap();
    assert_eq!(*post_of(&r).1, with_author(json!({"note": "half done"})));
    // A change without a note, or with a blank one, is sent without one (D7,
    // amended 2026-10-27): the store generates the event's body.
    for note in [None, Some("  ".to_string())] {
        let x = TrackerUpdateArgs {
            id: "p-t0004".into(),
            status: Some("done".into()),
            approval: Some("ratified".into()),
            note,
            ..Default::default()
        };
        let r = update_req(&x, None, &who()).unwrap();
        assert_eq!(
            *post_of(&r).1,
            with_author(json!({"status": "done", "approval": "ratified"}))
        );
    }
    // Nothing to change and no note (or a blank one): refused before any request.
    for note in [None, Some("  ".to_string())] {
        let x = TrackerUpdateArgs {
            id: "p-t0004".into(),
            note,
            ..Default::default()
        };
        assert!(update_req(&x, None, &who())
            .unwrap_err()
            .contains("nothing to update"));
    }
    // Spec, milestone and concept routes.
    let sp = TrackerUpdateArgs {
        id: "spec:audio".into(),
        state: Some("ready".into()),
        note: Some("reviewed".into()),
        ..Default::default()
    };
    assert_eq!(
        post_of(&update_req(&sp, Some("p"), &who()).unwrap()).0,
        "/tracker/p/specs/audio"
    );
    let m = TrackerUpdateArgs {
        id: "milestone:audio/m02".into(),
        order: Some(5),
        note: Some("later".into()),
        ..Default::default()
    };
    let r = update_req(&m, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/specs/audio/milestones/m02");
    assert_eq!(*body, with_author(json!({"order": 5, "note": "later"})));
    let c = TrackerUpdateArgs {
        id: "concept:terrain".into(),
        state: Some("archived".into()),
        note: Some("became spec terrain".into()),
        ..Default::default()
    };
    assert_eq!(
        post_of(&update_req(&c, Some("p"), &who()).unwrap()).0,
        "/tracker/p/concepts/terrain"
    );
    // Fields for another record kind are refused.
    let wrong = TrackerUpdateArgs {
        id: "spec:audio".into(),
        status: Some("done".into()),
        note: Some("x".into()),
        ..Default::default()
    };
    assert!(update_req(&wrong, Some("p"), &who())
        .unwrap_err()
        .contains("`status` does not apply to a spec"));
    let doc = TrackerUpdateArgs {
        id: "p-d0001".into(),
        note: Some("x".into()),
        ..Default::default()
    };
    assert!(update_req(&doc, None, &who())
        .unwrap_err()
        .contains("tracker_doc_edit"));
}

#[test]
fn move_sends_its_place() {
    let m = TrackerMoveArgs {
        id: "p-t0003".into(),
        before: Some("p-t0001".into()),
        note: Some("urgent".into()),
        ..Default::default()
    };
    let r = move_req(&m, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/items/p-t0003/move");
    assert_eq!(
        *body,
        with_author(json!({"before": "p-t0001", "note": "urgent"}))
    );
    let top = TrackerMoveArgs {
        id: "p-t0003".into(),
        top: Some(true),
        ..Default::default()
    };
    assert_eq!(
        *post_of(&move_req(&top, &who()).unwrap()).1,
        with_author(json!({"top": true}))
    );
    let not_item = TrackerMoveArgs {
        id: "spec:a".into(),
        top: Some(true),
        ..Default::default()
    };
    assert!(move_req(&not_item, &who()).is_err());
}

#[test]
fn doc_edit_picks_its_route_by_mode() {
    let base = |f: fn(&mut TrackerDocEditArgs)| {
        let mut a = TrackerDocEditArgs {
            doc: "p-d0002".into(),
            base_revision: Some(3),
            message: Some("tightened".into()),
            ..Default::default()
        };
        f(&mut a);
        a
    };
    let reps = base(|a| {
        a.replacements = Some(vec![ReplacementArg {
            old: "a".into(),
            new: "b".into(),
        }])
    });
    let r = doc_edit_req("p-d0002", &reps, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/docs/p-d0002/edit");
    assert_eq!(
        *body,
        with_author(json!({
            "base_revision": 3, "message": "tightened",
            "replacements": [{"old": "a", "new": "b"}]
        }))
    );
    let whole = base(|a| a.body = Some("# new".into()));
    let r = doc_edit_req("p-d0002", &whole, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/docs/p-d0002/write");
    assert_eq!(
        *body,
        with_author(json!({"base_revision": 3, "message": "tightened", "body": "# new"}))
    );
    let restore = base(|a| a.restore_revision = Some(1));
    let r = doc_edit_req("p-d0002", &restore, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/docs/p-d0002/restore");
    assert_eq!(
        *body,
        with_author(json!({"base_revision": 3, "message": "tightened", "revision": 1}))
    );
    // A rename takes no base revision and sends its message as the note.
    let rename = base(|a| {
        a.base_revision = None;
        a.new_path = Some("concepts/b.md".into());
    });
    let r = doc_edit_req("p-d0002", &rename, &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/docs/p-d0002/rename");
    assert_eq!(
        *body,
        with_author(json!({"path": "concepts/b.md", "note": "tightened"}))
    );
    // Refusals: two modes, no mode, no base, an empty replacement list.
    let two = base(|a| {
        a.body = Some("x".into());
        a.restore_revision = Some(1);
    });
    assert!(doc_edit_req("p-d0002", &two, &who())
        .unwrap_err()
        .contains("exactly one"));
    assert!(doc_edit_req("p-d0002", &base(|_| {}), &who()).is_err());
    let no_base = base(|a| {
        a.base_revision = None;
        a.body = Some("x".into());
    });
    assert!(doc_edit_req("p-d0002", &no_base, &who())
        .unwrap_err()
        .contains("base_revision is required"));
    let empty = base(|a| a.replacements = Some(vec![]));
    assert!(doc_edit_req("p-d0002", &empty, &who()).is_err());
}

#[test]
fn attachment_references_and_multipart() {
    assert_eq!(
        get_of(&attachment_get_req("att:3FA9C2E1B07D").unwrap()),
        "/tracker/attachments/3fa9c2e1b07d"
    );
    assert!(attachment_get_req("att:3fa9").is_err());
    assert!(attachment_get_req("not-a-hash-at-all").is_err());

    let body = multipart_body(
        "BOUND",
        &[("author_email", "a@b"), ("surface", "mcp")],
        "my \"pic\".png",
        None,
        b"\x89PNG",
    );
    let expected =
        b"--BOUND\r\nContent-Disposition: form-data; name=\"author_email\"\r\n\r\na@b\r\n\
--BOUND\r\nContent-Disposition: form-data; name=\"surface\"\r\n\r\nmcp\r\n\
--BOUND\r\nContent-Disposition: form-data; name=\"file\"; filename=\"my _pic_.png\"\r\n\
Content-Type: application/octet-stream\r\n\r\n\x89PNG\r\n--BOUND--\r\n";
    assert_eq!(body, expected.to_vec());

    // The boundary never occurs in the bytes it frames.
    let first = boundary_for(b"abc");
    let tricky = format!("xx{first}yy").into_bytes();
    let b = boundary_for(&tricky);
    assert_ne!(b, first);
    assert!(!tricky.windows(b.len()).any(|w| w == b.as_bytes()));

    assert_eq!(guess_media("notes.MD"), Some("text/markdown"));
    assert_eq!(guess_media("a.pdf"), Some("application/pdf"));
    assert_eq!(
        guess_media("terrain.png"),
        None,
        "images are sniffed by the server"
    );
    assert_eq!(
        disposition_name("inline; filename=\"terrain.png\"").as_deref(),
        Some("terrain.png")
    );
    let p = default_out_path("0123456789abcdef", Some("../evil.png"));
    assert!(p.starts_with(std::env::temp_dir().join("rag-tracker")));
    assert_eq!(p.file_name().unwrap(), "0123456789ab-_evil.png");
}

// ---- Rendering --------------------------------------------------------------------

fn it(id: &str, ty: &str, title: &str, status: &str) -> Value {
    json!({
        "id": id, "type": ty, "title": title, "status": status, "blocked": false,
        "block_reason": null, "block_note": null, "approval": "unapproved",
        "assignee": null, "intensity": null, "release": false, "links": []
    })
}

/// The view the queue goldens read: one done, one in review, four queued (a gate
/// second), one blocked, one deferred.
fn golden_view() -> Value {
    let mut done = it("ubu-t0040", "dev", "Ship the store", "done");
    done["approval"] = json!("owner");
    let mut running = it("ubu-t0042", "dev", "Build the MCP server", "in_progress");
    running["assignee"] = json!("dev-3");
    running["approval"] = json!("agent");
    running["links"] = json!([{"kind": "milestone", "target": "tracker/m02"}, {"kind": "ledger", "target": "rag-0033"}]);
    let mut gate = it("ubu-t0043", "gate", "Standard gate", "pending");
    gate["intensity"] = json!("standard");
    gate["release"] = json!(true);
    let failed = it("ubu-t0044", "analysis", "Why the bench is red", "failed");
    let pending = it("ubu-t0045", "recon", "Map the web app", "pending");
    let mut blocked = it("ubu-t0046", "design", "Icons", "pending");
    blocked["blocked"] = json!(true);
    blocked["block_reason"] = json!("redesign");
    blocked["block_note"] = json!("waiting on the owner's pick");
    let deferred = it("ubu-t0047", "dev", "Later idea", "deferred");
    let mut review = it("ubu-t0048", "dev", "Heat power m01", "review");
    review["approval"] = json!("owner");
    json!({
        "project": "ubu", "exists": true,
        "done": [done], "review": [review], "queue": [running, gate, failed, pending],
        "blocked": [blocked], "deferred": [deferred]
    })
}

fn qopts(fields: Value) -> Result<QueueOpts, String> {
    queue_opts(&serde_json::from_value::<TrackerQueueArgs>(fields).unwrap())
}

/// Done lists in the server's order, oldest first and the latest finished last,
/// never re-sorted here (rag-t0029).
#[test]
fn queue_done_keeps_the_views_oldest_first_order() {
    let mut v = golden_view();
    let older = it("ubu-t0050", "dev", "Finished first", "done");
    let newer = it("ubu-t0039", "dev", "Finished last", "done");
    v["done"] = json!([older, newer]);
    let o = qopts(json!({"sections": ["done"]})).unwrap();
    let t = render_queue(&v, &o);
    let first = t.find("ubu-t0050").expect(&t);
    let last = t.find("ubu-t0039").expect(&t);
    assert!(first < last, "{t}");
    assert!(
        t.contains("Done:\n  ✓ ubu-t0050 [dev] Finished first · done\n  ✓ ubu-t0039 [dev] Finished last · done\n"),
        "{t}"
    );
}

#[test]
fn queue_text_is_golden() {
    let all =
        qopts(json!({"sections": ["review", "done", "queue", "blocked", "deferred"]})).unwrap();
    let expected = "\
ubu: 0 requests, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged
Review:
  ◆ ubu-t0048 [dev] Heat power m01 · review · approval: owner
Done:
  ✓ ubu-t0040 [dev] Ship the store · done · approval: owner
Queue:
  ● ubu-t0042 [dev] Build the MCP server · in progress · agent: dev-3 · approval: agent · links: milestone:tracker/m02, ledger:rag-0033
  ── ubu-t0043 gate: standard · release ──
  ✗ ubu-t0044 [analysis] Why the bench is red · failed
  ○ ubu-t0045 [recon] Map the web app · pending
Blocked:
  ○ ubu-t0046 [design] Icons · pending · blocked: redesign: waiting on the owner's pick
Deferred:
  ◌ ubu-t0047 [dev] Later idea · deferred
Not shown: none";
    assert_eq!(render_queue(&golden_view(), &all), expected);

    // Deferred and review left out of the sections: counted in the footer.
    let three = qopts(json!({"sections": ["done", "queue", "blocked"]})).unwrap();
    let t = render_queue(&golden_view(), &three);
    assert!(!t.contains("Deferred:") && !t.contains("ubu-t0047"), "{t}");
    assert!(!t.contains("Review:") && !t.contains("ubu-t0048"), "{t}");
    assert!(t.ends_with("\nNot shown: 1 deferred · 1 in review"), "{t}");
    // A deferred item that is also blocked says both.
    let mut both = golden_view();
    both["deferred"][0]["blocked"] = json!(true);
    both["deferred"][0]["block_reason"] = json!("review");
    assert!(
        render_queue(&both, &all)
            .contains("Deferred:\n  ◌ ubu-t0047 [dev] Later idea · deferred · blocked: review\n"),
        "{}",
        render_queue(&both, &all)
    );

    // A view without a deferred or review array (an older server) reads as none.
    let empty = json!({"project": "ubu", "exists": true, "done": [], "queue": [], "blocked": []});
    assert_eq!(
        render_queue(&empty, &all),
        "ubu: 0 requests, 0 in review, 0 in the queue, 0 blocked, 0 deferred, 0 done not acknowledged\nReview: none\nDone: none\nQueue: none\nBlocked: none\nDeferred: none\nNot shown: none"
    );
    let unknown =
        json!({"project": "new", "exists": false, "done": [], "queue": [], "blocked": []});
    assert!(render_queue(&unknown, &all).starts_with("new: no tracker records yet"));
    assert!(render_next(&unknown, 1, None).starts_with("new: no tracker records yet"));
}

#[test]
fn the_default_queue_counts_done_and_lists_twenty_rows() {
    let default = qopts(json!({})).unwrap();
    assert_eq!(
        default,
        QueueOpts {
            limit: 20,
            until_gate: false,
            requests: true,
            review: true,
            done: false,
            queue: true,
            blocked: true,
            deferred: true
        }
    );
    let t = render_queue(&golden_view(), &default);
    assert!(!t.contains("Done"), "{t}");
    assert!(t.contains("Queue:\n") && t.contains("Blocked:\n"), "{t}");
    // rag-t0024: review is listed by default, first, before the queue.
    assert!(
        t.starts_with("ubu: 0 requests, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged\nRequests: none\nReview:\n  ◆ ubu-t0048 [dev] Heat power m01 · review · approval: owner\nQueue:\n"),
        "{t}"
    );
    assert!(t.contains("Blocked:\n  ○ ubu-t0046 [design] Icons · pending · blocked: redesign: waiting on the owner's pick\nDeferred:\n  ◌ ubu-t0047 "), "{t}");
    assert!(!t.contains("more queued"), "{t}");
    assert!(t.ends_with("\nNot shown: 1 done not acknowledged"), "{t}");

    // Thirty pending rows: twenty listed, the cut said, the rest counted.
    let queue: Vec<Value> = (1..=30)
        .map(|i| it(&format!("p-t{i:04}"), "dev", "Work", "pending"))
        .collect();
    let long = json!({"project": "p", "exists": true, "done": [], "queue": queue, "blocked": []});
    let t = render_queue(&long, &default);
    assert!(t.contains("○ p-t0020 ") && !t.contains("○ p-t0021 "), "{t}");
    assert!(t.contains("\n  … 10 more queued (limit 20)\n"), "{t}");
    assert!(t.ends_with("\nNot shown: 10 pending"), "{t}");
}

#[test]
fn queue_limit_until_gate_and_sections_bound_the_text() {
    let view = golden_view();
    let t = render_queue(
        &view,
        &qopts(json!({"limit": 1, "sections": ["queue"]})).unwrap(),
    );
    assert_eq!(
        t,
        "\
ubu: 0 requests, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged
Queue:
  ● ubu-t0042 [dev] Build the MCP server · in progress · agent: dev-3 · approval: agent · links: milestone:tracker/m02, ledger:rag-0033
  … 3 more queued (limit 1)
Not shown: 1 pending · 1 failed · 1 gate · 1 blocked · 1 deferred · 1 in review · 1 done not acknowledged"
    );

    let t = render_queue(&view, &qopts(json!({"until_gate": true})).unwrap());
    assert_eq!(
        t,
        "\
ubu: 0 requests, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged
Requests: none
Review:
  ◆ ubu-t0048 [dev] Heat power m01 · review · approval: owner
Queue:
  ● ubu-t0042 [dev] Build the MCP server · in progress · agent: dev-3 · approval: agent · links: milestone:tracker/m02, ledger:rag-0033
  ── ubu-t0043 gate: standard · release ──
  … 2 more queued below the gate (until_gate)
Blocked:
  ○ ubu-t0046 [design] Icons · pending · blocked: redesign: waiting on the owner's pick
Deferred:
  ◌ ubu-t0047 [dev] Later idea · deferred
Not shown: 1 pending · 1 failed · 1 done not acknowledged"
    );

    // A limit that lands exactly on the end, or a gate at the bottom, cuts nothing.
    let t = render_queue(&view, &qopts(json!({"limit": 4})).unwrap());
    assert!(!t.contains("more queued"), "{t}");

    // The counts alone.
    let t = render_queue(&view, &qopts(json!({"sections": []})).unwrap());
    assert_eq!(
        t,
        "ubu: 0 requests, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged\n\
         Not shown: 1 pending · 1 in progress · 1 failed · 1 gate · 1 blocked · 1 deferred · 1 in review · 1 done not acknowledged"
    );
}

#[test]
fn until_gate_passes_a_running_gate() {
    let mut running = it("p-t0001", "gate", "Quick gate", "in_progress");
    running["intensity"] = json!("quick");
    let mut next = it("p-t0003", "gate", "Full gate", "pending");
    next["intensity"] = json!("full");
    let view = json!({"project": "p", "exists": true, "done": [], "blocked": [], "queue": [
        running, it("p-t0002", "dev", "A", "pending"), next, it("p-t0004", "dev", "B", "pending")
    ]});
    let t = render_queue(&view, &qopts(json!({"until_gate": true})).unwrap());
    assert!(t.contains("── p-t0001 gate: quick · in progress ──"), "{t}");
    assert!(
        t.contains("── p-t0003 gate: full ──\n  … 1 more queued below the gate (until_gate)"),
        "{t}"
    );
}

#[test]
fn queue_and_next_options_refuse_bad_values() {
    assert!(qopts(json!({"limit": 0}))
        .unwrap_err()
        .contains("at least 1"));
    assert!(qopts(json!({"sections": ["todo"]}))
        .unwrap_err()
        .contains("unknown section \"todo\""));
    assert!(qopts(json!({"sections": [" Done "]})).unwrap().done);
    let d = qopts(json!({"sections": ["deferred"]})).unwrap();
    assert!(d.deferred && !d.queue && !d.blocked && !d.done);
    let next = |f: Value| next_opts(&serde_json::from_value::<TrackerNextArgs>(f).unwrap());
    assert_eq!(next(json!({})).unwrap(), (1, None));
    assert_eq!(
        next(json!({"n": 3, "type": "Dev"})).unwrap(),
        (3, Some("dev".into()))
    );
    assert!(next(json!({"n": 0})).unwrap_err().contains("at least 1"));
    assert!(next(json!({"type": "bug"}))
        .unwrap_err()
        .contains("unknown type \"bug\""));
}

/// A queue of `(id, type, status)` rows for the `tracker_next` tests; a gate is
/// standard, every item has a one-line body.
fn next_view(rows: &[(&str, &str, &str)], blocked: usize, done: usize) -> Value {
    let queue: Vec<Value> = rows
        .iter()
        .map(|(id, ty, status)| {
            let mut v = it(id, ty, &format!("Title {id}"), status);
            if *ty == "gate" {
                v["intensity"] = json!("standard");
            }
            v["body"] = json!(format!("Brief for {id}.\n"));
            v
        })
        .collect();
    let blocked: Vec<Value> = (0..blocked)
        .map(|i| {
            let mut v = it(&format!("p-t09{i:02}"), "dev", "Stuck", "pending");
            v["blocked"] = json!(true);
            v
        })
        .collect();
    let done: Vec<Value> = (0..done)
        .map(|i| it(&format!("p-t08{i:02}"), "dev", "Old", "done"))
        .collect();
    json!({"project": "p", "exists": true, "done": done, "queue": queue, "blocked": blocked})
}

#[test]
fn next_never_returns_a_deferred_item() {
    // rag-t0017: the server lists deferred items in their own section; even a
    // deferred row in the queue (which the server never sends) is passed over.
    let mut view = next_view(&[("p-t0001", "dev", "pending")], 0, 0);
    let mut d = it("p-t0002", "dev", "Later", "deferred");
    d["body"] = json!("Brief.\n");
    view["deferred"] = json!([d.clone()]);
    let t = render_next(&view, 5, None);
    assert!(
        t.starts_with("p: the next 1 of 1 dispatchable ticket"),
        "{t}"
    );
    assert!(!t.contains("p-t0002"), "{t}");
    assert!(t.ends_with("Not shown: 1 deferred"), "{t}");
    // Only deferred work: nothing dispatchable.
    let mut only = next_view(&[], 0, 0);
    only["deferred"] = json!([d.clone()]);
    let t = render_next(&only, 1, None);
    assert!(
        t.contains("nothing dispatchable: the queue is empty"),
        "{t}"
    );
    let mut stray = next_view(&[], 0, 0);
    stray["queue"] = json!([d]);
    let t = render_next(&stray, 1, None);
    assert!(!t.contains("-----"), "{t}");
}

#[test]
fn next_never_returns_a_review_item_and_it_holds_a_gate_as_a_blocked_one_does() {
    // rag-t0024: a review item is in its own section, never offered, and like a
    // blocked item (outside the walk) it does not hold the gate below it.
    let mut r = it("p-t0002", "dev", "Confirm me", "review");
    r["body"] = json!("Brief.\n");
    let mut view = next_view(&[("p-t0001", "dev", "pending")], 0, 0);
    view["review"] = json!([r.clone()]);
    let t = render_next(&view, 5, None);
    assert!(
        t.starts_with("p: the next 1 of 1 dispatchable ticket"),
        "{t}"
    );
    assert!(!t.contains("p-t0002"), "{t}");
    assert!(t.ends_with("Not shown: 1 in review"), "{t}");
    // A gate with only review (and blocked) work above it is the next job: the
    // same answer as with only blocked work above it.
    let mut gated = next_view(&[("p-t0004", "gate", "pending")], 1, 0);
    let blocked_only = render_next(&gated, 1, None);
    gated["review"] = json!([r.clone()]);
    let t = render_next(&gated, 1, None);
    assert_eq!(
        t.lines().next(),
        blocked_only.lines().next(),
        "{t}\n---\n{blocked_only}"
    );
    assert!(
        t.starts_with(
            "p: the next job is gate p-t0004 (gate: standard): nothing is queued above it"
        ),
        "{t}"
    );
    assert!(t.ends_with("Not shown: 1 blocked · 1 in review"), "{t}");
    // Even a review row in the queue (which the server never sends) is not offered.
    let mut stray = next_view(&[], 0, 0);
    stray["queue"] = json!([r]);
    let t = render_next(&stray, 1, None);
    assert!(!t.contains("-----"), "{t}");
}

#[test]
fn the_review_section_is_asked_for_by_name() {
    let o = qopts(json!({"sections": ["Review"]})).unwrap();
    assert!(o.review && !o.queue && !o.blocked && !o.deferred && !o.done);
    let t = render_queue(&golden_view(), &o);
    assert!(t.contains("\nReview:\n  ◆ ubu-t0048 "), "{t}");
    assert!(!t.contains("Queue:"), "{t}");
    let e = qopts(json!({"sections": ["approval"]})).unwrap_err();
    assert!(
        e.contains("review, done, queue, blocked or deferred"),
        "{e}"
    );
}

#[test]
fn next_is_golden() {
    let view = next_view(
        &[
            ("p-t0001", "dev", "in_progress"),
            ("p-t0002", "dev", "pending"),
            ("p-t0003", "recon", "pending"),
            ("p-t0004", "gate", "pending"),
            ("p-t0005", "dev", "pending"),
        ],
        1,
        2,
    );
    let mut with_links = view.clone();
    with_links["queue"][1]["links"] = json!([{"kind": "ledger", "target": "rag-0033"}]);
    with_links["queue"][1]["approval"] = json!("owner");
    assert_eq!(
        render_next(&with_links, 1, None),
        "\
p: the next 1 of 2 dispatchable tickets before gate p-t0004 (gate: standard)

○ p-t0002 [dev] Title p-t0002 · pending · approval: owner · links: ledger:rag-0033
-----
Brief for p-t0002.
-----

Not shown: 2 pending · 1 in progress · 1 gate · 1 blocked · 2 done not acknowledged"
    );
    // n larger than the batch: the batch, and never past the gate.
    let t = render_next(&view, 10, None);
    assert!(
        t.starts_with("p: the next 2 of 2 dispatchable tickets before gate p-t0004"),
        "{t}"
    );
    assert!(t.contains("○ p-t0002 ") && t.contains("○ p-t0003 "), "{t}");
    assert!(!t.contains("○ p-t0005 "), "{t}");
    assert!(
        t.ends_with(
            "Not shown: 1 pending · 1 in progress · 1 gate · 1 blocked · 2 done not acknowledged"
        ),
        "{t}"
    );
    // The type filter passes over the recon item without being held by it.
    let t = render_next(&view, 5, Some("recon"));
    assert!(
        t.starts_with("p: the next 1 of 1 dispatchable recon ticket before gate p-t0004"),
        "{t}"
    );
    assert!(t.contains("○ p-t0003 ") && !t.contains("○ p-t0002 "), "{t}");
}

#[test]
fn a_gate_at_the_top_is_the_next_job() {
    let view = next_view(
        &[
            ("p-t0004", "gate", "pending"),
            ("p-t0005", "dev", "pending"),
        ],
        0,
        0,
    );
    assert_eq!(
        render_next(&view, 3, None),
        "\
p: the next job is gate p-t0004 (gate: standard): nothing is queued above it

○ p-t0004 [gate: standard] Title p-t0004 · pending
-----
Brief for p-t0004.
-----

Not shown: 1 pending"
    );
    assert_eq!(
        render_next(&view, 1, Some("gate")).lines().next().unwrap(),
        "p: the next job is gate p-t0004 (gate: standard): nothing is queued above it"
    );
    // Filtered out, it is named but not returned, and nothing below it is.
    assert_eq!(
        render_next(&view, 1, Some("dev")),
        "p: nothing dispatchable (type dev): the next job is gate p-t0004 (gate: standard)\n\nNot shown: 1 pending · 1 gate"
    );
}

#[test]
fn a_gate_waits_on_the_work_above_it() {
    // In progress and failed above the gate: nothing to dispatch, the gate is held.
    let view = next_view(
        &[
            ("p-t0001", "dev", "in_progress"),
            ("p-t0002", "analysis", "failed"),
            ("p-t0004", "gate", "pending"),
            ("p-t0005", "dev", "pending"),
        ],
        0,
        0,
    );
    assert_eq!(
        render_next(&view, 1, None),
        "p: nothing dispatchable: gate p-t0004 (gate: standard) waits on 1 in progress, 1 failed above it\n\n\
         Not shown: 1 pending · 1 in progress · 1 failed · 1 gate"
    );
    // Pending items of another type hold the gate too, and say so.
    let view = next_view(
        &[
            ("p-t0003", "recon", "pending"),
            ("p-t0004", "gate", "pending"),
        ],
        0,
        0,
    );
    assert!(render_next(&view, 1, Some("gate"))
        .starts_with("p: nothing dispatchable (type gate): gate p-t0004 (gate: standard) waits on 1 pending of other types above it"));
    // A failed gate at the top holds the queue.
    let view = next_view(
        &[("p-t0004", "gate", "failed"), ("p-t0005", "dev", "pending")],
        0,
        0,
    );
    assert!(render_next(&view, 1, None).starts_with(
        "p: nothing dispatchable: gate p-t0004 (gate: standard) is failed and holds the queue"
    ));
}

#[test]
fn a_running_gate_is_passed_over_but_holds_the_next_gate() {
    // The batch after a running gate is dispatchable.
    let view = next_view(
        &[
            ("p-t0001", "gate", "in_progress"),
            ("p-t0002", "dev", "pending"),
            ("p-t0003", "gate", "pending"),
        ],
        0,
        0,
    );
    let t = render_next(&view, 1, None);
    assert!(
        t.starts_with("p: the next 1 of 1 dispatchable ticket before gate p-t0003"),
        "{t}"
    );
    assert!(t.ends_with("Not shown: 2 gates"), "{t}");
    // Two gates back to back: the second waits on the first.
    let view = next_view(
        &[
            ("p-t0001", "gate", "in_progress"),
            ("p-t0003", "gate", "pending"),
        ],
        0,
        0,
    );
    assert!(render_next(&view, 1, None).starts_with(
        "p: nothing dispatchable: gate p-t0003 (gate: standard) waits on 1 in progress above it"
    ));
}

#[test]
fn next_with_no_gate_or_nothing_pending() {
    let view = next_view(
        &[("p-t0001", "dev", "pending"), ("p-t0002", "dev", "pending")],
        0,
        0,
    );
    let t = render_next(&view, 1, None);
    assert!(
        t.starts_with("p: the next 1 of 2 dispatchable tickets (no gate below them)"),
        "{t}"
    );
    assert!(t.ends_with("Not shown: 1 pending"), "{t}");
    let mut no_body = view.clone();
    no_body["queue"][0]["body"] = json!("");
    assert!(render_next(&no_body, 1, None).contains("-----\n(no body)\n-----"));

    let busy = next_view(&[("p-t0001", "dev", "in_progress")], 2, 0);
    assert_eq!(
        render_next(&busy, 1, None),
        "p: nothing dispatchable: the queue holds 1 in progress\n\nNot shown: 1 in progress · 2 blocked"
    );
    let empty = next_view(&[], 0, 1);
    assert_eq!(
        render_next(&empty, 1, None),
        "p: nothing dispatchable: the queue is empty\n\nNot shown: 1 done not acknowledged"
    );
}

#[test]
fn a_running_gate_shows_its_state_on_the_marker() {
    let mut gate = it("p-t0009", "gate", "Full gate", "in_progress");
    gate["intensity"] = json!("full");
    gate["assignee"] = json!("gate-1");
    assert_eq!(
        gate_marker(&gate),
        "── p-t0009 gate: full · in progress · agent: gate-1 ──"
    );
    assert_eq!(
        item_line(&gate),
        "● p-t0009 [gate: full] Full gate · in progress · agent: gate-1"
    );
}

#[test]
fn a_document_shows_the_revision_to_edit_against() {
    let v = json!({
        "id": "p-d0002", "path": "concepts/terrain.md", "kind": "concept", "title": "Terrain",
        "revision": 4, "body_revision": 2, "concept": "terrain", "spec": null, "milestone": null,
        "updated_at": "2026-10-27T06:00:00Z", "body": "# Terrain\nold text",
        "redirected_from": "concepts/land.md",
        "events": [{"ts": "2026-10-27T06:00:00Z", "kind": "edit", "agent": "Claude Test",
                    "surface": "mcp", "author_email": "dev@example.com", "body": "tightened"}]
    });
    let t = render_doc(&v);
    assert!(
        t.starts_with("p-d0002 · concepts/terrain.md · concept · Terrain\n"),
        "{t}"
    );
    assert!(t.contains("revision 4 (edit with base_revision 4)"), "{t}");
    assert!(
        t.contains("showing revision 2, an older body (the current revision is 4)"),
        "{t}"
    );
    assert!(t.contains("redirected from concepts/land.md"), "{t}");
    assert!(t.contains("belongs to concept terrain"), "{t}");
    assert!(t.contains("-----\n# Terrain\nold text\n-----"), "{t}");
    assert!(t.contains("History:\n  2026-10-27T06:00:00Z edit · Claude Test via mcp (dev@example.com) · tightened"), "{t}");
}

// ---- One-line write replies (rag-t0039) ---------------------------------------------

/// An item as a write returns it, its last event `event`.
fn written_item(id: &str, prev: Value, next: Value, event: Value) -> Value {
    json!({
        "id": id, "type": "dev", "title": "Build it", "status": "pending",
        "prev_id": prev, "next_id": next,
        "events": [{"event_id": 1, "kind": "create", "fields": {}}, event]
    })
}

#[test]
fn a_write_answers_with_one_line() {
    // A create names what it made and where it joined.
    let created = json!({
        "id": "p-t0002", "type": "dev", "title": "Build it", "status": "pending",
        "prev_id": "p-t0001", "next_id": null,
        "events": [{"event_id": 7, "kind": "create", "fields": {"title": "Build it"}, "before": null}]
    });
    assert_eq!(
        write_line(&created),
        "ok created p-t0002 [dev] \"Build it\" after p-t0001 (#7)"
    );
    let gate = json!({
        "id": "p-t0003", "type": "gate", "intensity": "standard", "release": true,
        "title": "Gate", "status": "pending", "prev_id": null, "next_id": "p-t0001",
        "events": [{"event_id": 8, "kind": "create", "fields": {}}]
    });
    assert_eq!(
        write_line(&gate),
        "ok created p-t0003 [gate: standard · release] \"Gate\" at the top (#8)"
    );
    // An update says what changed, from → to.
    let status = written_item(
        "p-t0002",
        json!(null),
        json!(null),
        json!({"event_id": 9, "kind": "status",
               "fields": {"status": "in_progress", "assignee": "dev-1"},
               "before": {"status": "pending", "assignee": null}}),
    );
    assert_eq!(
        write_line(&status),
        "ok p-t0002 status: pending → in_progress; assignee: none → dev-1 (#9)"
    );
    // A server from before rag-t0038 records no `before`: the new value alone.
    let old_server = written_item(
        "p-t0002",
        json!(null),
        json!(null),
        json!({"event_id": 9, "kind": "status", "fields": {"status": "done"}}),
    );
    assert_eq!(write_line(&old_server), "ok p-t0002 status: done (#9)");
    let note = written_item(
        "p-t0002",
        json!(null),
        json!(null),
        json!({"event_id": 10, "kind": "note", "body": "half done", "fields": {}}),
    );
    assert_eq!(write_line(&note), "ok p-t0002 note (#10)");
    let moved = written_item(
        "p-t0002",
        json!(null),
        json!(null),
        json!({"event_id": 11, "kind": "move", "fields": {"prev_id": null},
               "before": {"prev_id": "p-t0001"}}),
    );
    assert_eq!(
        write_line(&moved),
        "ok p-t0002 moved: after p-t0001 → top (#11)"
    );
    // Records: a spec with its milestones' documents, a milestone, a concept,
    // a document.
    let spec = json!({
        "slug": "audio", "title": "Audio", "state": "draft", "doc_id": "p-d0001",
        "path": "specs/audio/master.md",
        "milestones": [{"spec": "audio", "code": "m01", "doc_id": "p-d0002",
                        "path": "specs/audio/m01-sfx.md"}],
        "events": [{"event_id": 12, "kind": "create", "fields": {}}]
    });
    assert_eq!(
        write_line(&spec),
        "ok created spec:audio (p-d0001 specs/audio/master.md); milestone:audio/m01 \
         (p-d0002 specs/audio/m01-sfx.md) (#12)"
    );
    let ready = json!({
        "slug": "audio", "state": "ready", "milestones": [],
        "events": [{"event_id": 13, "kind": "edit", "fields": {"state": "ready"},
                    "before": {"state": "draft"}}]
    });
    assert_eq!(
        write_line(&ready),
        "ok spec:audio state: draft → ready (#13)"
    );
    let milestone = json!({
        "spec": "audio", "code": "m02", "doc_id": "p-d0003", "path": "specs/audio/m02-music.md",
        "events": [{"event_id": 14, "kind": "create", "fields": {}}]
    });
    assert_eq!(
        write_line(&milestone),
        "ok created milestone:audio/m02 (p-d0003 specs/audio/m02-music.md) (#14)"
    );
    let concept = json!({
        "slug": "terrain", "links": [], "doc_id": "p-d0004", "path": "concepts/terrain.md",
        "events": [{"event_id": 15, "kind": "link", "fields": {"links_added": [{"kind": "spec", "target": "audio"}]},
                    "before": {}}]
    });
    assert_eq!(
        write_line(&concept),
        "ok concept:terrain links: +spec:audio (#15)"
    );
    let doc = json!({
        "id": "p-d0005", "path": "notes/a.md", "kind": "doc", "revision": 1,
        "events": [{"event_id": 16, "kind": "create", "fields": {}}]
    });
    assert_eq!(write_line(&doc), "ok created p-d0005 notes/a.md r1 (#16)");
    // Acknowledging, and a record with no event to read.
    let ack = json!({"project": "p", "acknowledged": ["p-t0001", "p-t0002"]});
    assert_eq!(
        write_line(&ack),
        "ok p: acknowledged 2 done tickets: p-t0001, p-t0002"
    );
    let none = json!({"project": "p", "acknowledged": []});
    assert_eq!(write_line(&none), "ok p: nothing to acknowledge");
    let bare = json!({"id": "p-t0002", "type": "dev", "status": "done"});
    assert_eq!(write_line(&bare), "ok p-t0002 written");
    // Every reply is one line, far shorter than the record.
    for v in [&created, &status, &spec, &ack] {
        let line = write_line(v);
        assert!(!line.contains('\n'), "{line}");
        assert!(line.len() < v.to_string().len(), "{line}");
    }
}

// ---- The split tools and their arguments (rag-t0039) --------------------------------------

#[test]
fn links_are_kind_colon_target() {
    assert!(links_of(None).unwrap().is_none());
    let got = links_of(Some(vec![
        "ledger:rag-0033".into(),
        " milestone : audio/m01 ".into(),
    ]))
    .unwrap()
    .unwrap();
    assert_eq!(
        serde_json::to_value(&got).unwrap(),
        json!([{"kind": "ledger", "target": "rag-0033"}, {"kind": "milestone", "target": "audio/m01"}])
    );
    for bad in ["rag-0033", ":x", "spec:", "  "] {
        let e = links_of(Some(vec![bad.into()])).unwrap_err();
        assert!(e.contains("is kind:target"), "{bad}: {e}");
    }
}

#[test]
fn create_takes_items_and_create_record_the_rest() {
    let item = CreateItemArgs {
        item_type: "gate".into(),
        title: "Standard gate".into(),
        intensity: Some("standard".into()),
        links: Some(vec!["item:p-t0001".into()]),
        top: Some(true),
        ..Default::default()
    };
    let all = TrackerCreateArgs::try_from(item).unwrap();
    let r = create_req(&all, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/items");
    assert_eq!(
        *body,
        with_author(json!({
            "type": "gate", "title": "Standard gate", "intensity": "standard",
            "links": [{"kind": "item", "target": "p-t0001"}], "top": true
        }))
    );
    let bad_link = CreateItemArgs {
        item_type: "dev".into(),
        title: "x".into(),
        links: Some(vec!["p-t0001".into()]),
        ..Default::default()
    };
    assert!(TrackerCreateArgs::try_from(bad_link).is_err());

    let spec = CreateRecordArgs {
        kind: " Spec ".into(),
        title: "Audio".into(),
        slug: Some("audio".into()),
        ..Default::default()
    };
    let all = TrackerCreateArgs::try_from(spec).unwrap();
    assert_eq!(
        post_of(&create_req(&all, Some("p"), &who()).unwrap()).0,
        "/tracker/p/specs"
    );
    for kind in ["item", "gate"] {
        let e = TrackerCreateArgs::try_from(CreateRecordArgs {
            kind: kind.into(),
            title: "x".into(),
            ..Default::default()
        })
        .unwrap_err();
        assert!(e.contains("tracker_create"), "{e}");
    }
    // A field that does not apply to the kind is still refused by the builder.
    let doc = CreateRecordArgs {
        kind: "doc".into(),
        title: "A".into(),
        path: Some("a.md".into()),
        slug: Some("a".into()),
        ..Default::default()
    };
    let all = TrackerCreateArgs::try_from(doc).unwrap();
    assert!(create_req(&all, Some("p"), &who())
        .unwrap_err()
        .contains("`slug` does not apply to a doc"));
}

#[test]
fn update_takes_items_and_update_record_the_rest() {
    let item = UpdateItemArgs {
        id: "p-t0004".into(),
        status: Some("in_progress".into()),
        add_links: Some(vec!["spec:tracker".into()]),
        ..Default::default()
    };
    let all = TrackerUpdateArgs::try_from(item).unwrap();
    assert_eq!(
        *post_of(&update_req(&all, None, &who()).unwrap()).1,
        with_author(json!({
            "status": "in_progress", "add_links": [{"kind": "spec", "target": "tracker"}]
        }))
    );
    for (id, says) in [
        ("spec:audio", "tracker_update_record"),
        ("milestone:audio/m01", "tracker_update_record"),
        ("p-d0001", "tracker_doc_edit"),
        ("nonsense", "not a tracker reference"),
    ] {
        let e = TrackerUpdateArgs::try_from(UpdateItemArgs {
            id: id.into(),
            note: Some("x".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(e.contains(says), "{id}: {e}");
    }
    let record = UpdateRecordArgs {
        id: "concept:terrain".into(),
        project: Some("p".into()),
        remove_links: Some(vec!["ledger:rag-0033".into()]),
        ..Default::default()
    };
    let all = TrackerUpdateArgs::try_from(record).unwrap();
    let r = update_req(&all, Some("p"), &who()).unwrap();
    assert_eq!(
        post_of(&r),
        (
            "/tracker/p/concepts/terrain",
            &with_author(json!({"remove_links": [{"kind": "ledger", "target": "rag-0033"}]}))
        )
    );
    for (id, says) in [
        ("p-t0001", "tracker_update"),
        ("specs/a/master.md", "tracker_doc_edit"),
    ] {
        let e = TrackerUpdateArgs::try_from(UpdateRecordArgs {
            id: id.into(),
            title: Some("x".into()),
            ..Default::default()
        })
        .unwrap_err();
        assert!(e.contains(says), "{id}: {e}");
    }
}

// ---- History off by default (rag-t0039) ----------------------------------------------

#[test]
fn history_is_none_by_default_all_or_the_last_n() {
    assert_eq!(history_of(None), Ok(History::None));
    assert_eq!(history_of(Some(&json!(false))), Ok(History::None));
    assert_eq!(history_of(Some(&json!(0))), Ok(History::None));
    assert_eq!(history_of(Some(&json!(true))), Ok(History::All));
    assert_eq!(history_of(Some(&json!(3))), Ok(History::Last(3)));
    for bad in [json!(-1), json!(1.5), json!("3"), json!([1])] {
        assert!(history_of(Some(&bad)).is_err(), "{bad}");
    }
    let record =
        || json!({"id": "p-t0001", "events": [{"event_id": 1}, {"event_id": 2}, {"event_id": 3}]});
    let mut v = record();
    trim_history(&mut v, History::None);
    assert_eq!(v, json!({"id": "p-t0001"}));
    let mut v = record();
    trim_history(&mut v, History::All);
    assert_eq!(v, record());
    let mut v = record();
    trim_history(&mut v, History::Last(2));
    assert_eq!(
        v,
        json!({"id": "p-t0001", "events": [{"event_id": 2}, {"event_id": 3}], "events_omitted": 1})
    );
    let mut v = record();
    trim_history(&mut v, History::Last(5));
    assert_eq!(v, record(), "nothing omitted, nothing said");
}

/// An item with five events; `?history=false` empties them, as rag-serve does.
async fn item_view(
    AxPath(id): AxPath<String>,
    axum::extract::RawQuery(q): axum::extract::RawQuery,
) -> impl IntoResponse {
    let events: Vec<Value> = if q.as_deref() == Some("history=false") {
        Vec::new()
    } else {
        (1..=5)
            .map(|i| json!({"event_id": i, "kind": "note"}))
            .collect()
    };
    Json(json!({"id": id, "type": "dev", "status": "pending", "query": q, "events": events}))
}

#[tokio::test]
async fn tracker_get_leaves_the_history_out_unless_asked() {
    let app = Router::new().route("/tracker/items/{id}", get(item_view));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let server = TrackerServer::new(
        reqwest::Client::new(),
        &format!("http://{addr}"),
        Transport::Gateway,
    );
    let get_with = |history: Option<Value>| {
        let server = server.clone();
        async move {
            let out = server
                .tracker_get(Parameters(TrackerGetArgs {
                    id: "p-t0001".into(),
                    project: None,
                    history,
                }))
                .await;
            out.map(|r| serde_json::from_str::<Value>(&texts(&r)).unwrap())
        }
    };
    let none = get_with(None).await.unwrap();
    assert_eq!(
        none["query"], "history=false",
        "the server is not asked for it"
    );
    assert!(none.get("events").is_none(), "{none}");
    let last = get_with(Some(json!(2))).await.unwrap();
    assert_eq!(last["query"], Value::Null);
    assert_eq!(
        last["events"],
        json!([{"event_id": 4, "kind": "note"}, {"event_id": 5, "kind": "note"}])
    );
    assert_eq!(last["events_omitted"], 3);
    let all = get_with(Some(json!(true))).await.unwrap();
    assert_eq!(all["events"].as_array().unwrap().len(), 5);
    assert!(get_with(Some(json!("all"))).await.is_err());
}

// ---- The tool list's size (rag-t0039) ------------------------------------------------

#[test]
fn compacting_a_schema_keeps_what_it_describes() {
    let mut v = json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Args",
        "type": "object",
        "properties": {
            "title": {"type": ["string", "null"], "description": "kept: a property"},
            "n": {"type": ["integer", "null"], "format": "uint32", "minimum": 0},
            "low": {"type": "integer", "minimum": 1},
            "either": {"type": ["boolean", "integer"]},
            "inner": {"anyOf": [{"$ref": "#/$defs/X"}, {"type": "null"}], "description": "d"}
        },
        "required": ["title"]
    });
    compact_schema(&mut v);
    assert_eq!(
        v,
        json!({
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "kept: a property"},
                "n": {"type": "integer"},
                "low": {"type": "integer", "minimum": 1},
                "either": {"type": ["boolean", "integer"]},
                "inner": {"$ref": "#/$defs/X", "description": "d"}
            },
            "required": ["title"]
        })
    );
}

#[test]
fn the_tool_list_is_lean_and_says_the_rules_once() {
    let server = TrackerServer::new(reqwest::Client::new(), "http://unused", Transport::Stdio);
    let tools = server.tool_router.list_all();
    let mut names: Vec<&str> = tools.iter().map(|t| t.name.as_ref()).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "tracker_ack_done",
            "tracker_attach",
            "tracker_attachment_get",
            "tracker_create",
            "tracker_create_record",
            "tracker_doc_edit",
            "tracker_doc_get",
            "tracker_get",
            "tracker_list",
            "tracker_move",
            "tracker_next",
            "tracker_queue",
            "tracker_update",
            "tracker_update_record",
        ]
    );
    // Measured 2026-10-27: 31.8k characters for twelve tools before, 10.4k for
    // fourteen after. The budget is the ~2.5k-token target with a little room.
    // rag-t0044 (the request type) took the tools from 10,421 to 10,456 and the
    // instructions from 1,302 to 1,560 characters (the manager's routine).
    // rag-t0050 (the word "ticket" for a queue record): 10,456 → 10,458 and
    // 1,560 → 1,564.
    let size: usize = tools
        .iter()
        .map(|t| serde_json::to_string(t).unwrap().len())
        .sum();
    assert!(size < 11_500, "the tool list grew to {size} characters");
    for t in &tools {
        let json = serde_json::to_string(t).unwrap();
        for noise in ["$schema", "\"null\"", "uint32", "WHO MAY CALL", "Unknown"] {
            assert!(!json.contains(noise), "{} carries {noise}: {json}", t.name);
        }
        assert!(
            t.description.as_deref().unwrap_or_default().len() <= 300,
            "{}",
            t.name
        );
    }
    // The rules every write shares are in the instructions, once.
    let info = server.get_info();
    let rules = info.instructions.as_deref().unwrap_or_default();
    for rule in [
        "Pass agent",
        "recorded as Unknown",
        "approval owner only when the owner approved",
        "ratified only from agent",
        "A note is optional",
        "tracker_next after each job",
        "tracker_queue for a status report",
        // rag-t0044: the manager's routine for a request.
        "{type: request}",
        "from:<request id>",
        "approval defaults to agent",
        "place them as it says (else the bottom)",
        "done with a note listing them",
    ] {
        assert!(rules.contains(rule), "the instructions lack {rule:?}");
    }
    assert!(rules.len() < 1_600, "{}", rules.len());
    // rag-t0050: the prose says "ticket"; "item" survives only as an API value
    // (`what=items`, the link kind `item:`), never as the word for a record.
    let says_item = |text: &str| {
        text.split(|c: char| !c.is_ascii_alphanumeric())
            .any(|w| w.eq_ignore_ascii_case("item") || w.eq_ignore_ascii_case("items"))
    };
    assert!(!says_item(rules), "the instructions say item: {rules}");
    assert!(rules.contains("tickets of type dev"), "{rules}");
    for t in &tools {
        if t.name == "tracker_list" {
            continue; // lists the `what` values, `items` among them
        }
        let d = t.description.as_deref().unwrap_or_default();
        assert!(!says_item(d), "{} says item: {d}", t.name);
    }
}

#[test]
fn refusals_carry_the_servers_message() {
    let e = refusal(
        400,
        r#"{"error":"p-t0001 cannot go from done to in_progress"}"#,
    );
    assert_eq!(e.message, "p-t0001 cannot go from done to in_progress");
    let e = refusal(404, "not json");
    assert_eq!(e.message, "not json");
    let e = refusal(
        409,
        r#"{"error":"document p-d0001 is at revision 5, not 3: re-read it and edit against revision 5","current_revision":5,"current":{}}"#,
    );
    assert!(
        e.message
            .starts_with("document p-d0001 is at revision 5, not 3"),
        "{}",
        e.message
    );
    assert!(
        e.message.contains("the current revision is 5"),
        "{}",
        e.message
    );
    assert!(e.message.contains("Nothing was written"), "{}", e.message);
    let e = refusal(503, r#"{"error":"tracker unavailable"}"#);
    assert!(
        e.message.contains("tracker store is not open"),
        "{}",
        e.message
    );
}

// ---- Against a stand-in rag-serve --------------------------------------------------

/// What the stand-in server received and holds.
#[derive(Default)]
struct Seen {
    file: Option<Vec<u8>>,
    file_name: Option<String>,
    file_type: Option<String>,
    fields: Vec<(String, String)>,
}

type Shared = Arc<Mutex<Seen>>;

const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

async fn stale_edit(AxPath(id): AxPath<String>) -> impl IntoResponse {
    (
        StatusCode::CONFLICT,
        Json(json!({
            "error": format!("document {id} is at revision 5, not 3: re-read it and edit against revision 5"),
            "current_revision": 5,
            "current": {"id": id, "revision": 5, "body": "newer"}
        })),
    )
}

async fn upload(State(seen): State<Shared>, mut mp: Multipart) -> impl IntoResponse {
    let mut s = Seen::default();
    while let Some(field) = mp.next_field().await.unwrap() {
        let name = field.name().unwrap_or_default().to_string();
        if name == "file" {
            s.file_name = field.file_name().map(String::from);
            s.file_type = field.content_type().map(String::from);
            s.file = Some(field.bytes().await.unwrap().to_vec());
        } else {
            let v = field.text().await.unwrap();
            s.fields.push((name, v));
        }
    }
    let size = s.file.as_ref().map(Vec::len).unwrap_or(0);
    let name = s
        .fields
        .iter()
        .find(|(k, _)| k == "name")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    *seen.lock().unwrap() = s;
    Json(json!({
        "id": 1, "project": "p", "sha256": HASH, "ref": "att:0123456789ab",
        "name": name, "media_type": "image/png", "size": size
    }))
}

async fn download(State(seen): State<Shared>, AxPath(_hash): AxPath<String>) -> impl IntoResponse {
    let bytes = seen.lock().unwrap().file.clone().unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "image/png".to_string()),
            (
                header::CONTENT_DISPOSITION,
                "inline; filename=\"fixture.png\"".to_string(),
            ),
            (header::ETAG, format!("\"{HASH}\"")),
        ],
        Bytes::from(bytes),
    )
}

/// The queue view: the goldens' view under whatever project was asked for.
async fn queue_view(AxPath(project): AxPath<String>) -> impl IntoResponse {
    let mut v = golden_view();
    v["project"] = json!(project);
    Json(v)
}

/// Serve the stand-in on a free local port; returns its base URL and what it saw.
async fn stand_in() -> (String, Shared) {
    let seen: Shared = Arc::default();
    let app = Router::new()
        .route("/tracker/docs/{id}/edit", post(stale_edit))
        .route("/tracker/{project}/attachments", post(upload))
        .route("/tracker/attachments/{hash}", get(download))
        .route("/tracker/{project}", get(queue_view))
        .with_state(seen.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), seen)
}

/// A small PNG-shaped fixture (the stand-in does not decode it).
fn fixture_png() -> Vec<u8> {
    let mut b = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    b.extend((0u8..=255).cycle().take(4096));
    b
}

#[tokio::test]
async fn a_stale_edit_returns_the_refusal_and_the_current_revision() {
    let (base, _) = stand_in().await;
    let server = TrackerServer::new(reqwest::Client::new(), &base, Transport::Stdio);
    let args = TrackerDocEditArgs {
        doc: "p-d0001".into(),
        base_revision: Some(3),
        replacements: Some(vec![ReplacementArg {
            old: "a".into(),
            new: "b".into(),
        }]),
        agent: Some("Claude Test".into()),
        ..Default::default()
    };
    let e = server
        .tracker_doc_edit(Parameters(args))
        .await
        .expect_err("a stale base is refused");
    assert!(
        e.message
            .contains("document p-d0001 is at revision 5, not 3"),
        "{}",
        e.message
    );
    assert!(
        e.message.contains("the current revision is 5"),
        "{}",
        e.message
    );
}

#[tokio::test]
async fn an_attachment_round_trips_over_stdio() {
    let (base, seen) = stand_in().await;
    let server = TrackerServer::new(reqwest::Client::new(), &base, Transport::Stdio);
    let dir = tempfile::tempdir().unwrap();
    let src = dir.path().join("terrain.png");
    let bytes = fixture_png();
    std::fs::write(&src, &bytes).unwrap();

    let r = server
        .tracker_attach(Parameters(TrackerAttachArgs {
            project: Some("p".into()),
            path: Some(src.display().to_string()),
            agent: Some("Claude Test".into()),
            ..Default::default()
        }))
        .await
        .unwrap();
    assert_eq!(
        texts(&r),
        format!(
            "ok att:0123456789ab terrain.png image/png {} B: embed as \
             ![terrain.png](att:0123456789ab)",
            bytes.len()
        ),
        "one line (rag-t0039)"
    );
    {
        let s = seen.lock().unwrap();
        assert_eq!(s.file.as_deref(), Some(bytes.as_slice()));
        assert_eq!(s.file_name.as_deref(), Some("terrain.png"));
        assert_eq!(s.file_type.as_deref(), Some("application/octet-stream"));
        let field = |k: &str| {
            s.fields
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.clone())
        };
        assert_eq!(field("surface").as_deref(), Some("mcp"));
        assert_eq!(field("agent").as_deref(), Some("Claude Test"));
        assert_eq!(field("name").as_deref(), Some("terrain.png"));
        assert!(field("author_email").is_some());
    }

    let out = dir.path().join("back").join("copy.png");
    let r = server
        .tracker_attachment_get(Parameters(TrackerAttachmentGetArgs {
            reference: "att:0123456789ab".into(),
            out_path: Some(out.display().to_string()),
        }))
        .await
        .unwrap();
    assert!(texts(&r).contains(&format!("Written to {}", out.display())));
    assert_eq!(
        std::fs::read(&out).unwrap(),
        bytes,
        "the same bytes come back"
    );
}

#[tokio::test]
async fn the_gateway_takes_and_returns_base64_only() {
    let (base, seen) = stand_in().await;
    let server = TrackerServer::new(reqwest::Client::new(), &base, Transport::Gateway);
    // It cannot read the client's disk.
    let e = server
        .tracker_attach(Parameters(TrackerAttachArgs {
            project: Some("p".into()),
            path: Some("/etc/hostname".into()),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert!(
        e.message.contains("cannot read your files"),
        "{}",
        e.message
    );
    // Over 10 MB is refused.
    let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; GATEWAY_MAX_BYTES + 1]);
    let e = server
        .tracker_attach(Parameters(TrackerAttachArgs {
            project: Some("p".into()),
            base64: Some(big),
            name: Some("big.bin".into()),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert!(e.message.contains("over 10 MB"), "{}", e.message);
    // base64 needs a name.
    let bytes = fixture_png();
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    assert!(server
        .tracker_attach(Parameters(TrackerAttachArgs {
            project: Some("p".into()),
            base64: Some(b64.clone()),
            ..Default::default()
        }))
        .await
        .is_err());
    server
        .tracker_attach(Parameters(TrackerAttachArgs {
            project: Some("p".into()),
            base64: Some(b64.clone()),
            name: Some("terrain.png".into()),
            ..Default::default()
        }))
        .await
        .unwrap();
    assert_eq!(seen.lock().unwrap().file.as_deref(), Some(bytes.as_slice()));
    // An image comes back as an image; out_path is refused.
    assert!(server
        .tracker_attachment_get(Parameters(TrackerAttachmentGetArgs {
            reference: "att:0123456789ab".into(),
            out_path: Some("/tmp/x.png".into()),
        }))
        .await
        .is_err());
    let r = server
        .tracker_attachment_get(Parameters(TrackerAttachmentGetArgs {
            reference: "att:0123456789ab".into(),
            out_path: None,
        }))
        .await
        .unwrap();
    assert_eq!(r.content.len(), 2);
    match &r.content[1].raw {
        RawContent::Image(img) => {
            assert_eq!(img.mime_type, "image/png");
            assert_eq!(img.data, b64);
        }
        other => panic!("expected an image, got {other:?}"),
    }
}

// ---- body_path (m05: loading a repository's documents) ---------------------------

#[tokio::test]
async fn body_path_reads_the_local_file_into_the_body() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("master.md");
    std::fs::write(&file, "# Energy\n\nThe ladder.\n").unwrap();
    let mut body = None;
    let mut path = Some(file.to_string_lossy().into_owned());
    inline_body(Transport::Stdio, &mut body, &mut path)
        .await
        .unwrap();
    assert_eq!(body.as_deref(), Some("# Energy\n\nThe ladder.\n"));
    assert_eq!(path, None, "the path is consumed, so no builder sees it");

    // Then the spec request carries it as an ordinary body.
    let sp = TrackerCreateArgs {
        kind: "spec".into(),
        slug: Some("energy".into()),
        title: Some("Energy".into()),
        body,
        ..Default::default()
    };
    let r = create_req(&sp, Some("p"), &who()).unwrap();
    assert_eq!(r.body.unwrap()["body"], json!("# Energy\n\nThe ladder.\n"));
}

#[tokio::test]
async fn body_path_is_refused_with_a_body_over_the_gateway_or_when_unreadable() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.md");
    std::fs::write(&file, "x").unwrap();
    let f = file.to_string_lossy().into_owned();

    let mut body = Some("inline".to_string());
    let e = inline_body(Transport::Stdio, &mut body, &mut Some(f.clone()))
        .await
        .unwrap_err();
    assert!(e.message.contains("not both"), "{}", e.message);

    let e = inline_body(Transport::Gateway, &mut None, &mut Some(f))
        .await
        .unwrap_err();
    assert!(e.message.contains("gateway"), "{}", e.message);

    let missing = dir.path().join("nope.md").to_string_lossy().into_owned();
    let e = inline_body(Transport::Stdio, &mut None, &mut Some(missing))
        .await
        .unwrap_err();
    assert!(e.message.contains("cannot read"), "{}", e.message);

    let binary = dir.path().join("b.md");
    std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
    let e = inline_body(
        Transport::Stdio,
        &mut None,
        &mut Some(binary.to_string_lossy().into_owned()),
    )
    .await
    .unwrap_err();
    assert!(e.message.contains("UTF-8"), "{}", e.message);

    // No path: nothing happens.
    let mut body = Some("kept".to_string());
    inline_body(Transport::Stdio, &mut body, &mut None)
        .await
        .unwrap();
    assert_eq!(body.as_deref(), Some("kept"));
}

#[tokio::test]
async fn next_and_queue_read_the_queue_view_and_refuse_bad_options_first() {
    let (base, _) = stand_in().await;
    let server = TrackerServer::new(reqwest::Client::new(), &base, Transport::Gateway);
    let out = server
        .tracker_next(Parameters(TrackerNextArgs {
            project: Some("ubu".into()),
            ..Default::default()
        }))
        .await
        .unwrap();
    let t = texts(&out);
    // The running item is passed over; the failed and pending ones are below the gate.
    assert!(
        t.starts_with("ubu: nothing dispatchable: gate ubu-t0043 (gate: standard · release) waits on 1 in progress above it"),
        "{t}"
    );
    let out = server
        .tracker_queue(Parameters(TrackerQueueArgs {
            project: Some("ubu".into()),
            limit: Some(2),
            ..Default::default()
        }))
        .await
        .unwrap();
    let t = texts(&out);
    assert!(t.contains("  … 2 more queued (limit 2)"), "{t}");
    assert!(
        t.ends_with("Not shown: 1 pending · 1 failed · 1 done not acknowledged"),
        "{t}"
    );

    // Bad options are refused before any request (no project would also be refused).
    let e = server
        .tracker_next(Parameters(TrackerNextArgs {
            n: Some(0),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert!(e.message.contains("n must be at least 1"), "{}", e.message);
    let e = server
        .tracker_queue(Parameters(TrackerQueueArgs {
            project: Some("ubu".into()),
            sections: Some(vec!["later".into()]),
            ..Default::default()
        }))
        .await
        .unwrap_err();
    assert!(e.message.contains("unknown section"), "{}", e.message);
}

#[test]
fn the_project_list_counts_deferred_apart_from_the_queue_and_blocked() {
    // rag-t0017: `queued` includes blocked and deferred; each is shown once.
    // rag-t0024: and review. rag-t0044: and requests.
    let v = json!({"projects": [
        {"name": "ubu", "queued": 10, "requests": 1, "blocked": 2, "deferred": 1, "review": 2, "done_unacknowledged": 3}
    ]});
    assert_eq!(
        render_list("projects", &v),
        "ubu · 1 request · 2 in review · 4 in the queue · 2 blocked · 1 deferred · 3 done not acknowledged"
    );
    let v = json!({"projects": [
        {"name": "ubu", "queued": 9, "blocked": 2, "deferred": 1, "review": 2, "done_unacknowledged": 3}
    ]});
    assert_eq!(
        render_list("projects", &v),
        "ubu · 0 requests · 2 in review · 4 in the queue · 2 blocked · 1 deferred · 3 done not acknowledged"
    );
    // An older server without the review count reads as none in review.
    let v = json!({"projects": [
        {"name": "ubu", "queued": 7, "blocked": 2, "deferred": 1, "done_unacknowledged": 3}
    ]});
    assert_eq!(
        render_list("projects", &v),
        "ubu · 0 requests · 0 in review · 4 in the queue · 2 blocked · 1 deferred · 3 done not acknowledged"
    );
}

// ---- Parallel past a gate (rag-t0013) and dependencies (rag-t0018) ----------------

/// `next_view` with the rows named in `parallel` marked parallel.
fn parallel_view(rows: &[(&str, &str, &str)], parallel: &[&str]) -> Value {
    let mut view = next_view(rows, 0, 0);
    for row in view["queue"].as_array_mut().unwrap() {
        if parallel.contains(&row["id"].as_str().unwrap()) {
            row["parallel"] = json!(true);
        }
    }
    view
}

#[test]
fn next_offers_parallel_items_below_the_gate_after_the_batch() {
    let rows = [
        ("p-t0001", "dev", "pending"),
        ("p-t0002", "gate", "pending"),
        ("p-t0003", "dev", "pending"),
        ("p-t0004", "dev", "pending"),
        ("p-t0005", "gate", "pending"),
        ("p-t0006", "recon", "pending"),
        ("p-t0007", "dev", "in_progress"),
    ];
    let view = parallel_view(&rows, &["p-t0004", "p-t0006", "p-t0007"]);
    assert_eq!(
        render_next(&view, 3, None),
        "\
p: the next 1 of 1 dispatchable ticket before gate p-t0002 (gate: standard)

○ p-t0001 [dev] Title p-t0001 · pending
-----
Brief for p-t0001.
-----

Below the gate: 2 of 2 parallel tickets, which may start now and land after the gate named

○ p-t0004 [dev] Title p-t0004 · pending · parallel: lands after gate p-t0002
-----
Brief for p-t0004.
-----

○ p-t0006 [recon] Title p-t0006 · pending · parallel: lands after gate p-t0005
-----
Brief for p-t0006.
-----

Not shown: 1 pending · 1 in progress · 2 gates"
    );
    // The batch comes first: n = 2 leaves room for one.
    let t = render_next(&view, 2, None);
    assert!(t.contains("Below the gate: 1 of 2 parallel tickets"), "{t}");
    assert!(
        t.contains("p-t0004") && !t.contains("p-t0006 [recon]"),
        "{t}"
    );
    // n filled by the batch: the parallel items are counted, not listed.
    let t = render_next(&view, 1, None);
    assert!(!t.contains("-----\nBrief for p-t0004"), "{t}");
    assert!(
        t.contains("\n\nBelow the gate: 2 parallel tickets not listed (raise n)\n\n"),
        "{t}"
    );
    // The type filter applies to them too.
    let t = render_next(&view, 3, Some("recon"));
    assert!(
        t.starts_with(
            "p: nothing dispatchable (type recon): gate p-t0002 (gate: standard) waits on 1 \
             pending of other types above it"
        ),
        "{t}"
    );
    assert!(
        t.contains("Below the gate: 1 of 1 parallel recon ticket")
            && t.contains(
                "p-t0006 [recon] Title p-t0006 · pending · parallel: lands after gate p-t0005"
            ),
        "{t}"
    );
    assert!(!t.contains("p-t0004"), "{t}");
    // While the gate's batch is running, the parallel item is still offered.
    let running = parallel_view(
        &[
            ("p-t0001", "dev", "in_progress"),
            ("p-t0002", "gate", "pending"),
            ("p-t0004", "dev", "pending"),
        ],
        &["p-t0004"],
    );
    let t = render_next(&running, 1, None);
    assert!(
        t.starts_with(
            "p: nothing dispatchable: gate p-t0002 (gate: standard) waits on 1 in progress above it"
        ),
        "{t}"
    );
    assert!(t.contains("· parallel: lands after gate p-t0002"), "{t}");
    assert!(t.ends_with("Not shown: 1 in progress · 1 gate"), "{t}");
}

#[test]
fn next_offers_nothing_below_a_gate_that_is_not_parallel() {
    let rows = [
        ("p-t0001", "dev", "in_progress"),
        ("p-t0002", "gate", "pending"),
        ("p-t0003", "dev", "pending"),
    ];
    let t = render_next(&parallel_view(&rows, &[]), 5, None);
    assert!(
        !t.contains("Below the gate") && !t.contains("p-t0003 [dev]"),
        "{t}"
    );
    // A blocked parallel item is under Blocked, never offered.
    let mut view = parallel_view(&rows, &[]);
    let mut b = it("p-t0009", "dev", "Stuck", "pending");
    b["blocked"] = json!(true);
    b["block_reason"] = json!("review");
    b["parallel"] = json!(true);
    view["blocked"] = json!([b]);
    let t = render_next(&view, 5, None);
    assert!(!t.contains("p-t0009 [dev]"), "{t}");
}

#[test]
fn queue_lines_mark_parallel_and_say_what_a_dependency_waits_on() {
    let mut view = golden_view();
    view["queue"][3]["parallel"] = json!(true);
    view["blocked"][0]["block_reason"] = json!("dependency");
    view["blocked"][0]["depends_on"] = json!(["ubu-t0042", "ubu-t0045"]);
    view["blocked"][0]["block_note"] = json!(null);
    let all = qopts(json!({"sections": ["queue", "blocked"]})).unwrap();
    let t = render_queue(&view, &all);
    assert!(
        t.contains("  ○ ubu-t0045 [recon] Map the web app · pending · parallel\n"),
        "{t}"
    );
    assert!(
        t.contains(
            "  ○ ubu-t0046 [design] Icons · pending · blocked: dependency: waits on ubu-t0042, ubu-t0045\n"
        ),
        "{t}"
    );
    // With a note, the note follows what it waits on.
    view["blocked"][0]["block_note"] = json!("the spec first");
    assert!(render_queue(&view, &all)
        .contains("blocked: dependency: waits on ubu-t0042, ubu-t0045: the spec first"));
}

#[test]
fn create_and_update_carry_parallel_and_depends_on() {
    let c = TrackerCreateArgs {
        kind: "item".into(),
        project: Some("p".into()),
        item_type: Some("dev".into()),
        title: Some("Scratch build".into()),
        parallel: Some(true),
        ..Default::default()
    };
    let r = create_req(&c, Some("p"), &who()).unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/items");
    assert_eq!(body["parallel"], json!(true));
    let u = TrackerUpdateArgs {
        id: "p-t0004".into(),
        blocked: Some(true),
        block_reason: Some("dependency".into()),
        depends_on: Some(vec!["p-t0002".into()]),
        ..Default::default()
    };
    let r = update_req(&u, None, &who()).unwrap();
    assert_eq!(
        *post_of(&r).1,
        with_author(json!({
            "blocked": true, "block_reason": "dependency", "depends_on": ["p-t0002"]
        }))
    );
    let u = TrackerUpdateArgs {
        id: "p-t0004".into(),
        parallel: Some(false),
        ..Default::default()
    };
    let r = update_req(&u, None, &who()).unwrap();
    assert_eq!(*post_of(&r).1, with_author(json!({ "parallel": false })));
    // Not on a spec.
    let u = TrackerUpdateArgs {
        id: "spec:audio".into(),
        project: Some("p".into()),
        depends_on: Some(vec!["p-t0002".into()]),
        ..Default::default()
    };
    assert!(update_req(&u, Some("p"), &who()).is_err());
}

// ---- Labels (rag-t0027) -----------------------------------------------------------

#[test]
fn queue_and_next_show_labels_after_the_assignee() {
    let mut view = golden_view();
    view["queue"][0]["labels"] = json!(["Physics", "Biomes"]);
    let all = qopts(json!({"sections": ["queue"]})).unwrap();
    let t = render_queue(&view, &all);
    assert!(
        t.contains(
            "● ubu-t0042 [dev] Build the MCP server · in progress · agent: dev-3 · \
             [Physics, Biomes] · approval: agent ·"
        ),
        "{t}"
    );
    // An item without labels shows no brackets.
    assert!(
        t.contains("  ○ ubu-t0045 [recon] Map the web app · pending\n"),
        "{t}"
    );
    let mut next = next_view(&[("p-t0001", "dev", "pending")], 0, 0);
    next["queue"][0]["labels"] = json!(["Creatures"]);
    let t = render_next(&next, 1, None);
    assert!(
        t.contains("○ p-t0001 [dev] Title p-t0001 · pending · [Creatures]\n-----"),
        "{t}"
    );
}

#[test]
fn create_and_update_carry_labels_and_list_filters_by_label() {
    let c = TrackerCreateArgs {
        kind: "item".into(),
        project: Some("p".into()),
        item_type: Some("dev".into()),
        title: Some("Gas buoyancy".into()),
        labels: Some(vec!["Physics".into(), "Gases".into()]),
        ..Default::default()
    };
    let r = create_req(&c, Some("p"), &who()).unwrap();
    assert_eq!(post_of(&r).1["labels"], json!(["Physics", "Gases"]));
    // A gate may carry labels too.
    let g = TrackerCreateArgs {
        kind: "gate".into(),
        intensity: Some("quick".into()),
        title: Some("Gate".into()),
        labels: Some(vec!["Physics".into()]),
        ..Default::default()
    };
    assert!(create_req(&g, Some("p"), &who()).is_ok());
    // Not on a spec or a concept: refused, never dropped.
    let spec = TrackerCreateArgs {
        kind: "spec".into(),
        slug: Some("audio".into()),
        title: Some("Audio".into()),
        labels: Some(vec!["Physics".into()]),
        ..Default::default()
    };
    let e = create_req(&spec, Some("p"), &who()).unwrap_err();
    assert!(e.contains("`labels` does not apply"), "{e}");
    // Update: wholesale, an empty list clears.
    let u = TrackerUpdateArgs {
        id: "p-t0004".into(),
        labels: Some(vec![]),
        ..Default::default()
    };
    let r = update_req(&u, None, &who()).unwrap();
    assert_eq!(*post_of(&r).1, with_author(json!({ "labels": [] })));
    let u = TrackerUpdateArgs {
        id: "concept:power".into(),
        labels: Some(vec!["Physics".into()]),
        ..Default::default()
    };
    assert!(update_req(&u, Some("p"), &who()).is_err());
    // tracker_list: items by label, and the vocabulary.
    let items = TrackerListArgs {
        what: "items".into(),
        label: Some("Deep water".into()),
        status: Some("pending".into()),
        ..Default::default()
    };
    assert_eq!(
        get_of(&list_req(&items, Some("p")).unwrap()),
        "/tracker/p/items?status=pending&label=Deep%20water"
    );
    let labels = TrackerListArgs {
        what: "labels".into(),
        ..Default::default()
    };
    assert_eq!(
        get_of(&list_req(&labels, Some("p")).unwrap()),
        "/tracker/p/labels"
    );
    let wrong = TrackerListArgs {
        label: Some("Physics".into()),
        ..labels
    };
    let e = list_req(&wrong, Some("p")).unwrap_err();
    assert!(e.contains("`label` does not apply"), "{e}");
    let v = json!({ "project": "p", "labels": [
        { "label": "Biomes", "count": 1, "queued": 0 },
        { "label": "Physics", "count": 3, "queued": 2 },
    ]});
    assert_eq!(
        render_list("labels", &v),
        "Biomes · 1 ticket · 0 queued\nPhysics · 3 tickets · 2 queued"
    );
    assert_eq!(
        render_list("labels", &json!({ "labels": [] })),
        "No labels."
    );
}

// ---- Requests (rag-t0044) ---------------------------------------------------------

/// The golden view with one request waiting to be broken down.
fn request_view() -> Value {
    let mut v = golden_view();
    let mut r = it("ubu-t0049", "request", "Weather", "pending");
    r["approval"] = json!("owner");
    v["requests"] = json!([r]);
    v
}

#[test]
fn requests_are_listed_first_and_counted_apart() {
    let t = render_queue(&request_view(), &qopts(json!({})).unwrap());
    assert!(
        t.starts_with(
            "ubu: 1 request, 1 in review, 4 in the queue, 1 blocked, 1 deferred, 1 done not acknowledged\n\
             Requests:\n  ○ ubu-t0049 [request] Weather · pending · approval: owner\n\
             Review:\n  ◆ ubu-t0048 "
        ),
        "{t}"
    );
    assert!(t.ends_with("\nNot shown: 1 done not acknowledged"), "{t}");
    // Not asked for, it is counted in the footer.
    let t = render_queue(
        &request_view(),
        &qopts(json!({"sections": ["queue"]})).unwrap(),
    );
    assert!(!t.contains("Requests:") && !t.contains("ubu-t0049"), "{t}");
    assert!(t.ends_with("\nNot shown: 1 request · 1 blocked · 1 deferred · 1 in review · 1 done not acknowledged"), "{t}");
    // Asked for by name.
    let o = qopts(json!({"sections": [" Requests "]})).unwrap();
    assert!(o.requests && !o.review && !o.queue && !o.blocked && !o.deferred && !o.done);
    let t = render_queue(&request_view(), &o);
    assert!(t.contains("\nRequests:\n  ○ ubu-t0049 "), "{t}");
    // An older server without the array reads as none.
    let t = render_queue(&golden_view(), &o);
    assert!(t.contains("\nRequests: none\n"), "{t}");
}

#[test]
fn next_never_returns_a_request_nor_counts_it_in_a_batch() {
    let mut r = it("p-t0002", "request", "Weather", "pending");
    r["body"] = json!("Rain, then snow.\n");
    let mut view = next_view(
        &[
            ("p-t0001", "dev", "pending"),
            ("p-t0003", "gate", "pending"),
        ],
        0,
        0,
    );
    view["requests"] = json!([r.clone()]);
    let t = render_next(&view, 5, None);
    assert!(
        t.starts_with("p: the next 1 of 1 dispatchable ticket before gate p-t0003"),
        "{t}"
    );
    assert!(!t.contains("p-t0002"), "{t}");
    assert!(t.ends_with("Not shown: 1 gate · 1 request"), "{t}");
    // Only a request above the gate: the gate is the next job, as with nothing above it.
    let mut gated = next_view(&[("p-t0003", "gate", "pending")], 0, 0);
    gated["requests"] = json!([r.clone()]);
    let t = render_next(&gated, 1, None);
    assert!(
        t.starts_with(
            "p: the next job is gate p-t0003 (gate: standard): nothing is queued above it"
        ),
        "{t}"
    );
    // Even a request row in the queue (which the server never sends) is not offered.
    let mut stray = next_view(&[], 0, 0);
    stray["queue"] = json!([r]);
    let t = render_next(&stray, 1, None);
    assert!(!t.contains("-----"), "{t}");
    // And the type filter refuses request outright.
    let e =
        next_opts(&serde_json::from_value::<TrackerNextArgs>(json!({"type": "request"})).unwrap())
            .unwrap_err();
    assert!(e.contains("never dispatched"), "{e}");
}

#[test]
fn create_takes_a_request_and_a_from_link() {
    let req = CreateItemArgs {
        item_type: "request".into(),
        title: "Weather".into(),
        body: Some("Rain, then snow.".into()),
        approval: Some("owner".into()),
        ..Default::default()
    };
    let r = create_req(
        &TrackerCreateArgs::try_from(req).unwrap(),
        Some("p"),
        &who(),
    )
    .unwrap();
    let (path, body) = post_of(&r);
    assert_eq!(path, "/tracker/p/items");
    assert_eq!(
        *body,
        with_author(json!({
            "type": "request", "title": "Weather", "body": "Rain, then snow.", "approval": "owner"
        }))
    );
    let ticket = CreateItemArgs {
        item_type: "design".into(),
        title: "Rain art".into(),
        links: Some(vec!["from:p-t0002".into()]),
        after: Some("p-t0001".into()),
        ..Default::default()
    };
    let r = create_req(
        &TrackerCreateArgs::try_from(ticket).unwrap(),
        Some("p"),
        &who(),
    )
    .unwrap();
    assert_eq!(
        *post_of(&r).1,
        with_author(json!({
            "type": "design", "title": "Rain art",
            "links": [{"kind": "from", "target": "p-t0002"}], "after": "p-t0001"
        }))
    );
}
