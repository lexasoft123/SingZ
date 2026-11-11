//! Portable graph boundary. Unknown bytes never enter DSP or get reserialized;
//! callers retain/hash the exact accepted source payload. Playback receives only
//! a separately bounded projection of recognized control fields.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::{
    Deserialize,
    de::{DeserializeSeed, IgnoredAny, MapAccess, SeqAccess, Visitor},
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fmt,
};
pub const GRAPH_DOCUMENT_FORMAT: u64 = 1;
pub const GRAPH_DOCUMENT_ENGINE: &str = "singz-dsp";
pub const MAX_GRAPH_NODES: usize = 256;
pub const MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE: usize = 1024 * 1024;
pub const MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT: usize = 8 * 1024 * 1024;
pub const MAX_GRAPH_DOCUMENT_TEXT_BYTES: usize = 12 * 1024 * 1024;

// JSON.parse strings are UTF-16 and may contain escaped lone surrogates. Rust
// strings cannot. serde_json's byte-string reader preserves them as WTF-8 and
// canonicalizes paired escapes to the same bytes as literal Unicode. Project
// each byte to its same-valued Rust char: this is injective, keeps ASCII schema
// keys/tokens unchanged, and cannot alias a surrogate with U+FFFD or private-use
// Unicode. These private projected strings are only compared/validated; they
// must never be displayed, passed to DSP, or serialized back into the document.
struct GraphText(String);
impl<'de> Deserialize<'de> for GraphText {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        struct Bytes;
        impl<'de> Visitor<'de> for Bytes {
            type Value = GraphText;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("graph JSON string")
            }
            fn visit_bytes<E: serde::de::Error>(
                self,
                bytes: &[u8],
            ) -> std::result::Result<GraphText, E> {
                Ok(GraphText(bytes.iter().map(|&b| char::from(b)).collect()))
            }
        }
        d.deserialize_bytes(Bytes)
    }
}
fn text_utf16_len(text: &str) -> usize {
    // Every projected char is one WTF-8 byte. Continuation bytes contribute no
    // units; a four-byte scalar contributes two; lone surrogates contribute one.
    text.chars()
        .map(|c| c as u32)
        .filter(|b| b & 0xc0 != 0x80)
        .map(|b| if b >= 0xf0 { 2 } else { 1 })
        .sum()
}
// Unknown values are skipped by serde_json's iterative IgnoredAny reader.
// This keeps opaque payloads bounded by bytes without imposing Value's depth
// limit on metadata this reader must never interpret or migrate.
#[derive(Clone, Copy)]
enum Scope {
    Format,
    Envelope,
    Nodes,
    Node,
    Ports,
    PortList,
    Port,
    Parameters,
    Binding,
    State,
    Connections,
    Connection,
    Endpoint,
    Text,
    Number,
}
impl Scope {
    fn child(self, key: &str) -> Option<Self> {
        use Scope::*;
        match self {
            Format => match key {
                "format" => Some(Number),
                _ => None,
            },
            Envelope => match key {
                "format" => Some(Number),
                "engine" => Some(Text),
                "nodes" => Some(Nodes),
                "connections" => Some(Connections),
                _ => None,
            },
            Node => match key {
                "id" | "type" | "execution" | "unavailable" => Some(Text),
                "typeVersion" => Some(Number),
                "ports" => Some(Ports),
                "parameters" => Some(Parameters),
                "binding" => Some(Binding),
                "adapterState" => Some(State),
                _ => None,
            },
            Ports => match key {
                "inputs" | "outputs" => Some(PortList),
                _ => None,
            },
            Port => match key {
                "id" => Some(Text),
                "channels" => Some(Number),
                _ => None,
            },
            Parameters => Some(Number),
            Binding => match key {
                "kind" | "laneId" => Some(Text),
                _ => None,
            },
            State => match key {
                "encoding" | "sha256" | "data" => Some(Text),
                "bytes" => Some(Number),
                _ => None,
            },
            Connection => match key {
                "from" | "to" => Some(Endpoint),
                _ => None,
            },
            Endpoint => match key {
                "node" | "port" => Some(Text),
                _ => None,
            },
            _ => None,
        }
    }
    fn element(self) -> Option<Self> {
        match self {
            Self::Nodes => Some(Self::Node),
            Self::PortList => Some(Self::Port),
            Self::Connections => Some(Self::Connection),
            _ => None,
        }
    }
}
impl<'de> DeserializeSeed<'de> for Scope {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(
        self,
        d: D,
    ) -> std::result::Result<Value, D::Error> {
        match self {
            Self::Text => GraphText::deserialize(d).map(|text| Value::String(text.0)),
            Self::Number => f64::deserialize(d).and_then(|number| {
                serde_json::Number::from_f64(number)
                    .map(Value::Number)
                    .ok_or_else(|| serde::de::Error::custom("Nonfinite graph control number"))
            }),
            _ => d.deserialize_any(Projection(self)),
        }
    }
}
struct Projection(Scope);
impl<'de> Visitor<'de> for Projection {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("portable graph JSON")
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> std::result::Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(GraphText(key)) = map.next_key::<GraphText>()? {
            if let Some(scope) = self.0.child(&key) {
                out.insert(key, map.next_value_seed(scope)?);
            } else {
                map.next_value::<IgnoredAny>()?;
            }
        }
        Ok(Value::Object(out))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> std::result::Result<Value, A::Error> {
        let mut out = vec![];
        if let Some(scope) = self.0.element() {
            while let Some(value) = seq.next_element_seed(scope)? {
                out.push(value);
            }
        } else {
            while seq.next_element::<IgnoredAny>()?.is_some() {}
        }
        Ok(Value::Array(out))
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(Value::Bool(v))
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(v.into())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        Ok(serde_json::Number::from_f64(v)
            .map(Value::Number)
            .unwrap_or(Value::Null))
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(Value::String(v.into()))
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(Value::String(v))
    }
    fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
}
fn project(bytes: &[u8], scope: Scope) -> Result<Value> {
    // Byte-string deserialization deliberately permits escaped surrogates, but
    // invalid literal UTF-8 must not gain that permission.
    std::str::from_utf8(bytes).context("invalid-json: graph text is not UTF-8")?;
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    let value = scope
        .deserialize(&mut parser)
        .context("invalid-json: graph document is not valid JSON")?;
    parser
        .end()
        .context("invalid-json: trailing graph content")?;
    Ok(value)
}
fn integer(value: &Value, min: u64, max: u64) -> bool {
    value
        .as_f64()
        .is_some_and(|n| n.is_finite() && n.fract() == 0. && n >= min as f64 && n <= max as f64)
}
fn node_id(value: &Value) -> Result<&str> {
    let id = value
        .as_str()
        .context("invalid-node-id: ID must be an unsigned decimal string")?;
    ensure!(
        !id.is_empty()
            && (id == "0" || !id.starts_with('0'))
            && id.bytes().all(|b| b.is_ascii_digit())
            && id.parse::<u64>().is_ok(),
        "invalid-node-id: ID is not canonical uint64"
    );
    Ok(id)
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn stable(value: &Value) -> Result<&str> {
    let name = value
        .as_str()
        .context("invalid-stable-name: expected stable string")?;
    ensure!(
        (1..=128).contains(&text_utf16_len(name))
            && !name.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}'),
        "invalid-stable-name: stable string exceeds contract"
    );
    Ok(name)
}
fn ports(value: &Value) -> Result<HashSet<String>> {
    let list = value.as_array().context("invalid-ports: expected array")?;
    let mut ids = HashSet::new();
    for port in list {
        ensure!(port.is_object(), "invalid-ports: expected port object");
        let id = stable(&port["id"])?;
        ensure!(
            ids.insert(id.to_owned()),
            "invalid-ports: duplicate port ID"
        );
        ensure!(
            integer(&port["channels"], 1, 64),
            "invalid-ports: channels must be integer from 1 to 64"
        );
    }
    Ok(ids)
}
fn binding(value: Option<&Value>) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    ensure!(value.is_object(), "invalid-binding: expected object");
    let kind = stable(&value["kind"])?;
    if kind == "project-lane" || value.get("laneId").is_some() {
        stable(&value["laneId"])?;
    }
    Ok(())
}
fn state(value: Option<&Value>) -> Result<usize> {
    let Some(value) = value else {
        return Ok(0);
    };
    ensure!(value.is_object(), "invalid-adapter-state: expected object");
    ensure!(
        value["encoding"] == "base64",
        "invalid-adapter-state: encoding must be base64"
    );
    if value["bytes"].is_number()
        && value["bytes"]
            .as_f64()
            .is_some_and(|n| n > MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE as f64)
    {
        anyhow::bail!("node-state-too-large: decoded adapter state exceeds cap");
    }
    ensure!(
        integer(
            &value["bytes"],
            0,
            MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE as u64
        ),
        "invalid-adapter-state: invalid byte count"
    );
    let expected = value["bytes"].as_f64().unwrap() as usize;
    let hash = value["sha256"]
        .as_str()
        .filter(|s| hex(s, 64))
        .context("invalid-adapter-state: expected lowercase SHA-256")?;
    let data = value["data"]
        .as_str()
        .context("invalid-adapter-state: expected base64 string")?;
    ensure!(
        data.len() % 4 == 0,
        "invalid-adapter-state: noncanonical base64 length"
    );
    let padding = if data.ends_with("==") {
        2
    } else if data.ends_with('=') {
        1
    } else {
        0
    };
    let decoded_len = data.len() / 4 * 3 - padding;
    ensure!(
        decoded_len <= MAX_GRAPH_ADAPTER_STATE_BYTES_PER_NODE,
        "node-state-too-large: decoded adapter state exceeds cap"
    );
    ensure!(
        decoded_len == expected,
        "invalid-adapter-state: byte count does not match data"
    );
    let decoded = STANDARD
        .decode(data)
        .context("invalid-adapter-state: invalid base64 or nonzero pad bits")?;
    ensure!(
        STANDARD.encode(&decoded) == data,
        "invalid-adapter-state: noncanonical base64"
    );
    let actual: String = Sha256::digest(&decoded)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    ensure!(
        actual == hash,
        "invalid-adapter-state: SHA-256 does not match data"
    );
    Ok(decoded.len())
}
struct Node {
    inputs: HashSet<String>,
    outputs: HashSet<String>,
}
/// Validate format 1's portable control document, not the narrower native
/// compilation projection. Future formats remain opaque and hash-bound by the
/// caller; no graph is executed, normalized, rewritten, or downgraded here.
pub fn validate(bytes: &[u8], expected_format: u64) -> Result<()> {
    ensure!(
        bytes.len() <= MAX_GRAPH_DOCUMENT_TEXT_BYTES,
        "document-too-large: graph exceeds 12 MiB encoded cap"
    );
    let envelope = project(bytes, Scope::Format)?;
    ensure!(
        envelope.is_object() && integer(&envelope["format"], 1, u32::MAX as u64),
        "invalid-envelope: positive uint32 format required"
    );
    let format = envelope["format"].as_f64().unwrap() as u64;
    ensure!(
        format == expected_format,
        "invalid-envelope: graph format differs from project reference"
    );
    if format > GRAPH_DOCUMENT_FORMAT {
        return Ok(());
    }
    let raw = project(bytes, Scope::Envelope)?;
    ensure!(
        raw["engine"] == GRAPH_DOCUMENT_ENGINE,
        "invalid-envelope: unsupported graph engine"
    );
    let nodes = raw["nodes"]
        .as_array()
        .context("invalid-envelope: nodes must be array")?;
    let connections = raw["connections"]
        .as_array()
        .context("invalid-envelope: connections must be array")?;
    ensure!(
        nodes.len() <= MAX_GRAPH_NODES,
        "too-many-nodes: graph exceeds 256 node cap"
    );
    let mut known = HashMap::new();
    let mut state_bytes = 0;
    for node in nodes {
        ensure!(node.is_object(), "invalid-node: expected object");
        let id = node_id(&node["id"])?;
        ensure!(
            node["type"].as_str().is_some_and(|s| hex(s, 32)),
            "invalid-type-id: expected lowercase 128-bit type"
        );
        ensure!(
            integer(&node["typeVersion"], 1, u32::MAX as u64),
            "invalid-type-version: expected positive uint32"
        );
        stable(&node["execution"])?;
        ensure!(
            node["unavailable"] == "bypass" || node["unavailable"] == "silence",
            "invalid-unavailable-policy: expected bypass or silence"
        );
        ensure!(node["ports"].is_object(), "invalid-ports: expected object");
        let inputs = ports(&node["ports"]["inputs"])?;
        let outputs = ports(&node["ports"]["outputs"])?;
        let parameters = node["parameters"]
            .as_object()
            .context("invalid-parameter: expected object")?;
        for (key, value) in parameters {
            stable(&Value::String(key.clone()))?;
            ensure!(
                value
                    .as_f64()
                    .is_some_and(|n| n.is_finite() && (0. ..=1.).contains(&n)),
                "invalid-parameter: value must be finite and normalized"
            );
        }
        binding(node.get("binding"))?;
        ensure!(
            known
                .insert(id.to_owned(), Node { inputs, outputs })
                .is_none(),
            "duplicate-node-id: duplicate graph node"
        );
        state_bytes += state(node.get("adapterState"))?;
        ensure!(
            state_bytes <= MAX_GRAPH_ADAPTER_STATE_BYTES_PER_DOCUMENT,
            "document-state-too-large: aggregate adapter state exceeds 8 MiB"
        );
    }
    let mut edges = HashSet::new();
    for connection in connections {
        ensure!(
            connection.is_object()
                && connection["from"].is_object()
                && connection["to"].is_object(),
            "invalid-connection: expected endpoint objects"
        );
        let from = node_id(&connection["from"]["node"])?;
        let to = node_id(&connection["to"]["node"])?;
        let output = stable(&connection["from"]["port"])?;
        let input = stable(&connection["to"]["port"])?;
        ensure!(
            known.get(from).is_some_and(|n| n.outputs.contains(output))
                && known.get(to).is_some_and(|n| n.inputs.contains(input)),
            "invalid-connection: missing node or port"
        );
        ensure!(
            edges.insert((from, output, to, input)),
            "duplicate-connection: duplicate graph edge"
        );
    }
    Ok(())
}

/// Private helper wire projection, never a replacement for graph.json. Native
/// materialization still owns topology, lane binding and processor admission.
pub fn playback_projection(bytes: &[u8]) -> Result<String> {
    use std::fmt::Write;
    fn text(value: &Value) -> Result<String> {
        let projected = value.as_str().context("Missing native graph string")?;
        let bytes: Vec<u8> = projected.chars().map(|c| c as u8).collect();
        std::str::from_utf8(&bytes)
            .context("Native graph playback cannot represent an unpaired UTF-16 name")?;
        ensure!(
            !bytes.is_empty() && bytes.len() <= 128,
            "Native graph name exceeds its 128-byte limit"
        );
        Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
    }
    validate(bytes, 1)?;
    let raw = project(bytes, Scope::Envelope)?;
    let nodes = raw["nodes"].as_array().unwrap();
    let edges = raw["connections"].as_array().unwrap();
    ensure!(
        !nodes.is_empty() && nodes.len() <= 128 && edges.len() <= 256,
        "Graph exceeds native playback node/connection limits"
    );
    let mut wire = format!("SingZGraph1 {} {}\n", nodes.len(), edges.len());
    for node in nodes {
        let id = node_id(&node["id"])?;
        ensure!(id != "0", "Native graph playback requires nonzero node IDs");
        let inputs = node["ports"]["inputs"].as_array().unwrap();
        let outputs = node["ports"]["outputs"].as_array().unwrap();
        let parameters = node["parameters"].as_object().unwrap();
        ensure!(
            inputs.len() <= 16 && outputs.len() <= 16 && parameters.len() <= 64,
            "Graph exceeds native playback port/parameter limits"
        );
        writeln!(
            wire,
            "node {id} {} {} {} {} {} {} {} {}",
            node["type"].as_str().unwrap(),
            node["typeVersion"].as_f64().unwrap() as u32,
            text(&node["execution"])?,
            u8::from(node["unavailable"] == "silence"),
            inputs.len(),
            outputs.len(),
            parameters.len(),
            u8::from(node.get("binding").is_some())
        )?;
        for port in inputs.iter().chain(outputs) {
            writeln!(
                wire,
                "port {} {}",
                text(&port["id"])?,
                port["channels"].as_f64().unwrap() as u32
            )?;
        }
        for (id, value) in parameters {
            writeln!(
                wire,
                "param {} {}",
                text(&Value::String(id.clone()))?,
                value.as_f64().unwrap()
            )?;
        }
        if let Some(binding) = node.get("binding") {
            let lane = binding
                .get("laneId")
                .map(text)
                .transpose()?
                .unwrap_or_else(|| "-".into());
            writeln!(wire, "binding {} {lane}", text(&binding["kind"])?)?;
        }
    }
    for edge in edges {
        writeln!(
            wire,
            "edge {} {} {} {}",
            node_id(&edge["from"]["node"])?,
            text(&edge["from"]["port"])?,
            node_id(&edge["to"]["node"])?,
            text(&edge["to"]["port"])?
        )?;
    }
    wire.push_str("end\n");
    ensure!(
        wire.len() <= 8 * 1024 * 1024,
        "Native graph projection exceeds its byte cap"
    );
    Ok(wire)
}
#[cfg(test)]
#[path = "drive_graph_tests.rs"]
mod tests;
