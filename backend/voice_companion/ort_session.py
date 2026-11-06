"""CPU session construction with bounded allocator reuse and sleeping workers.

FunASR 0.4.8 does not expose SessionOptions. Override its constructor alias only
while creating a model under a lock; installed packages and existing sessions
are never rewritten. All inference uses the ordinary upstream wrapper methods.
"""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from importlib import import_module
from threading import RLock


_policy = ContextVar("voice_ort_policy", default=(False, True))
_construction_lock = RLock()


@contextmanager
def session_policy(spin: bool, arena: bool):
    """Profiling-only override; production uses no-spin plus CPU memory arena."""
    token = _policy.set((spin, arena))
    try:
        yield
    finally:
        _policy.reset(token)


def build_cpu_model(module_name: str, constructor: str, *args, **kwargs):
    module = import_module(module_name)
    with _construction_lock:
        original = module.OrtInferSession
        spin, arena = _policy.get()

        class CpuSession(original):
            def __init__(self, model_file, device_id=-1, intra_op_num_threads=1):
                import onnxruntime as ort
                if str(device_id) != "-1":
                    raise ValueError("This runtime intentionally uses the CPU provider")
                self._verify_model(model_file)
                options = ort.SessionOptions()
                options.intra_op_num_threads = max(1, intra_op_num_threads)
                options.inter_op_num_threads = 1
                options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
                options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                options.log_severity_level = 4
                options.enable_cpu_mem_arena = arena
                options.add_session_config_entry("session.intra_op.allow_spinning", "1" if spin else "0")
                options.add_session_config_entry("session.inter_op.allow_spinning", "1" if spin else "0")
                self.session = ort.InferenceSession(str(model_file), sess_options=options,
                    providers=[("CPUExecutionProvider", {"arena_extend_strategy": "kSameAsRequested"})])
                self._inputs = [value.name for value in self.session.get_inputs()]
                self._outputs = [value.name for value in self.session.get_outputs()]

            def get_input_names(self):
                return self._inputs

            def get_output_names(self):
                return self._outputs

        module.OrtInferSession = CpuSession
        try:
            return getattr(module, constructor)(*args, **kwargs)
        finally:
            module.OrtInferSession = original
