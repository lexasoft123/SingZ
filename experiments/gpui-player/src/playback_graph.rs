//! Validated projection of the engine's immutable prepared runtime topology.
//! Invalid/missing visualization metadata never becomes an invented graph and
//! does not stop otherwise valid playback. Mirrors DspGraphVisualization.tsx.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

pub const MAX_NODES: usize = 128;
pub const MAX_CONNECTIONS: usize = 256;
pub const MAX_BUSES: usize = 16;

// Match the desktop projection's lossless decimal-u64 wire representation.
mod decimal {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let text = String::deserialize(deserializer)?;
        if text.is_empty()
            || text.len() > 20
            || (text.len() > 1 && text.starts_with('0'))
            || !text.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(D::Error::custom("Invalid graph decimal counter"));
        }
        text.parse().map_err(D::Error::custom)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    #[serde(with = "decimal")]
    pub generation: u64,
    pub format_version: u32,
    pub sample_rate: f64,
    pub maximum_frames: u32,
    pub output_latency_frames: u32,
    pub latency_compensated_connection_count: u32,
    pub nodes: Vec<Node>,
    pub connections: Vec<Connection>,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    #[serde(with = "decimal")]
    pub id: u64,
    pub label: String,
    pub role: String,
    pub kind: String,
    #[serde(with = "decimal")]
    pub type_high: u64,
    #[serde(with = "decimal")]
    pub type_low: u64,
    pub schema_version: u32,
    pub flags: u32,
    pub input_bus_count: u32,
    pub output_bus_count: u32,
    pub input_bus_channels: Vec<u32>,
    pub output_bus_channels: Vec<u32>,
    pub intrinsic_latency_frames: u32,
    pub arrival_latency_frames: u32,
    pub output_latency_frames: u32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    #[serde(with = "decimal")]
    pub source_node_id: u64,
    pub source_bus: u32,
    pub source_channels: u32,
    #[serde(with = "decimal")]
    pub destination_node_id: u64,
    pub destination_bus: u32,
    pub destination_channels: u32,
    pub source_output_latency_frames: u32,
    pub destination_arrival_latency_frames: u32,
    pub compensation_frames: u32,
    pub latency_compensated: bool,
}

fn counter(status: &Value, key: &str) -> Result<u64> {
    status[key]
        .as_u64()
        .with_context(|| format!("Invalid runtime graph {key}"))
}

pub fn parse_status(status: &Value) -> Result<Option<Snapshot>> {
    let Some(value) = status.get("graphSnapshot").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    let graph: Snapshot =
        serde_json::from_value(value.clone()).context("Invalid structured runtime graph")?;
    ensure!(
        graph.generation != 0 && graph.generation == counter(status, "graphGeneration")?,
        "Stale runtime graph generation"
    );
    ensure!(
        graph.format_version > 0
            && graph.sample_rate.is_finite()
            && graph.sample_rate > 0.
            && graph.maximum_frames > 0,
        "Invalid runtime graph format"
    );
    ensure!(
        !graph.nodes.is_empty()
            && graph.nodes.len() <= MAX_NODES
            && graph.connections.len() <= MAX_CONNECTIONS,
        "Runtime graph exceeds bounds"
    );
    ensure!(
        graph.nodes.len() as u64 == counter(status, "graphNodeCount")?
            && graph.connections.len() as u64 == counter(status, "graphConnectionCount")?
            && graph.output_latency_frames as u64 == counter(status, "graphLatencyFrames")?
            && graph.latency_compensated_connection_count as u64
                == counter(status, "latencyCompensatedEdgeCount")?,
        "Runtime graph totals disagree with status"
    );
    let mut nodes = HashMap::new();
    let mut inputs = 0;
    for node in &graph.nodes {
        ensure!(
            node.id != 0 && nodes.insert(node.id, node).is_none(),
            "Invalid or duplicate runtime graph node ID"
        );
        ensure!(
            !node.label.is_empty() && node.label.len() <= 256,
            "Invalid runtime graph label"
        );
        ensure!(
            matches!(node.role.as_str(), "input" | "processor" | "output"),
            "Unknown runtime graph node role"
        );
        ensure!(
            matches!(
                node.kind.as_str(),
                "unknown"
                    | "physical-output"
                    | "decoded-source"
                    | "channel-map"
                    | "gain"
                    | "mix"
                    | "scheduled-gain"
                    | "signalsmith-time-pitch"
                    | "scheduled-cue-source"
                    | "peak-rms"
                    | "tap"
                    | "oscillator"
                    | "safety-limiter"
                    | "unavailable-bypass"
                    | "unavailable-silence"
            ),
            "Unknown runtime graph node kind"
        );
        ensure!(
            node.input_bus_count as usize <= MAX_BUSES
                && node.output_bus_count as usize <= MAX_BUSES
                && node.input_bus_channels.len() == node.input_bus_count as usize
                && node.output_bus_channels.len() == node.output_bus_count as usize
                && node
                    .input_bus_channels
                    .iter()
                    .chain(&node.output_bus_channels)
                    .all(|n| *n > 0),
            "Invalid runtime graph buses"
        );
        ensure!(
            node.arrival_latency_frames
                .checked_add(node.intrinsic_latency_frames)
                == Some(node.output_latency_frames),
            "Invalid runtime graph node latency"
        );
        inputs += node.input_bus_count as usize;
    }
    ensure!(
        inputs == graph.connections.len(),
        "Runtime graph has unconnected inputs"
    );
    let mut destinations = HashSet::new();
    let mut compensated = 0;
    for edge in &graph.connections {
        let source = nodes
            .get(&edge.source_node_id)
            .context("Missing runtime graph source")?;
        let destination = nodes
            .get(&edge.destination_node_id)
            .context("Missing runtime graph destination")?;
        ensure!(
            destinations.insert((edge.destination_node_id, edge.destination_bus)),
            "Duplicate runtime graph destination bus"
        );
        ensure!(
            source.output_bus_channels.get(edge.source_bus as usize) == Some(&edge.source_channels)
                && destination
                    .input_bus_channels
                    .get(edge.destination_bus as usize)
                    == Some(&edge.destination_channels)
                && edge.source_channels > 0
                && edge.source_channels == edge.destination_channels,
            "Invalid runtime graph connection buses"
        );
        let arrival = if destination.role == "output" {
            graph.output_latency_frames
        } else {
            destination.arrival_latency_frames
        };
        ensure!(
            edge.source_output_latency_frames == source.output_latency_frames
                && edge.destination_arrival_latency_frames == arrival
                && arrival.checked_sub(edge.source_output_latency_frames)
                    == Some(edge.compensation_frames)
                && edge.latency_compensated == (edge.compensation_frames != 0),
            "Invalid runtime graph connection latency"
        );
        if edge.latency_compensated {
            compensated += 1;
        }
    }
    ensure!(
        compensated == graph.latency_compensated_connection_count,
        "Runtime graph compensation total differs"
    );
    Ok(Some(graph))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn status() -> Value {
        let node = |id: u64,
                    role: &str,
                    kind: &str,
                    inputs: Vec<u32>,
                    outputs: Vec<u32>,
                    intrinsic,
                    arrival,
                    output| Node {
            id,
            label: format!("Node {id}"),
            role: role.into(),
            kind: kind.into(),
            type_high: u64::MAX,
            type_low: 9,
            schema_version: 1,
            flags: 0,
            input_bus_count: inputs.len() as u32,
            output_bus_count: outputs.len() as u32,
            input_bus_channels: inputs,
            output_bus_channels: outputs,
            intrinsic_latency_frames: intrinsic,
            arrival_latency_frames: arrival,
            output_latency_frames: output,
        };
        let edge = |source, dest, arrival, compensation| Connection {
            source_node_id: source,
            source_bus: 0,
            source_channels: 2,
            destination_node_id: dest,
            destination_bus: 0,
            destination_channels: 2,
            source_output_latency_frames: 7,
            destination_arrival_latency_frames: arrival,
            compensation_frames: compensation,
            latency_compensated: compensation != 0,
        };
        let graph = Snapshot {
            generation: 3,
            format_version: 1,
            sample_rate: 48000.,
            maximum_frames: 512,
            output_latency_frames: 9,
            latency_compensated_connection_count: 1,
            nodes: vec![
                node(
                    u64::MAX,
                    "input",
                    "decoded-source",
                    vec![],
                    vec![2],
                    7,
                    0,
                    7,
                ),
                node(2, "processor", "gain", vec![2], vec![2], 0, 7, 7),
                node(3, "output", "physical-output", vec![2], vec![], 0, 0, 0),
            ],
            connections: vec![edge(u64::MAX, 2, 7, 0), edge(2, 3, 9, 2)],
        };
        json!({"graphGeneration":3,"graphNodeCount":3,"graphConnectionCount":2,
            "graphLatencyFrames":9,"latencyCompensatedEdgeCount":1,"graphSnapshot":graph})
    }
    #[test]
    fn lossless_actual_topology_and_compensation() {
        let parsed = parse_status(&status()).unwrap().unwrap();
        assert_eq!(parsed.nodes[0].id, u64::MAX);
        assert_eq!(parsed.nodes[0].type_high, u64::MAX);
        assert_eq!(parsed.connections[1].compensation_frames, 2);
        assert_eq!(
            serde_json::to_value(&parsed).unwrap(),
            status()["graphSnapshot"]
        );
    }
    #[test]
    fn absent_metadata_is_not_a_reconstructed_graph() {
        assert!(
            parse_status(&json!({"graphGeneration":8,"graphNodeCount":30}))
                .unwrap()
                .is_none()
        );
        assert!(
            parse_status(&json!({"graphSnapshot":null}))
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn stale_or_inconsistent_snapshot_is_rejected() {
        for (key, value) in [
            ("graphGeneration", json!(4)),
            ("graphNodeCount", json!(4)),
            ("graphConnectionCount", json!(3)),
            ("graphLatencyFrames", json!(10)),
            ("latencyCompensatedEdgeCount", json!(0)),
        ] {
            let mut s = status();
            s[key] = value;
            assert!(parse_status(&s).is_err(), "{key}");
        }
    }
    #[test]
    fn malformed_nodes_and_edges_are_rejected() {
        for (pointer, value) in [
            ("/graphSnapshot/nodes/1/id", json!("18446744073709551615")),
            ("/graphSnapshot/nodes/1/id", json!("02")),
            ("/graphSnapshot/nodes/1/id", json!("0")),
            ("/graphSnapshot/nodes/1/kind", json!("invented")),
            ("/graphSnapshot/nodes/1/role", json!("invented")),
            ("/graphSnapshot/nodes/1/inputBusCount", json!(17)),
            ("/graphSnapshot/nodes/1/inputBusChannels", json!([0])),
            ("/graphSnapshot/nodes/1/outputLatencyFrames", json!(8)),
            ("/graphSnapshot/connections/1/sourceNodeId", json!("55")),
            ("/graphSnapshot/connections/1/destinationNodeId", json!("2")),
            ("/graphSnapshot/connections/1/sourceBus", json!(1)),
            ("/graphSnapshot/connections/1/sourceChannels", json!(1)),
            ("/graphSnapshot/connections/1/compensationFrames", json!(0)),
            (
                "/graphSnapshot/connections/1/latencyCompensated",
                json!(false),
            ),
            (
                "/graphSnapshot/connections/1/destinationArrivalLatencyFrames",
                json!(8),
            ),
        ] {
            let mut s = status();
            *s.pointer_mut(pointer).unwrap() = value;
            assert!(parse_status(&s).is_err(), "{pointer}");
        }
    }
    #[test]
    fn bound_format_and_counter_failures_are_rejected() {
        for (pointer, value) in [
            ("/graphSnapshot/generation", json!("18446744073709551616")),
            ("/graphSnapshot/formatVersion", json!(0)),
            ("/graphSnapshot/sampleRate", json!(0)),
            ("/graphSnapshot/maximumFrames", json!(0)),
            ("/graphSnapshot/nodes/0/label", json!("x".repeat(257))),
            (
                "/graphSnapshot/nodes/0/intrinsicLatencyFrames",
                json!(4294967296_u64),
            ),
        ] {
            let mut s = status();
            *s.pointer_mut(pointer).unwrap() = value;
            assert!(parse_status(&s).is_err(), "{pointer}");
        }
        let mut s = status();
        s["graphSnapshot"]["nodes"] =
            json!(vec![s["graphSnapshot"]["nodes"][0].clone(); MAX_NODES + 1]);
        assert!(parse_status(&s).is_err());
    }
}
