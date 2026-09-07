import Foundation

enum DurablePreferenceWriteError: LocalizedError {
  case flushFailed

  var errorDescription: String? {
    "The preference could not be flushed to durable storage."
  }
}

/** Pure boundary kept outside the React bridge so false-result handling can
 * be tested without a simulator or CocoaPods. */
enum DurablePreferenceWrite {
  static func requireFlushed(_ flushed: Bool) throws {
    if !flushed { throw DurablePreferenceWriteError.flushFailed }
  }
}
