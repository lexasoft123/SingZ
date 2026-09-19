/** UVR and its developers, MIT. Full attribution: docs/licenses/UVR-MDX-Karaoke-2.txt. */
export const VOCAL_MODEL_FILE = 'UVR_MDXNET_KARA_2.onnx'
export const VOCAL_MODEL_BYTES = 52_786_726
export const VOCAL_MODEL_SHA256 = 'bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4'
export const VOCAL_MODEL_URL = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${VOCAL_MODEL_FILE}`
// The model ships INSIDE the splitter pack (format 5 / 9), because backing
// vocals are part of every split — it is never downloaded by the app. This
// file stays the one written-down identity: scripts/build-gpu-pack.sh and
// scripts/build-onnx-pack.sh fetch that URL and assert that sha, and
// scripts/vocal_split_runner.py checks it again before inference.
