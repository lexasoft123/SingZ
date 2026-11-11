//! The native end of the shared core case tables in `tests/shared/core/` (plus
//! `tests/shared/lyrics-tolerance-cases.json`). The TypeScript end is
//! `tests/unit/core-*-cases.test.ts`; the tables state the TypeScript rule and the
//! native desktop must agree with it.
//!
//! Every case of every table runs. A case the native code gets wrong today is listed
//! in that table's `*_DRIFTS` with the package that fixes it. The guard works in both
//! directions: a listed case that starts passing fails the suite ("remove the entry"),
//! and a mismatch that is not listed fails it too. A list entry that names no case
//! fails, so the lists cannot go stale.
use crate::drive_plan::{
    LocalEntry, ProjectSnapshot, RemoteEntry, RemoteProject, plan_project,
};
use serde_json::{Value, json};
use std::collections::HashSet;

const STALENESS: &str = include_str!("../../../tests/shared/core/staleness-cases.json");
const LRC: &str = include_str!("../../../tests/shared/core/lrc-cases.json");
const PLAN_PROJECT: &str = include_str!("../../../tests/shared/core/plan-project-cases.json");
const LYRICS: &str = include_str!("../../../tests/shared/lyrics-tolerance-cases.json");

/// A known disagreement with the TypeScript rule, owned by a later package.
struct Drift {
    case: &'static str,
    package: &'static str,
    reason: &'static str,
}

/// `outcomes` holds one `(case name, Ok if native agrees | Err(what differed))` per
/// table row. Panics unless the drift list describes the mismatches exactly.
fn assert_table(table: &str, total: usize, outcomes: &[(String, Result<(), String>)], drifts: &[Drift]) {
    assert_eq!(outcomes.len(), total, "{table}: not every case ran");
    assert!(total > 0, "{table}: the table is empty");
    let names: HashSet<&str> = outcomes.iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names.len(), total, "{table}: case names must be unique");
    let mut listed = HashSet::new();
    for drift in drifts {
        assert!(
            names.contains(drift.case),
            "{table}: drift entry names no case: {:?} ({})",
            drift.case,
            drift.package
        );
        assert!(
            listed.insert(drift.case),
            "{table}: drift case listed twice: {:?}",
            drift.case
        );
        assert!(
            !drift.package.is_empty() && !drift.reason.is_empty(),
            "{table}: drift {:?} needs a fixing package and a reason",
            drift.case
        );
    }
    let mut problems = vec![];
    for (name, outcome) in outcomes {
        match (listed.contains(name.as_str()), outcome) {
            (true, Ok(())) => problems.push(format!(
                "drift now passes, remove its entry: {name:?}"
            )),
            (false, Err(why)) => problems.push(format!("unlisted mismatch: {name:?}: {why}")),
            _ => {}
        }
    }
    assert!(problems.is_empty(), "{table}:\n{}", problems.join("\n"));
}

/// Numbers compare with a tolerance (the native lyrics reader narrows to f32);
/// everything else compares exactly.
fn close(a: &Value, b: &Value, tolerance: f64) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap(), y.as_f64().unwrap());
            (x - y).abs() <= tolerance
        }
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(x, y)| close(x, y, tolerance))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, x)| y.get(key).is_some_and(|y| close(x, y, tolerance)))
        }
        _ => a == b,
    }
}

fn verdict(actual: Value, expected: &Value, tolerance: f64) -> Result<(), String> {
    if close(&actual, expected, tolerance) {
        Ok(())
    } else {
        Err(format!("expected {expected}, native gave {actual}"))
    }
}

fn parse(table: &str) -> Vec<Value> {
    serde_json::from_str::<Value>(table).unwrap().as_array().unwrap().clone()
}

// ---------------------------------------------------------------- staleness

/// Is this stamp stale for the detector? Each answer goes through the native code
/// that makes that decision for the stored analysis, not through a copy of the rule.
fn native_stale(kind: &str, stamp: Option<&Value>) -> bool {
    let with = |mut base: Value, key: &str| {
        if let Some(stamp) = stamp {
            base[key] = stamp.clone();
        }
        base
    };
    match kind {
        "key" => !crate::project_key::stored_current(&with(
            json!({"pc": 0, "minor": false}),
            "detVersion",
        )),
        "beat" => {
            let grid = crate::beat::Beats::sanitize(&with(
                json!({"beats": [0., 0.5, 1., 1.5, 2.], "source": "auto"}),
                "detVersion",
            ))
            .expect("a valid beat grid");
            crate::beat_analysis::needed(Some(&grid))
        }
        "pitch" => {
            let mut pitch = crate::project_pitch::Pitch::read(&json!({"melody": with(
                json!({"hopSec": 0.025, "f0": vec!["1200"; 200].join(" ")}),
                "detVersion",
            )}));
            pitch.bind_duration(5.);
            // A stale line is cleared on load so it is re-tracked.
            pitch.f0.is_empty()
        }
        other => panic!("unknown detector {other}"),
    }
}

const STALENESS_DRIFTS: &[Drift] = &[];

#[test]
fn staleness_cases_match_the_typescript_rule() {
    let table: Value = serde_json::from_str(STALENESS).unwrap();
    let cases = table["cases"].as_array().unwrap();
    let outcomes: Vec<_> = cases
        .iter()
        .map(|case| {
            let stale = native_stale(case["kind"].as_str().unwrap(), case.get("stamp"));
            let expected = case["stale"].as_bool().unwrap();
            let outcome = if stale == expected {
                Ok(())
            } else {
                Err(format!("stale: expected {expected}, native gave {stale}"))
            };
            (case["name"].as_str().unwrap().to_owned(), outcome)
        })
        .collect();
    assert_table("staleness", cases.len(), &outcomes, STALENESS_DRIFTS);
}

#[test]
fn staleness_table_names_the_native_detector_versions() {
    let table: Value = serde_json::from_str(STALENESS).unwrap();
    assert_eq!(table["detectors"]["beat"], json!(crate::beat_analysis::version()));
}

#[test]
fn generated_detector_versions_follow_native_headers() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let headers = root.join("zcore/include/zcore/legacy");
    for (header, name, actual) in [
        ("beats.h", "kBeatDetectVersion", crate::beat_analysis::version()),
        ("analysis.h", "kKeyDetectVersion", crate::project_key::VERSION),
        ("melody.h", "kPitchDetectVersion", crate::project_pitch::VERSION),
    ] {
        let source = std::fs::read_to_string(headers.join(header)).unwrap();
        let pattern = regex::Regex::new(&format!(r"(?m)^constexpr\s+int\s+{name}\s*=\s*(\d+)\s*;")).unwrap();
        let expected: u64 = pattern.captures(&source).unwrap()[1].parse().unwrap();
        assert_eq!(actual, expected, "{name} must flow from {header} into Rust");
    }
    let table: Value = serde_json::from_str(STALENESS).unwrap();
    assert_eq!(table["detectors"]["key"], json!(crate::project_key::VERSION));
    assert_eq!(table["detectors"]["pitch"], json!(crate::project_pitch::VERSION));
}

// ---------------------------------------------------------------- lyrics

fn native_lyrics(input: &Value) -> Value {
    match crate::project_lyrics::from_value(input) {
        Ok(Some(doc)) => {
            let mut out = json!({
                "source": doc.source,
                "lines": doc.lines.iter().map(|line| json!({
                    "start": line.start,
                    "end": line.end,
                    "text": line.text,
                    "words": line.words.iter().map(|word| json!({
                        "w": word.text, "s": word.start, "e": word.end,
                    })).collect::<Vec<_>>(),
                })).collect::<Vec<_>>(),
            });
            if !doc.credit.is_empty() {
                out["credit"] = json!(doc.credit);
            }
            out
        }
        // An unreadable file and a file with no usable line are both "no lyrics".
        Ok(None) | Err(_) => Value::Null,
    }
}

const LYRICS_DRIFTS: &[Drift] = &[];

#[test]
fn lyrics_tolerance_cases_match_the_shared_reader() {
    let cases = parse(LYRICS);
    let outcomes: Vec<_> = cases
        .iter()
        .map(|case| {
            (
                case["name"].as_str().unwrap().to_owned(),
                verdict(native_lyrics(&case["input"]), &case["expected"], 1e-4),
            )
        })
        .collect();
    assert_table("lyrics tolerance", cases.len(), &outcomes, LYRICS_DRIFTS);
}

// ---------------------------------------------------------------- LRC

const LRC_DRIFTS: &[Drift] = &[];

#[test]
fn lrc_cases_match_the_typescript_parser() {
    let cases = parse(LRC);
    let outcomes: Vec<_> = cases
        .iter()
        .map(|case| {
            let actual = match crate::lrclib::parse_lrc(
                case["lrc"].as_str().unwrap(),
                case["duration"].as_f64().unwrap(),
            ) {
                Ok(lines) => serde_json::to_value(lines).unwrap(),
                Err(error) => json!({"error": error.to_string()}),
            };
            (
                case["name"].as_str().unwrap().to_owned(),
                verdict(actual, &case["lines"], 1e-9),
            )
        })
        .collect();
    assert_table("LRC", cases.len(), &outcomes, LRC_DRIFTS);
}

// ---------------------------------------------------------------- planProject

fn remote_entries(value: &Value) -> Vec<RemoteEntry> {
    serde_json::from_value(value.clone()).unwrap()
}

fn native_plan(case: &Value) -> Result<Value, String> {
    let local = &case["local"];
    // The shared table spells paths POSIX-style ("/library/Song/..."), which is
    // not absolute on Windows; give them a drive there so the planner's
    // absolute-path check sees the same input on every platform.
    let entries = |key: &str| -> Vec<LocalEntry> {
        let mut entries: Vec<LocalEntry> = serde_json::from_value(local[key].clone()).unwrap();
        if cfg!(windows) {
            for entry in &mut entries {
                if !entry.path.is_absolute() {
                    entry.path = std::path::PathBuf::from(format!("C:{}", entry.path.display()));
                }
            }
        }
        entries
    };
    let snapshot = ProjectSnapshot {
        dir: local["dir"].as_str().unwrap().to_owned(),
        top: entries("top"),
        stems: entries("stems"),
        doc_readable: local["docReadable"].as_bool().unwrap_or(true),
        // The TypeScript snapshot has no such field: it always plans orphan removal.
        stems_readable: true,
    };
    let remote = &case["remote"];
    let remote = RemoteProject {
        folder_id: remote["folderId"].as_str().map(str::to_owned),
        stems_id: remote["stemsId"].as_str().map(str::to_owned),
        top: remote_entries(&remote["top"]),
        stems: remote_entries(&remote["stems"]),
    };
    let plan = plan_project(&snapshot, &remote).map_err(|error| error.to_string())?;
    let mut upload = serde_json::to_value(&plan.upload).unwrap();
    if cfg!(windows) {
        // Undo the drive prefix added above so the output compares against the
        // table's POSIX spelling. Separators are untouched: the input kept "/".
        for step in upload.as_array_mut().into_iter().flatten() {
            if let Some(path) = step["path"].as_str().and_then(|p| p.strip_prefix("C:")) {
                step["path"] = json!(path);
            }
        }
    }
    Ok(json!({
        "dir": plan.dir,
        "upload": upload,
        "unchanged": plan.unchanged,
        "trash": serde_json::to_value(&plan.trash).unwrap(),
        "rows": serde_json::to_value(&plan.rows).unwrap(),
    }))
}

const PLAN_PROJECT_DRIFTS: &[Drift] = &[
    Drift {
        case: "a new project uploads everything and creates no ids",
        package: "C-12",
        reason: "orders uploads stems first and project.json last; the TypeScript planner keeps top-level files, then stems",
    },
    Drift {
        case: "uploads keep the order top-level files then stems",
        package: "C-12",
        reason: "orders uploads stems first and project.json last; the TypeScript planner keeps top-level files, then stems",
    },
    Drift {
        case: "catalog rows describe the top-level files and carry known remote ids",
        package: "C-12",
        reason: "orders uploads stems first and project.json last; the TypeScript planner keeps top-level files, then stems",
    },
    Drift {
        case: "every remote stem is trashed when the project has no stems",
        package: "C-12",
        reason: "trashes nothing when the project has no stems (the stems_readable guard). The pure TypeScript planner trashes every remote stem, but its caller guards it (src/main/gdrive.ts mayTrash), so production behaviour already agrees: C-12 must keep the Rust guard, not copy the pure function",
    },
];

#[test]
fn plan_project_cases_match_the_typescript_planner() {
    let cases = parse(PLAN_PROJECT);
    let outcomes: Vec<_> = cases
        .iter()
        .map(|case| {
            let outcome = match native_plan(case) {
                Ok(plan) => verdict(plan, &case["expected"], 0.),
                Err(error) => Err(format!("native refused the input: {error}")),
            };
            (case["name"].as_str().unwrap().to_owned(), outcome)
        })
        .collect();
    assert_table("planProject", cases.len(), &outcomes, PLAN_PROJECT_DRIFTS);
}

// ---------------------------------------------------------------- the guard itself

fn outcome(name: &str, ok: bool) -> (String, Result<(), String>) {
    (name.to_owned(), if ok { Ok(()) } else { Err("differs".into()) })
}

const ONE_DRIFT: &[Drift] = &[Drift { case: "b", package: "C-00", reason: "test" }];

#[test]
fn guard_accepts_exactly_the_listed_drifts() {
    assert_table("guard", 2, &[outcome("a", true), outcome("b", false)], ONE_DRIFT);
}

#[test]
#[should_panic(expected = "drift now passes")]
fn guard_fails_when_a_listed_drift_starts_passing() {
    assert_table("guard", 2, &[outcome("a", true), outcome("b", true)], ONE_DRIFT);
}

#[test]
#[should_panic(expected = "unlisted mismatch")]
fn guard_fails_on_an_unlisted_mismatch() {
    assert_table("guard", 2, &[outcome("a", false), outcome("b", false)], ONE_DRIFT);
}

#[test]
#[should_panic(expected = "names no case")]
fn guard_fails_on_a_drift_entry_for_a_missing_case() {
    assert_table("guard", 1, &[outcome("a", true)], ONE_DRIFT);
}
