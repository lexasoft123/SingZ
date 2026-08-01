import Foundation

/**
 * The Swift end of the shared conformance table
 * (tests/shared/currency-cases.json). TypeScript (vitest) and Kotlin (JUnit)
 * run the same rows, so "is the copy we have the file we want?" cannot mean
 * three different things on three platforms — which is exactly how a downloaded
 * song ended up re-downloading itself.
 *
 * A plain executable rather than an XCTest target on purpose: CacheCurrency
 * imports nothing but Foundation, so this compiles and runs in a second with
 * swiftc, needs no simulator, no Pods and no surgery on the Xcode project.
 *
 *   mobile/scripts/test-swift-currency.sh
 */

struct Facts: Decodable {
  let size: Int64
  let md5: String?
}
struct Row: Decodable {
  let name: String
  let have: Facts
  let want: Facts
  let expect: Bool
}
struct Table: Decodable {
  let isCurrent: [Row]
}

var failures: [String] = []

func check(_ condition: Bool, _ what: String) {
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
  let candidate = dir.appendingPathComponent("tests/shared/currency-cases.json")
  if FileManager.default.fileExists(atPath: candidate.path) {
    casesURL = candidate
    break
  }
  dir = dir.deletingLastPathComponent()
}
guard let casesURL else {
  print("currency-cases.json not found above \(#filePath)")
  exit(2)
}

let table = try JSONDecoder().decode(Table.self, from: Data(contentsOf: casesURL))
guard !table.isCurrent.isEmpty else {
  print("the table is empty")
  exit(2)
}
for row in table.isCurrent {
  let got = CacheCurrency.isCurrent(
    haveSize: row.have.size,
    wantSize: row.want.size,
    wantMd5: row.want.md5 ?? ""
  ) { row.have.md5 }
  check(got == row.expect, row.name)
}

// hashing is the expensive half: it must happen last, and only when needed
var hashed = 0
let hash: () -> String? = {
  hashed += 1
  return "aaa"
}
_ = CacheCurrency.isCurrent(haveSize: 60, wantSize: 100, wantMd5: "aaa", md5: hash)
_ = CacheCurrency.isCurrent(haveSize: -1, wantSize: 100, wantMd5: "aaa", md5: hash)
check(hashed == 0, "no hashing when the size already settles it")
_ = CacheCurrency.isCurrent(haveSize: 100, wantSize: 100, wantMd5: "aaa", md5: hash)
check(hashed == 1, "hashes once when the size agrees and an md5 was stated")

print(failures.isEmpty ? "\nSwift: \(table.isCurrent.count + 2) checks passed" : "\n\(failures.count) FAILED")
exit(failures.isEmpty ? 0 : 1)
