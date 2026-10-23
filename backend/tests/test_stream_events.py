"""Stream durability regressions; execute only when explicitly requested."""

from app import runs


def test_stream_coalescing_preserves_order_and_flushes_tail_before_status(monkeypatch):
    written = []
    now = [10.0]
    monkeypatch.setattr(runs, "emit", lambda run_id, kind, data: written.append((kind, dict(data))))
    monkeypatch.setattr(runs.time, "monotonic", lambda: now[0])
    stream = runs.StreamEmitter("run")
    stream.emit("delta", {"text": "甲"})
    now[0] += 0.01
    stream.emit("delta", {"text": "乙"})
    stream.emit("delta", {"text": "丙"})
    stream.emit("reasoning", {"text": "原", "step": "one"})
    stream.emit("reasoning", {"text": "因", "step": "one"})
    stream.emit("status", {"status": "completed"})
    stream.flush()
    assert written == [("delta", {"text": "甲"}), ("delta", {"text": "乙丙"}),
                       ("reasoning", {"text": "原因", "step": "one"}), ("status", {"status": "completed"})]
