//! Tier 3: the Rust half of the contract (`REPO_SKELETON.md` §5.3).
//!
//! Both languages parse the same corpus in `fixtures/protocol/` and both must re-encode it to the
//! same value. The design describes that as a chain — TS encodes, Rust decodes, Rust re-encodes,
//! TS decodes, deep-equal — and this is that chain, pinned in the middle by a committed fixture
//! instead of by a live pipe between two processes:
//!
//! ```text
//!   TS re-encode  ==  fixture  ==  Rust re-encode
//! ```
//!
//! Equality with a shared fixture on both sides gives the same guarantee as the round trip, and it
//! survives the thing the round trip does not: `pnpm check` skips every cargo step on a machine
//! with no Rust toolchain (`scripts/cargo.mjs`), so a chain that ran cross-process would quietly
//! stop being a test at all. Here the TypeScript half still runs, and this half runs wherever
//! cargo does.
//!
//! **A message with no fixture is a message the other language has never parsed.** Add one in the
//! same commit as the message.

use std::path::{Path, PathBuf};

use riki_ipc::{SidecarCommand, SidecarEvent};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/riki-ipc is two levels below the repo root")
        .join("fixtures/protocol")
}

fn fixtures() -> Vec<(String, String)> {
    let mut entries: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .expect("fixtures/protocol exists")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    entries.sort();

    entries
        .into_iter()
        .map(|path| {
            let name = path
                .file_name()
                .expect("a file")
                .to_string_lossy()
                .into_owned();
            let body = std::fs::read_to_string(&path).expect("readable");
            (name, body)
        })
        .collect()
}

/// Decode, re-encode, and compare as values rather than as text.
///
/// Comparing text would fail on key order, which is not a disagreement about the message — and
/// would train whoever hit it to reformat the fixture until the test went green, which is the
/// opposite of what it is for.
fn round_trips<T>(body: &str) -> Result<(), String>
where
    T: serde::de::DeserializeOwned + serde::Serialize,
{
    let original: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let typed: T = serde_json::from_str(body).map_err(|e| e.to_string())?;
    let re_encoded = serde_json::to_value(&typed).map_err(|e| e.to_string())?;

    if normalize(&re_encoded) == normalize(&original) {
        return Ok(());
    }
    Err(format!("re-encoded {re_encoded}\nfixture    {original}"))
}

/// Collapse every number to `f64` before comparing.
///
/// JSON has one number type; Rust does not, and `serde_json::Value` keeps the distinction, so a
/// fixture that writes `"x": 0` compares unequal to a re-encoded `0.0` for a `f64` field. That is
/// a fact about `serde_json`, not about the contract — and the TypeScript half cannot even
/// represent the difference, which is the tell. Normalising here is what keeps the fixtures
/// readable instead of forcing `0.0` into every JSON file to satisfy one language's type system.
fn normalize(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Number(number) => number
            .as_f64()
            .and_then(serde_json::Number::from_f64)
            .map_or_else(|| value.clone(), serde_json::Value::Number),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(normalize).collect())
        }
        serde_json::Value::Object(fields) => serde_json::Value::Object(
            fields
                .iter()
                .map(|(key, inner)| (key.clone(), normalize(inner)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn every_fixture_round_trips_through_the_generated_types() {
    let fixtures = fixtures();
    assert!(
        fixtures.len() >= 9,
        "the corpus lost fixtures: found {}",
        fixtures.len()
    );

    for (name, body) in fixtures {
        // The prefix says which side of the protocol the message belongs to. A command that
        // parsed as an event, or the reverse, would be a real contract failure.
        let result = if name.starts_with("command-") {
            round_trips::<SidecarCommand>(&body)
        } else if name.starts_with("event-") {
            round_trips::<SidecarEvent>(&body)
        } else {
            panic!("fixtures/protocol/{name} must start with `command-` or `event-`");
        };

        if let Err(detail) = result {
            panic!("fixtures/protocol/{name} does not round-trip:\n{detail}");
        }
    }
}

#[test]
fn a_command_does_not_parse_as_an_event() {
    // The two unions share an envelope, so a decoder pointed at the wrong one has to fail rather
    // than succeed with a variant that happens to fit.
    let hello = std::fs::read_to_string(fixture_dir().join("command-hello.json")).expect("present");
    assert!(serde_json::from_str::<SidecarEvent>(&hello).is_err());
}

#[test]
fn an_optional_field_that_is_absent_stays_absent() {
    // `remedy` is optional, and a `null` on the wire would fail the TypeScript side's schema. This
    // is what `skip_serializing_if` in the generated code buys, and it is invisible until the two
    // languages compare notes.
    let body = std::fs::read_to_string(fixture_dir().join("event-problem-version-mismatch.json"))
        .expect("present");
    let event: SidecarEvent = serde_json::from_str(&body).expect("valid");
    let re_encoded = serde_json::to_string(&event).expect("serialises");
    assert!(
        !re_encoded.contains("remedy"),
        "an absent remedy must not become null: {re_encoded}"
    );
}
