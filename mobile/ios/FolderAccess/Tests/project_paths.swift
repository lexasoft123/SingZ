import Foundation

/**
 * The Swift end of the shared name/path table
 * (tests/shared/project-name-cases.json). Kotlin (ProjectPathsTest) and
 * vitest (project-name-rules.test.ts — the reference writer and the desktop
 * itself) run the same rows, so a song added on an iPhone cannot get a folder
 * named differently than everywhere else — the difference that hid every
 * song whose title began with a dot.
 *
 * A plain executable rather than an XCTest target, like Tests/main.swift:
 * ProjectPaths imports nothing but Foundation, so swiftc runs it in a second.
 *
 *   mobile/scripts/test-swift-project-paths.sh
 */

struct NameRow: Decodable {
  let `in`: String
  let out: String
}
struct VerdictRow: Decodable {
  let `in`: String
  let ok: Bool
}
struct Table: Decodable {
  let safeName: [NameRow]
  let relOk: [VerdictRow]
  let plainChild: [VerdictRow]
}

@main
struct ProjectPathsTest {
  static func main() throws {
    var failures: [String] = []
    var checks = 0
    func check(_ condition: Bool, _ what: String) {
      checks += 1
      if condition {
        print("  ok   \(what)")
      } else {
        print(" FAIL  \(what)")
        failures.append(what)
      }
    }

    // the table lives at the repo root; walk up from this file to find it
    var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    var casesURL: URL?
    for _ in 0..<8 {
      let candidate = dir.appendingPathComponent("tests/shared/project-name-cases.json")
      if FileManager.default.fileExists(atPath: candidate.path) {
        casesURL = candidate
        break
      }
      dir = dir.deletingLastPathComponent()
    }
    guard let casesURL else {
      print("project-name-cases.json not found above \(#filePath)")
      exit(2)
    }

    let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: casesURL))
    guard !table.safeName.isEmpty, !table.relOk.isEmpty, !table.plainChild.isEmpty else {
      print("a section of the table is empty")
      exit(2)
    }
    for row in table.safeName {
      let got = ProjectPaths.safeName(row.in)
      check(got == row.out, "safeName \(debug(row.in)) → \(debug(row.out)) (got \(debug(got)))")
    }
    for row in table.relOk {
      check(ProjectPaths.relOk(row.in) == row.ok, "relOk \(debug(row.in)) is \(row.ok)")
    }
    for row in table.plainChild {
      check(ProjectPaths.plainChild(row.in) == row.ok, "plainChild \(debug(row.in)) is \(row.ok)")
    }

    print(failures.isEmpty ? "\nSwift: \(checks) checks passed" : "\n\(failures.count) FAILED")
    exit(failures.isEmpty ? 0 : 1)
  }

  /** Quoted with every whitespace but the plain space spelled out — a tab or
   *  a no-break space in a row must read as one in a failure, and
   *  String(reflecting:) prints a no-break space as it is. */
  static func debug(_ s: String) -> String {
    var out = "\""
    for u in s.unicodeScalars {
      if u == "\"" || u == "\\" {
        out += "\\\(u)"
      } else if u != " " && (u.properties.isWhitespace || u.value < 0x20) {
        out += "\\u{\(String(u.value, radix: 16))}"
      } else {
        out.unicodeScalars.append(u)
      }
    }
    return out + "\""
  }
}
