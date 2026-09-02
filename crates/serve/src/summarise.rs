//! Turning a ledger topic into the text a model is asked to summarise.
//!
//! **The content is read here, server-side, from the id in the URL** — the
//! request body carries a model and a prompt and nothing else. That is the
//! whole reason this module exists rather than the browser posting the prose it
//! already has on screen: an endpoint that summarises whatever text it is
//! handed is a general-purpose LLM proxy, billed to the operator, open to
//! anyone who can reach the port. Bound to a topic id, the worst an unwelcome
//! caller can do is pay to re-summarise the operator's own ledger.
//!
//! The rendering is plain text with Markdown headings, not JSON. A model reads
//! either, but the ledger's own prose *is* Markdown, so headings around it keep
//! the entry's structure legible instead of burying it in escaped strings.

use rag_core::ledger::{Event, Topic, TopicRecord};

/// Render a topic and its whole monologue as the document to be summarised.
///
/// Everything a reader would see on the topic page, in the order they would see
/// it, and nothing they would not: no ids of other topics' contents, no
/// database internals. The three things kept visibly apart on screen are kept
/// apart here too — the immutable framing, the current state, and the history
/// that got from one to the other — because a summary that conflates the
/// original framing with the outcome has read the topic backwards.
pub fn render_topic(record: &TopicRecord) -> String {
    let topic = &record.topic;
    let mut out = String::with_capacity(2_048);

    out.push_str(&format!("# {}\n\n", topic.title));
    out.push_str(&metadata(topic));

    if !record.links.is_empty() {
        out.push_str("- Links: ");
        let links: Vec<String> = record
            .links
            .iter()
            .map(|l| format!("{} {}", l.rel.as_str(), l.other_topic_id))
            .collect();
        out.push_str(&links.join("; "));
        out.push('\n');
    }

    out.push_str("\n## Original framing (fixed at creation, never revised)\n\n");
    out.push_str(topic.summary.trim());
    out.push_str("\n\n## Current state\n\n");
    out.push_str(topic.current_state.trim());

    out.push_str(&format!(
        "\n\n## History ({} {})\n",
        record.events.len(),
        if record.events.len() == 1 {
            "entry"
        } else {
            "entries"
        }
    ));
    for event in &record.events {
        out.push_str(&render_event(event));
    }

    out
}

fn metadata(topic: &Topic) -> String {
    let mut out = String::new();
    out.push_str(&format!("- Id: {}\n", topic.topic_id));
    out.push_str(&format!("- Type: {}\n", topic.topic_type.as_str()));
    out.push_str(&format!("- Status: {}\n", topic.status.as_str()));
    out.push_str(&format!("- Project: {}\n", topic.repo));
    if !topic.tags.is_empty() {
        out.push_str(&format!("- Tags: {}\n", topic.tags.join(", ")));
    }
    out.push_str(&format!(
        "- Opened: {} by {}\n",
        topic.created_at,
        author(&topic.creator_email, topic.creator_agent.as_deref())
    ));
    out.push_str(&format!("- Last touched: {}\n", topic.updated_at));
    if topic.archived {
        out.push_str("- Archived: yes (soft-deleted, absent from search)\n");
    }
    out
}

fn render_event(event: &Event) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "\n### {} — {} — {}\n\n",
        event.ts,
        event.kind.as_str(),
        author(&event.author_email, event.author_agent.as_deref())
    ));
    out.push_str(event.body.trim());
    out.push('\n');

    // What the event *changed*, which is often the point of it and is nowhere in
    // the prose: an agent writes "agreed, moving on" and the fact that the
    // status went to `accepted` lives only in this column.
    if let Some(status) = &event.new_status {
        out.push_str(&format!("\n(status set to: {status})\n"));
    }
    if let Some(title) = &event.new_title {
        out.push_str(&format!("\n(retitled to: {title})\n"));
    }
    if let Some(tags) = &event.new_tags {
        let shown = if tags.is_empty() {
            "cleared".to_string()
        } else {
            tags.join(", ")
        };
        out.push_str(&format!("\n(tags set to: {shown})\n"));
    }
    if let Some(state) = &event.new_state {
        out.push_str(&format!("\n(state set to: {})\n", state.trim()));
    }
    out
}

/// Who wrote something, and whether they are a person.
///
/// A null agent means a human, and that is the most informative value the field
/// has — a summariser that could not tell an agent's note from a person's
/// ruling would be flattening the one distinction the ledger records for free.
fn author(email: &str, agent: Option<&str>) -> String {
    match agent {
        Some(model) => format!("{email} (agent: {model})"),
        None => format!("{email} (a person)"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rag_core::ledger::{EventKind, Link, LinkRel, Status, TopicType};

    fn topic() -> Topic {
        Topic {
            topic_id: "rag-0009".into(),
            topic_type: TopicType::Decision,
            repo: "rag".into(),
            title: "Serve the viewer from the same origin".into(),
            summary: "Whether to serve the SPA from rag-serve or a host of its own.".into(),
            current_state: "Same origin. No CORS configuration exists.".into(),
            status: Status::Accepted,
            created_at: "2026-01-02T03:04:05Z".into(),
            updated_at: "2026-01-03T03:04:05Z".into(),
            creator_email: "alice@example.com".into(),
            creator_agent: None,
            tags: vec!["web".into(), "deploy".into()],
            archived: false,
            archived_at: None,
        }
    }

    fn event() -> Event {
        Event {
            event_id: 2,
            ts: "2026-01-03T03:04:05Z".into(),
            author_email: "agent@example.com".into(),
            author_agent: Some("Some Model 1".into()),
            kind: EventKind::StatusChange,
            body: "Agreed after the proxy question was settled.".into(),
            new_state: Some("Same origin.".into()),
            new_status: Some("accepted".into()),
            new_title: None,
            new_tags: Some(vec!["web".into(), "deploy".into()]),
        }
    }

    fn record() -> TopicRecord {
        TopicRecord {
            topic: topic(),
            events: vec![event()],
            links: vec![Link {
                rel: LinkRel::Supersedes,
                other_topic_id: "rag-0003".into(),
            }],
        }
    }

    #[test]
    fn every_part_of_the_topic_reaches_the_prompt() {
        let text = render_topic(&record());
        for expected in [
            "# Serve the viewer from the same origin",
            "- Id: rag-0009",
            "- Type: decision",
            "- Status: accepted",
            "- Project: rag",
            "- Tags: web, deploy",
            "- Links: supersedes rag-0003",
            "Whether to serve the SPA",
            "Same origin. No CORS configuration exists.",
            "## History (1 entry)",
            "Agreed after the proxy question was settled.",
            "(status set to: accepted)",
            "(tags set to: web, deploy)",
        ] {
            assert!(text.contains(expected), "missing {expected:?}\n---\n{text}");
        }
    }

    /// The framing and the outcome are the two halves a summary must not
    /// conflate, so each is under a heading that says which it is.
    #[test]
    fn the_framing_is_labelled_as_fixed_and_kept_apart_from_the_state() {
        let text = render_topic(&record());
        let framing = text.find("## Original framing").expect("framing heading");
        let state = text.find("## Current state").expect("state heading");
        let history = text.find("## History").expect("history heading");
        assert!(framing < state && state < history);
        assert!(text.contains("never revised"));
    }

    #[test]
    fn a_human_author_is_reported_as_one() {
        assert_eq!(
            author("alice@example.com", None),
            "alice@example.com (a person)"
        );
        assert_eq!(
            author("bot@example.com", Some("Some Model 1")),
            "bot@example.com (agent: Some Model 1)"
        );
    }

    #[test]
    fn an_archived_topic_says_so() {
        let mut rec = record();
        rec.topic.archived = true;
        assert!(render_topic(&rec).contains("- Archived: yes"));
    }

    #[test]
    fn a_topic_with_no_events_still_renders() {
        let rec = TopicRecord {
            topic: topic(),
            events: Vec::new(),
            links: Vec::new(),
        };
        let text = render_topic(&rec);
        assert!(text.contains("## History (0 entries)"));
        assert!(!text.contains("- Links:"));
    }

    #[test]
    fn cleared_tags_are_reported_as_cleared_rather_than_as_nothing() {
        let mut rec = record();
        rec.events[0].new_tags = Some(Vec::new());
        assert!(render_topic(&rec).contains("(tags set to: cleared)"));
    }
}
