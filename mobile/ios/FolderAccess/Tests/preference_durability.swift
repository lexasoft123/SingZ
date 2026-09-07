import Foundation

@main
struct PreferenceDurabilityTest {
  static func main() {
    var failures: [String] = []

    do {
      try DurablePreferenceWrite.requireFlushed(true)
      print("  ok   successful flush returns")
    } catch {
      failures.append("successful flush threw: \(error)")
    }

    do {
      try DurablePreferenceWrite.requireFlushed(false)
      failures.append("failed flush returned success")
    } catch DurablePreferenceWriteError.flushFailed {
      print("  ok   failed flush is propagated")
    } catch {
      failures.append("failed flush returned the wrong error: \(error)")
    }

    print(
      failures.isEmpty
        ? "\nSwift preference durability: 2 checks passed"
        : "\n\(failures.count) FAILED")
    for failure in failures { print(" FAIL  \(failure)") }
    exit(failures.isEmpty ? 0 : 1)
  }
}
