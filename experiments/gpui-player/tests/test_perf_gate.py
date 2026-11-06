import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('interface_perf',Path(__file__).with_name('interface-perf.py'))
perf=importlib.util.module_from_spec(spec);spec.loader.exec_module(perf)

class GateTests(unittest.TestCase):
    def test_apple_silicon_cpu_timebase(self):
        self.assertEqual(perf.ticks_to_ns(24000000,125,3),1000000000)
    def frames(self, fps=120, interval=10):
        return [dict(draw_fps=fps,frame_interval_p95_ms=interval,window_ms=1500) for _ in range(3)]
    def resources(self):
        return [dict(process_cpu_percent=12,gpu_system={'available':False,'reason':'no counter'}) for _ in range(3)]
    def test_healthy_run_can_report_gpu_unavailable(self):
        self.assertEqual(perf.evaluate(self.frames(),self.resources(),50,40,None),[])
    def test_regression_is_refused(self):
        self.assertTrue(perf.evaluate(self.frames(20,150),self.resources(),50,40,None))
    def test_missing_measurements_cannot_pass(self):
        self.assertTrue(perf.evaluate([],[],50,40,None))
    def test_optional_cpu_budget(self):
        self.assertTrue(perf.evaluate(self.frames(),self.resources(),50,40,10))
    def test_nan_is_not_a_pass(self):
        self.assertTrue(perf.evaluate(self.frames(float('nan')),self.resources(),50,40,None))

if __name__=='__main__':unittest.main()
