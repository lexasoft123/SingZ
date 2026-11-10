const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '../..')

function prepareSignature() {
  const kotlin = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/singzplayer/split/SingzCore.kt'), 'utf8')
  const cpp = fs.readFileSync(path.join(root, 'mobile/native/bindings/android/native_playback_jni.cpp'), 'utf8')
  const method = /external fun nativePlaybackPrepare\s*\(([\s\S]*?)\)\s*:\s*String/.exec(kotlin)
  assert.ok(method, 'the actual Kotlin native method must exist')
  const descriptors = {
    Long: ['J', 'jlong'], Int: ['I', 'jint'], Boolean: ['Z', 'jboolean'],
    Float: ['F', 'jfloat'], Double: ['D', 'jdouble'], String: ['Ljava/lang/String;', 'jstring'],
    LongArray: ['[J', 'jlongArray'], IntArray: ['[I', 'jintArray'], BooleanArray: ['[Z', 'jbooleanArray'],
    FloatArray: ['[F', 'jfloatArray'], DoubleArray: ['[D', 'jdoubleArray'],
    'Array<String>': ['[Ljava/lang/String;', 'jobjectArray'],
    'Array<NativePlaybackGraphNodeJni>': ['[Lcom/singzplayer/playback/NativePlaybackGraphNodeJni;', 'jobjectArray'],
    'Array<NativePlaybackGraphConnectionJni>': ['[Lcom/singzplayer/playback/NativePlaybackGraphConnectionJni;', 'jobjectArray']
  }
  const types = method[1].split(',').map(parameter => parameter.trim()).filter(Boolean).map(parameter => {
    const type = parameter.slice(parameter.indexOf(':') + 1).trim()
    assert.ok(descriptors[type], `unmapped Kotlin JNI type: ${type}`)
    return descriptors[type]
  })
  const start = cpp.indexOf('"nativePlaybackPrepare"')
  assert.ok(start >= 0, 'the actual JNI registration must exist')
  const entry = cpp.slice(start, cpp.indexOf('reinterpret_cast', start))
  const registered = [...entry.matchAll(/"([^"]*)"/g)].slice(1).map(match => match[1]).join('')
  const declaration = /static jstring nativePlaybackPrepare\s*\(([\s\S]*?)\)\s*\{/.exec(cpp)
  assert.ok(declaration, 'the actual C++ implementation must exist')
  const nativeTypes = declaration[1].split(',').slice(2).map(parameter => parameter.trim().split(/\s+/)[0])
  assert.deepEqual(nativeTypes, types.map(type => type[1]), 'C++ argument order must match Kotlin')
  return { expected: `(${types.map(type => type[0]).join('')})Ljava/lang/String;`, registered }
}

test('the real Android prepare declaration, registration, and native parameters agree', () => {
  const { expected, registered } = prepareSignature()
  assert.equal(registered, expected)
})

test('the checker rejects omitting the waveform policy/version transport', () => {
  const { expected, registered } = prepareSignature()
  const missingPolicy = registered.replace('ILjava/lang/String;[Ljava/lang/String;[I[D', '[Ljava/lang/String;[I[D')
  assert.notEqual(missingPolicy, registered, 'negative control must alter the real signature')
  assert.throws(() => assert.equal(missingPolicy, expected))
})
