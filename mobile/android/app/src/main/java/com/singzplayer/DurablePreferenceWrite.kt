package com.singzplayer

/** Pure result boundary for SharedPreferences.Editor.commit(). */
object DurablePreferenceWrite {
  fun requireCommitted(committed: Boolean) {
    check(committed) { "The preference could not be committed to durable storage." }
  }
}
