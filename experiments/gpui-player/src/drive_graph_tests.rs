use super::*;
use serde_json::json;
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/shared/graph-document-cases.json"
    ))
    .unwrap()
}
fn node(id: &str) -> Value {
    json!({"id":id,"type":"11111111111111111111111111111111","typeVersion":1,"execution":"builtin","unavailable":"silence","ports":{"inputs":[],"outputs":[]},"parameters":{}})
}
fn graph(nodes: Vec<Value>, connections: Vec<Value>) -> Value {
    json!({"format":1,"engine":"singz-dsp","nodes":nodes,"connections":connections})
}
fn check(value: &Value) -> Result<()> {
    validate(&serde_json::to_vec(value).unwrap(), 1)
}
fn state(bytes: &[u8]) -> Value {
    json!({"encoding":"base64","bytes":bytes.len(),"data":STANDARD.encode(bytes),"sha256":Sha256::digest(bytes).iter().map(|b|format!("{b:02x}")).collect::<String>()})
}
fn set_path(root: &mut Value, path: &[Value], value: Value) {
    let mut at = root;
    for key in &path[..path.len() - 1] {
        at = if let Some(key) = key.as_str() {
            &mut at[key]
        } else {
            &mut at[key.as_u64().unwrap() as usize]
        };
    }
    let key = path.last().unwrap();
    if let Some(key) = key.as_str() {
        at[key] = value;
    } else {
        at[key.as_u64().unwrap() as usize] = value;
    }
}
#[test]
fn shared_production_valid_fixtures_and_opaque_unknown_nodes_pass() {
    let f = fixture();
    for key in ["base", "canonicalEquivalent"] {
        check(&f[key]).unwrap();
    }
    let original = serde_json::to_vec(&f["base"]).unwrap();
    let before = original.clone();
    validate(&original, 1).unwrap();
    assert_eq!(original, before);
    assert_eq!(
        f["base"]["nodes"][2]["unknownNodeField"]["preserve"],
        "exactly"
    );
}
#[test]
fn every_shared_source_invalid_mutation_is_refused() {
    let f = fixture();
    for case in f["invalidMutations"].as_array().unwrap() {
        let mut document = f["base"].clone();
        set_path(
            &mut document,
            case["path"].as_array().unwrap(),
            case["value"].clone(),
        );
        let error = check(&document)
            .expect_err(case["name"].as_str().unwrap())
            .to_string();
        assert!(
            error.contains(case["code"].as_str().unwrap()),
            "{}: {error}",
            case["name"]
        );
    }
}
#[test]
fn future_envelope_is_opaque_and_expected_format_is_bound() {
    let future = serde_json::to_vec(&fixture()["future"]).unwrap();
    validate(&future, 9).unwrap();
    assert!(validate(&future, 1).is_err());
    assert!(validate(&future, 8).is_err());
    for format in [0, u32::MAX as u64 + 1] {
        assert!(
            validate(
                &serde_json::to_vec(&json!({"format":format})).unwrap(),
                format
            )
            .is_err()
        );
    }
    validate(
        br#"{"format":4294967295,"nodes":false,"engine":null}"#,
        u32::MAX as u64,
    )
    .unwrap();
}
#[test]
fn malformed_envelopes_or_nonjson_are_refused() {
    for bytes in [
        b"null".as_slice(),
        b"[]",
        b"true",
        b"{}",
        b"{",
        br#"{"format":1,"engine":"wrong","nodes":[],"connections":[]}"#,
        br#"{"format":1,"engine":"singz-dsp","nodes":{},"connections":[]}"#,
        br#"{"format":2} trailing"#,
        br#"{"format":"2"}"#,
    ] {
        assert!(
            validate(bytes, 1).is_err(),
            "{}",
            String::from_utf8_lossy(bytes)
        );
    }
    assert!(validate(&[0xff], 1).is_err());
}
#[test]
fn format1_uses_portable_node_limit_including_zero_id_and_empty_graph() {
    check(&graph(vec![], vec![])).unwrap();
    let nodes: Vec<_> = (0..MAX_GRAPH_NODES)
        .map(|id| node(&id.to_string()))
        .collect();
    check(&graph(nodes.clone(), vec![])).unwrap();
    let mut over = nodes;
    over.push(node("256"));
    assert!(
        check(&graph(over, vec![]))
            .unwrap_err()
            .to_string()
            .contains("too-many-nodes")
    );
    check(&graph(
        vec![node("0"), node("18446744073709551615")],
        vec![],
    ))
    .unwrap();
    for id in [
        "",
        "01",
        "+1",
        "-1",
        "1.0",
        " 1",
        "18446744073709551616",
        "١",
    ] {
        assert!(check(&graph(vec![node(id)], vec![])).is_err(), "{id}");
    }
}
#[test]
fn native_compilation_caps_are_not_imposed_on_portable_documents() {
    let mut a = node("1");
    let mut outputs = vec![];
    let mut edges = vec![];
    for i in 0..300 {
        let id = format!("p{i}");
        outputs.push(json!({"id":id,"channels":64}));
        edges.push(json!({"from":{"node":"1","port":id},"to":{"node":"2","port":"in"}}));
    }
    a["ports"]["outputs"] = json!(outputs);
    for i in 0..65 {
        a["parameters"][format!("parameter-{i}")] = json!(0.5);
    }
    let mut b = node("2");
    b["ports"]["inputs"] = json!([{"id":"in","channels":1}]);
    check(&graph(vec![a, b], edges)).unwrap();
}
#[test]
fn stable_names_use_utf16_units_and_source_control_character_rules() {
    for (name, valid) in [
        ("x".repeat(128), true),
        ("x".repeat(129), false),
        ("🎤".repeat(64), true),
        ("🎤".repeat(65), false),
        ("\u{85}".into(), true),
        ("\u{7f}".into(), false),
        ("a\nb".into(), false),
    ] {
        let mut n = node("1");
        n["execution"] = json!(name);
        assert_eq!(check(&graph(vec![n], vec![])).is_ok(), valid);
    }
}
#[test]
fn ports_and_parameters_and_bindings_follow_wire_contract() {
    for channels in [json!(0), json!(65), json!(1.5), json!("2"), Value::Null] {
        let mut n = node("1");
        n["ports"]["inputs"] = json!([{"id":"in","channels":channels}]);
        assert!(check(&graph(vec![n], vec![])).is_err());
    }
    let mut n = node("1");
    n["ports"]["inputs"] = json!([{"id":"same","channels":1},{"id":"same","channels":2}]);
    assert!(check(&graph(vec![n], vec![])).is_err());
    for parameter in [
        json!(-0.1),
        json!(1.1),
        json!(true),
        json!("0.5"),
        Value::Null,
    ] {
        let mut n = node("1");
        n["parameters"]["gain"] = parameter;
        assert!(check(&graph(vec![n], vec![])).is_err());
    }
    for binding in [
        Value::Null,
        json!({"kind":"project-lane"}),
        json!({"kind":"future","laneId":null}),
        json!({"kind":""}),
    ] {
        let mut n = node("1");
        n["binding"] = binding;
        assert!(check(&graph(vec![n], vec![])).is_err());
    }
    let mut n = node("1");
    n["binding"] = json!({"kind":"future-vendor","laneId":"歌 🎤","opaque":{"keep":true}});
    check(&graph(vec![n], vec![])).unwrap();
}
#[test]
fn finite_normalized_numbers_and_integral_float_fields_match_javascript() {
    let mut n = node("1");
    n["typeVersion"] = json!(4294967295.0);
    n["ports"]["outputs"] = json!([{"id":"out","channels":64.0}]);
    n["parameters"] = json!({"zero":-0.0,"one":1.0});
    let mut g = graph(vec![n], vec![]);
    g["format"] = json!(1.0);
    check(&g).unwrap();
    let bytes=br#"{"format":1,"engine":"singz-dsp","nodes":[{"id":"1","type":"11111111111111111111111111111111","typeVersion":1,"execution":"native","unavailable":"silence","ports":{"inputs":[],"outputs":[]},"parameters":{"gain":1e400}}],"connections":[]}"#;
    assert!(validate(bytes, 1).is_err());
}
#[test]
fn adapter_state_requires_canonical_base64_count_and_sha256() {
    for bytes in [b"".as_slice(), b"hello", &[0, 1, 255]] {
        let mut n = node("1");
        n["adapterState"] = state(bytes);
        check(&graph(vec![n], vec![])).unwrap();
    }
    for data in ["YQ", "YQ=", "YR==", "YQ==\n", "====", "éé"] {
        let mut n = node("1");
        n["adapterState"] = state(b"a");
        n["adapterState"]["data"] = json!(data);
        assert!(check(&graph(vec![n], vec![])).is_err(), "{data}");
    }
    for bad in [Value::Null, json!({"encoding":"hex"})] {
        let mut n = node("1");
        n["adapterState"] = bad;
        assert!(check(&graph(vec![n], vec![])).is_err());
    }
}
#[test]
fn adapter_state_per_node_cap_is_checked_before_decode() {
    let mut n = node("1");
    n["adapterState"] = state(&[]);
    n["adapterState"]["bytes"] = json!(MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE + 1);
    let error = check(&graph(vec![n], vec![])).unwrap_err().to_string();
    assert!(error.contains("node-state-too-large"));
    let mut n = node("1");
    n["adapterState"] = state(&vec![0; MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE]);
    check(&graph(vec![n], vec![])).unwrap();
}
#[test]
fn aggregate_adapter_state_eight_mib_boundary_is_enforced() {
    let payload = state(&vec![0; MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE]);
    let mut nodes = vec![];
    for i in 0..8 {
        let mut n = node(&i.to_string());
        n["adapterState"] = payload.clone();
        nodes.push(n);
    }
    check(&graph(nodes.clone(), vec![])).unwrap();
    let mut extra = node("8");
    extra["adapterState"] = state(&[1]);
    nodes.push(extra);
    let error = check(&graph(nodes, vec![])).unwrap_err().to_string();
    assert!(error.contains("document-state-too-large"), "{error}");
}
#[test]
fn duplicate_and_missing_connection_endpoints_are_rejected_without_dsp_rules() {
    let mut a = node("1");
    a["ports"]["inputs"] = json!([{"id":"in","channels":1}]);
    a["ports"]["outputs"] = json!([{"id":"out","channels":2}]);
    let edge = json!({"from":{"node":"1","port":"out"},"to":{"node":"1","port":"in"}});
    check(&graph(vec![a.clone()], vec![edge.clone()])).unwrap();
    assert!(
        check(&graph(vec![a.clone()], vec![edge.clone(), edge.clone()]))
            .unwrap_err()
            .to_string()
            .contains("duplicate-connection")
    );
    let mut missing = edge;
    missing["to"]["node"] = json!("2");
    assert!(check(&graph(vec![a], vec![missing])).is_err());
}
#[test]
fn unknown_deep_metadata_and_future_schema_are_not_interpreted() {
    let nested = format!("{}0{}", "[".repeat(600), "]".repeat(600));
    let known = format!(
        "{{\"format\":1,\"engine\":\"singz-dsp\",\"nodes\":[],\"connections\":[],\"__proto__\":{nested}}}"
    );
    validate(known.as_bytes(), 1).unwrap();
    let future =
        format!("{{\"format\":9,\"nodes\":{nested},\"hugeNumber\":1e400,\"opaque\":\"\\ud800\"}}");
    validate(future.as_bytes(), 9).unwrap();
}
#[test]
fn duplicate_json_properties_use_last_value_as_source_json_parse_does() {
    validate(br#"{"format":0,"format":1,"engine":"wrong","engine":"singz-dsp","nodes":[],"connections":[]}"#,1).unwrap();
    let n = r#"{"id":"bad","id":"1","type":"11111111111111111111111111111111","typeVersion":1,"execution":"native","unavailable":"silence","ports":{"inputs":[],"outputs":[]},"parameters":{}}"#;
    validate(
        format!("{{\"format\":1,\"engine\":\"singz-dsp\",\"nodes\":[{n}],\"connections\":[]}}")
            .as_bytes(),
        1,
    )
    .unwrap();
}
#[test]
fn serde_private_number_shaped_objects_are_not_accepted_as_numeric_controls() {
    let raw=br#"{"format":{"$serde_json::private::Number":"1"},"engine":"singz-dsp","nodes":[],"connections":[]}"#;
    assert!(validate(raw, 1).is_err());
}
#[test]
fn encoded_document_cap_is_exact_and_applies_to_future_payloads_too() {
    let mut bytes = br#"{"format":9}"#.to_vec();
    bytes.resize(MAX_GRAPH_DOCUMENT_TEXT_BYTES, b' ');
    validate(&bytes, 9).unwrap();
    bytes.push(b' ');
    assert!(
        validate(&bytes, 9)
            .unwrap_err()
            .to_string()
            .contains("document-too-large")
    );
}

fn named_graph(a: &str, b: &str) -> Vec<u8> {
    let mut n = node("1");
    n["execution"] = json!("$a$");
    n["ports"] = json!({"inputs":[{"id":"$b$","channels":1}],
        "outputs":[{"id":"$a$","channels":1},{"id":"$b$","channels":1}]});
    n["parameters"] = json!({"$a$":0.2,"$b$":0.7});
    n["binding"] = json!({"kind":"$a$","laneId":"$b$"});
    serde_json::to_string(&graph(
        vec![n],
        vec![json!({
            "from":{"node":"1","port":"$a$"},"to":{"node":"1","port":"$b$"}
        })],
    ))
    .unwrap()
    .replace("\"$a$\"", a)
    .replace("\"$b$\"", b)
    .into_bytes()
}

#[test]
fn escaped_unpaired_names_remain_distinct_and_match_connection_endpoints() {
    for other in [
        r#""\ud801""#,
        r#""\udc00""#,
        r#""\ufffd""#,
        r#""\\ud800""#,
        r#""\ue000""#,
        r#""\u00ed\u00a0\u0080""#,
    ] {
        let bytes = named_graph(r#""\ud800""#, other);
        let original = bytes.clone();
        validate(&bytes, 1).unwrap();
        assert_eq!(bytes, original);
    }
    let duplicate = named_graph(r#""\ud800""#, r#""\uD800""#);
    assert!(
        validate(&duplicate, 1)
            .unwrap_err()
            .to_string()
            .contains("duplicate port ID")
    );
    let mut n = node("1");
    n["ports"] = json!({"inputs":[],"outputs":[{"id":"$a$","channels":1}]});
    let bytes = serde_json::to_string(&graph(
        vec![n],
        vec![json!({
            "from":{"node":"1","port":"$b$"},"to":{"node":"1","port":"$b$"}
        })],
    ))
    .unwrap()
    .replace("\"$a$\"", r#""\ud800""#)
    .replace("\"$b$\"", r#""\ufffd""#);
    assert!(
        validate(bytes.as_bytes(), 1)
            .unwrap_err()
            .to_string()
            .contains("missing node or port")
    );
}

#[test]
fn paired_escapes_and_literal_unicode_have_the_same_identity_and_utf16_limit() {
    for (json, units) in [
        (r#""\ud800\ud800\udc00""#, 3),
        (r#""\udc00\ud800""#, 2),
        (r#""\ud800\u0041\udc00""#, 3),
    ] {
        let value = project(json.as_bytes(), Scope::Text).unwrap();
        assert_eq!(text_utf16_len(value.as_str().unwrap()), units);
    }
    let duplicate = named_graph(r#""\ud83d\ude00""#, "\"😀\"");
    assert!(
        validate(&duplicate, 1)
            .unwrap_err()
            .to_string()
            .contains("duplicate port ID")
    );
    for (unit, limit) in [
        ("\\ud800", 128),
        ("é", 128),
        ("😀", 64),
        ("\\ud83d\\ude00", 64),
    ] {
        for (count, accepted) in [(limit, true), (limit + 1, false)] {
            let name = format!("\"{}\"", unit.repeat(count));
            assert_eq!(
                validate(&named_graph(&name, "\"other\""), 1).is_ok(),
                accepted,
                "{unit} × {count}"
            );
        }
    }
}

#[test]
fn every_bmp_code_unit_has_a_unique_projection_and_one_utf16_unit() {
    let mut seen = HashSet::new();
    for unit in 0..=u16::MAX {
        let json = format!("\"\\u{unit:04x}\"");
        let projected = project(json.as_bytes(), Scope::Text).unwrap();
        let text = projected.as_str().unwrap();
        assert_eq!(text_utf16_len(text), 1, "{unit:04x}");
        assert!(
            seen.insert(text.to_owned()),
            "String identity collision: {unit:04x}"
        );
        assert_eq!(
            stable(&projected).is_ok(),
            unit > 0x1f && unit != 0x7f,
            "{unit:04x}"
        );
    }
}

#[test]
fn malformed_string_escapes_and_invalid_literal_utf8_are_not_surrogate_permissions() {
    for bad in [r#""\ud80""#, r#""\ud80z""#, r#""\q""#, "\"\n\""] {
        assert!(
            validate(&named_graph(bad, "\"other\""), 1).is_err(),
            "{bad}"
        );
    }
    let mut invalid = named_graph("\"ascii\"", "\"other\"");
    let position = invalid.windows(5).position(|w| w == b"ascii").unwrap();
    invalid[position] = 0xff;
    assert!(validate(&invalid, 1).is_err());
    // A surrogate key in opaque metadata is legal and never becomes a schema key.
    validate(br#"{"format":1,"engine":"singz-dsp","nodes":[],"connections":[],"\ud800":{"unknown":"\udc00"}}"#,1).unwrap();
}
