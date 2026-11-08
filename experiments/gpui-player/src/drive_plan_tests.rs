use super::*;
use serde_json::json;
fn local(name: &str, stems: bool, md5: &str) -> LocalEntry {
    LocalEntry {
        name: name.into(),
        path: std::env::temp_dir()
            .join("singz-drive-plan/library/Song")
            .join(if stems { "stems" } else { "" })
            .join(name),
        mime: if name.ends_with("json") {
            "application/json"
        } else {
            "audio/flac"
        }
        .into(),
        md5: md5.into(),
        size: 12,
    }
}
fn remote(name: &str, id: &str, md5: Option<&str>) -> RemoteEntry {
    RemoteEntry {
        id: id.into(),
        name: name.into(),
        mime_type: Some("application/octet-stream".into()),
        md5_checksum: md5.map(str::to_owned),
        ..Default::default()
    }
}
fn snapshot() -> ProjectSnapshot {
    ProjectSnapshot {
        dir: "Song".into(),
        top: vec![local("project.json", false, "doc")],
        stems: vec![local("vocals.flac", true, "voice")],
        doc_readable: true,
        stems_readable: true,
    }
}
fn project() -> RemoteProject {
    RemoteProject {
        folder_id: Some("project".into()),
        stems_id: Some("stems".into()),
        ..Default::default()
    }
}
#[test]
fn dto_uses_source_drive_camelcase_and_defaults_optional_arrays() {
    let entry:RemoteEntry=serde_json::from_value(json!({"id":"id","name":"lyrics.json","md5Checksum":"hash","mimeType":"application/json","size":"12"})).unwrap();
    assert!(entry.parents.is_empty());
    assert!(entry.app_properties.is_empty());
    let value = serde_json::to_value(entry).unwrap();
    assert_eq!(value["md5Checksum"], "hash");
    assert_eq!(value["mimeType"], "application/json");
    assert!(value.get("md5_checksum").is_none());
}
#[test]
fn parent_queries_escape_quotes_and_slashes_and_chunks_are_bounded() {
    assert_eq!(
        parents_query(&["a'\\b".into(), "two".into()]).unwrap(),
        "('a\\'\\\\b' in parents or 'two' in parents) and trashed=false"
    );
    let ids: Vec<_> = (0..101).map(|n| format!("id-{n}")).collect();
    let chunks = chunk_parents(&ids).unwrap();
    assert_eq!(chunks.iter().map(Vec::len).collect::<Vec<_>>(), [50, 50, 1]);
    assert_eq!(chunks.into_iter().flatten().collect::<Vec<_>>(), ids);
    assert!(chunk_parents_with_size(&ids, 0).is_err());
    assert!(chunk_parents_with_size(&ids, 51).is_err());
    assert!(parents_query(&[]).is_err());
    assert!(parents_query(&["bad\nidentity".into()]).is_err());
    assert!(chunk_parents(&[]).unwrap().is_empty());
}
#[test]
fn checksums_compare_current_remote_facts_with_source_exact_equality() {
    let mine = vec![
        local("project.json", false, "abc"),
        local("lyrics.json", false, "def"),
    ];
    let theirs = vec![
        remote("project.json", "doc", Some("abc")),
        remote("lyrics.json", "lyrics", None),
    ];
    let p = plan_sync(&mine, &theirs).unwrap();
    assert_eq!(p.unchanged, ["project.json"]);
    assert_eq!(p.upload, ["lyrics.json"]);
    let mut changed = theirs;
    changed[0].md5_checksum = Some("ABC".into());
    assert_eq!(
        plan_sync(&mine, &changed).unwrap().upload,
        ["project.json", "lyrics.json"]
    );
}
#[test]
fn uploads_stems_before_other_top_and_project_document_last() {
    let mut mine = snapshot();
    mine.top = vec![
        local("project.json", false, "doc"),
        local("lyrics.json", false, "lyrics"),
        local("graph.json", false, "graph"),
    ];
    mine.stems.push(local("bass.flac", true, "bass"));
    let mut theirs = project();
    theirs
        .top
        .push(remote("lyrics.json", "existing-lyrics", Some("old")));
    let p = plan_project(&mine, &theirs).unwrap();
    assert_eq!(
        p.upload
            .iter()
            .map(|s| (s.where_, s.name.as_str()))
            .collect::<Vec<_>>(),
        [
            (Location::Stems, "vocals.flac"),
            (Location::Stems, "bass.flac"),
            (Location::Top, "lyrics.json"),
            (Location::Top, "graph.json"),
            (Location::Top, "project.json")
        ]
    );
    assert_eq!(p.upload[2].existing_id.as_deref(), Some("existing-lyrics"));
    assert_eq!(
        serde_json::to_value(&p.upload[0]).unwrap()["where"],
        "stems"
    );
}
#[test]
fn catalog_rows_include_only_top_in_original_order_and_existing_ids() {
    let mut mine = snapshot();
    mine.top.push(local("lyrics.json", false, "lyrics"));
    let mut theirs = project();
    theirs
        .top
        .push(remote("project.json", "doc-id", Some("doc")));
    let p = plan_project(&mine, &theirs).unwrap();
    assert_eq!(p.unchanged, 1);
    assert_eq!(p.rows.len(), 2);
    assert_eq!(p.rows[0].name, "project.json");
    assert_eq!(p.rows[0].size, "12");
    assert_eq!(p.rows[0].md5_checksum, "doc");
    assert_eq!(p.rows[0].id.as_deref(), Some("doc-id"));
    assert!(p.rows[1].id.is_none());
}
#[test]
fn readable_nonempty_stems_trash_only_absent_files() {
    let mine = snapshot();
    let mut theirs = project();
    theirs.stems = vec![
        remote("vocals.flac", "voice", Some("voice")),
        remote("removed-custom.flac", "gone", Some("old")),
    ];
    let mut folder = remote("user-folder", "nested", None);
    folder.mime_type = Some(FOLDER_MIME.into());
    theirs.stems.push(folder);
    let p = plan_project(&mine, &theirs).unwrap();
    assert_eq!(
        p.trash
            .iter()
            .map(|s| (s.where_, s.entry.id.as_str()))
            .collect::<Vec<_>>(),
        [(Location::Stems, "gone")]
    );
}
#[test]
fn empty_or_unreadable_stems_never_delete_the_remote_only_copy() {
    let mut mine = snapshot();
    let mut theirs = project();
    theirs
        .stems
        .push(remote("only-copy.flac", "remote", Some("hash")));
    mine.stems_readable = false;
    assert!(plan_project(&mine, &theirs).unwrap().trash.is_empty());
    mine.stems_readable = true;
    mine.stems.clear();
    assert!(plan_project(&mine, &theirs).unwrap().trash.is_empty());
}
#[test]
fn top_graph_orphaning_requires_readable_document_and_no_reference() {
    let mut mine = snapshot();
    let mut theirs = project();
    theirs.top = vec![
        remote("graph.json", "graph", Some("x")),
        remote("lyrics.json", "lyrics", Some("x")),
        remote("notes.txt", "notes", Some("x")),
    ];
    let p = plan_project(&mine, &theirs).unwrap();
    assert_eq!(
        p.trash
            .iter()
            .map(|s| s.entry.name.as_str())
            .collect::<Vec<_>>(),
        ["graph.json"]
    );
    mine.doc_readable = false;
    assert!(plan_project(&mine, &theirs).unwrap().trash.is_empty());
    mine.doc_readable = true;
    mine.top.push(local("graph.json", false, "graph"));
    assert!(plan_project(&mine, &theirs).unwrap().trash.is_empty());
}
#[test]
fn graph_named_folder_is_preserved_even_when_document_has_no_graph() {
    let mine = snapshot();
    let mut theirs = project();
    let mut graph = remote("graph.json", "folder", None);
    graph.mime_type = Some(FOLDER_MIME.into());
    theirs.top.push(graph);
    assert!(plan_project(&mine, &theirs).unwrap().trash.is_empty());
}
#[test]
fn published_phone_folders_are_never_orphaned_or_selected_for_writer() {
    let mut published = remote("Song", "phone", None);
    published.mime_type = Some(FOLDER_MIME.into());
    published
        .app_properties
        .insert(PUBLISH_STATE_KEY.into(), STATE_PUBLISHED.into());
    let mut ordinary = published.clone();
    ordinary.id = "desktop".into();
    ordinary.app_properties.clear();
    assert!(is_published(&published));
    assert!(
        orphan_folders(&[published.clone()], &[], FOLDER_MIME)
            .unwrap()
            .is_empty()
    );
    assert!(
        select_project_folder(&[published.clone()], "Song")
            .unwrap()
            .is_none()
    );
    let entries = vec![published, ordinary];
    assert_eq!(
        select_project_folder(&entries, "Song").unwrap().unwrap().id,
        "desktop"
    );
    let mut adopted = entries[0].clone();
    adopted
        .app_properties
        .insert(PUBLISH_STATE_KEY.into(), STATE_ADOPTED.into());
    assert_eq!(
        orphan_folders(&[adopted], &[], FOLDER_MIME).unwrap().len(),
        1
    );
    assert_eq!(CATALOG_FORMAT, 2);
    assert_eq!(
        serde_json::to_value(CATALOG_CAPABILITIES).unwrap(),
        json!({"adopt":1})
    );
}
#[test]
fn unknown_root_files_are_preserved_and_only_missing_folders_are_orphaned() {
    let mut folder = remote("Other song", "other", None);
    folder.mime_type = Some(FOLDER_MIME.into());
    let file = remote("catalog.json", "catalog", None);
    let gone = orphan_folders(&[folder, file], &["Song".into()], FOLDER_MIME).unwrap();
    assert_eq!(gone.len(), 1);
    assert_eq!(gone[0].id, "other");
}
#[test]
fn duplicate_and_case_aliases_refuse_instead_of_choosing_a_winner() {
    let mine = snapshot();
    let mut theirs = project();
    theirs.stems = vec![
        remote("vocals.flac", "one", None),
        remote("VOCALS.FLAC", "two", None),
    ];
    assert!(plan_project(&mine, &theirs).is_err());
    theirs.stems = vec![remote("VOCALS.FLAC", "one", None)];
    assert!(plan_project(&mine, &theirs).is_err());
    theirs.stems = vec![remote("vocals.flac", "same", None)];
    theirs.top = vec![remote("project.json", "same", None)];
    assert!(plan_project(&mine, &theirs).is_err());
    let mut mine = mine;
    mine.stems.push(local("VOCALS.FLAC", true, "x"));
    assert!(plan_project(&mine, &project()).is_err());
}
#[test]
fn unicode_normalization_aliases_are_ambiguous_on_desktop_filesystems() {
    let mine = vec![
        local("café.flac", true, "a"),
        local("cafe\u{301}.flac", true, "b"),
    ];
    assert!(plan_sync(&mine, &[]).is_err());
    assert_eq!(
        adoption_name("Café", &["Cafe\u{301}".into()]).unwrap(),
        "Café (phone)"
    );
}
#[test]
fn unsafe_parent_paths_names_and_foreign_members_refuse() {
    for dir in ["..", "../Song", "a\\b", "CON", "Song."] {
        let mut mine = snapshot();
        mine.dir = dir.into();
        assert!(plan_project(&mine, &project()).is_err(), "{dir}");
    }
    let mut mine = snapshot();
    mine.stems[0].path = "/library/Other/stems/vocals.flac".into();
    assert!(plan_project(&mine, &project()).is_err());
    let mut theirs = project();
    theirs.top.push(remote("../project.json", "bad", None));
    assert!(plan_project(&snapshot(), &theirs).is_err());
    theirs.top = vec![remote("project.json", "doc", None)];
    theirs.top[0].parents = vec!["different-folder".into()];
    assert!(plan_project(&snapshot(), &theirs).is_err());
}
#[test]
fn remote_folder_cannot_be_overwritten_as_local_audio() {
    let mine = snapshot();
    let mut theirs = project();
    let mut folder = remote("vocals.flac", "folder", None);
    folder.mime_type = Some(FOLDER_MIME.into());
    theirs.stems.push(folder);
    assert!(plan_project(&mine, &theirs).is_err());
}
#[test]
fn known_stems_folder_listing_is_not_mistaken_for_a_trashable_file() {
    let mut theirs = project();
    let mut stems = remote("stems", "stems", None);
    stems.mime_type = Some(FOLDER_MIME.into());
    stems.parents = vec!["project".into()];
    theirs.top.push(stems);
    let p = plan_project(&snapshot(), &theirs).unwrap();
    assert!(p.trash.is_empty());
}
#[test]
fn missing_or_aliasing_remote_parent_identity_is_refused() {
    let mine = snapshot();
    let mut theirs = RemoteProject::default();
    theirs.top.push(remote("project.json", "doc", None));
    assert!(plan_project(&mine, &theirs).is_err());
    theirs = project();
    theirs.stems_id = theirs.folder_id.clone();
    assert!(plan_project(&mine, &theirs).is_err());
}
#[test]
fn adoption_matches_source_cleanup_and_case_insensitive_suffixes() {
    for (name, expected) in [
        ("Sixteen Tons", "Sixteen Tons"),
        ("AC/DC: Back in Black", "AC DC Back in Black"),
        ("..", "Song from phone"),
        (".hidden", "hidden"),
        ("   ", "Song from phone"),
        (". . . x", "x"),
        (". . .", "Song from phone"),
    ] {
        assert_eq!(adoption_name(name, &[]).unwrap(), expected);
    }
    assert_eq!(
        adoption_name("Sixteen Tons", &["sixteen tons".into()]).unwrap(),
        "Sixteen Tons (phone)"
    );
    assert_eq!(
        adoption_name(
            "Sixteen Tons",
            &["Sixteen Tons".into(), "Sixteen Tons (phone)".into()]
        )
        .unwrap(),
        "Sixteen Tons (phone 2)"
    );
    assert!(adoption_name("CON", &[]).is_err());
}
#[test]
fn plain_name_is_source_exact_while_portable_creation_is_stricter() {
    for bad in ["", ".", "..", "a/b", "a\\b", "nul\0"] {
        assert!(!plain_name(bad));
    }
    assert!(plain_name("vocals.flac"));
    assert!(plain_name("a:b"));
    assert!(validate_portable_name("a:b").is_err());
    assert!(validate_portable_name("歌 🎵.flac").is_ok());
}
#[test]
fn freshness_uses_strict_two_millisecond_tolerance_and_size() {
    assert!(is_fresh(Some((12, 1000.)), (12, 1001.999)));
    assert!(!is_fresh(Some((12, 1000.)), (12, 1002.)));
    assert!(!is_fresh(Some((12, 1000.)), (13, 1000.)));
    assert!(!is_fresh(None, (12, 1000.)));
    assert!(!is_fresh(Some((12, f64::NAN)), (12, 1000.)));
}
#[test]
fn stable_json_recurses_preserving_arrays_and_source_number_semantics() {
    let a = json!({"vocals.flac":{"md5":"x","size":1,"mtimeMs":5},"bass.flac":{"md5":"y","size":2,"mtimeMs":6}});
    let b:Value=serde_json::from_str(r#"{"bass.flac":{"mtimeMs":6,"size":2,"md5":"y"},"vocals.flac":{"mtimeMs":5,"size":1,"md5":"x"}}"#).unwrap();
    assert_eq!(stable_json(&a).unwrap(), stable_json(&b).unwrap());
    assert_eq!(stable_json(&Value::Null).unwrap(), "null");
    assert_eq!(stable_json(&json!([3, 2, 1])).unwrap(), "[3,2,1]");
    for (number, expected) in [
        (json!(1.0), "1"),
        (json!(-0.0), "0"),
        (json!(1e-6), "0.000001"),
        (json!(1e20), "100000000000000000000"),
        (json!(1e21), "1e+21"),
        (json!(1e-7), "1e-7"),
    ] {
        assert_eq!(stable_json(&number).unwrap(), expected);
    }
}
#[test]
fn stable_json_uses_javascript_integer_property_order_and_utf16_key_order() {
    let value = json!({"10":"ten","2":"two","01":"string","😀":1,"\u{e000}":2});
    assert_eq!(
        stable_json(&value).unwrap(),
        "{\"2\":\"two\",\"10\":\"ten\",\"01\":\"string\",\"😀\":1,\"\u{e000}\":2}"
    );
}
#[test]
fn orphan_candidates_and_folder_selection_refuse_harmful_identity_ambiguity() {
    assert!(
        orphans(
            &["Vocals.flac".into()],
            &[remote("vocals.flac", "id", None)]
        )
        .is_err()
    );
    let mut a = remote("Song", "same", None);
    a.mime_type = Some(FOLDER_MIME.into());
    let mut b = a.clone();
    b.app_properties
        .insert(PUBLISH_STATE_KEY.into(), STATE_PUBLISHED.into());
    assert!(select_project_folder(&[a, b], "Song").is_err());
}
