from proxy.capture_store import CaptureStore


def test_record_writes_numbered_file_per_capture(tmp_path):
    store = CaptureStore(captures_dir=tmp_path)

    store.record("first prompt")
    store.record("second prompt")

    written = sorted(tmp_path.glob("system_prompt_*.txt"))
    assert len(written) == 2
    assert written[0].name.startswith("system_prompt_001_")
    assert written[1].name.startswith("system_prompt_002_")
    assert written[0].read_text() == "first prompt"
    assert written[1].read_text() == "second prompt"


def test_record_ignores_empty_prompt(tmp_path):
    store = CaptureStore(captures_dir=tmp_path)

    store.record("")

    assert store.count == 0
    assert list(tmp_path.glob("*.txt")) == []


def test_count_reflects_number_of_records(tmp_path):
    store = CaptureStore(captures_dir=tmp_path)
    assert store.count == 0

    store.record("a")
    store.record("b")

    assert store.count == 2


def test_captures_dir_is_created_if_missing(tmp_path):
    target = tmp_path / "nested" / "captures"
    assert not target.exists()

    CaptureStore(captures_dir=target)

    assert target.exists()
