"""Concurrent requests for the same uncached thumbnail must both succeed."""

import threading

import cat.api.thumbnails as thumbs


def test_concurrent_renders_of_the_same_source_do_not_collide(tmp_path, monkeypatch):
    target = tmp_path / "abc.png"
    monkeypatch.setattr(thumbs, "_cache_path", lambda url, size: target)
    monkeypatch.setattr(thumbs, "_evict_if_over_budget", lambda: None)

    # Identical PNG bytes for every caller, like two real requests for one COG.
    gate = threading.Barrier(8)

    def fake_render(url, size):
        gate.wait(timeout=5)  # force every thread to reach the write together
        return b"\x89PNG\r\n\x1a\n" + b"x" * 200

    monkeypatch.setattr(thumbs, "_render_png", fake_render)

    errors = []

    def worker():
        try:
            assert thumbs.render_cached_thumbnail("gs://b/x.tif", 76, refresh=True) == target
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    [t.start() for t in threads]
    [t.join(timeout=10) for t in threads]

    assert not errors, errors
    assert target.read_bytes().startswith(b"\x89PNG")
    assert not list(tmp_path.glob("*.tmp")), "temp files were left behind"
