// Bundle the app-owned runner independently of the installed Python/model pack.
// separation.ts writes it beside each split input before launching pack Python.
export { default as ONNX_RUNNER_PY } from '../../scripts/onnx_runner.py?raw'
