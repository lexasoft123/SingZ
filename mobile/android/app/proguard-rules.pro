# JNI registers SingzCore by its binary name and resolves callback methods and
# graph fields by name. Retain only that bridge; dependencies supply their own
# consumer rules for React Native, Hermes, Skia, audio-api and ONNX Runtime.
-keep class com.singzplayer.split.SingzCore { *; }
-keep interface com.singzplayer.split.SingzCore$SplitListener { *; }
-keep interface com.singzplayer.split.SingzCore$AudioInputListener { *; }
-keepclassmembers class * implements com.singzplayer.split.SingzCore$SplitListener {
    public void onStage(java.lang.String, float);
    public void onChunk(long, long);
}
-keepclassmembers class * implements com.singzplayer.split.SingzCore$AudioInputListener {
    public void onFrame(...);
}
-keep class com.singzplayer.playback.NativePlaybackGraphNodeJni { *; }
-keep class com.singzplayer.playback.NativePlaybackGraphConnectionJni { *; }
