"""BabelDOC 0.6.4 CLI adapter that mirrors its real progress events to JSON.

The observer preserves the upstream CLI, progress handler, configuration and PDF
translation pipeline. Only its existing progress notifications are intercepted.
"""
import argparse
import json
import multiprocessing
from pathlib import Path
import sys
import threading
import time

from worker import atomic_json


def progress_snapshot(event):
    if event.get("type") not in {"progress_start", "progress_update", "progress_end"}:
        return None
    return {key: event[key] for key in ("type", "stage", "stage_current", "stage_total",
            "overall_progress", "part_index", "total_parts") if key in event}


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--progress-file", required=True, type=Path)
    options, remaining = parser.parse_known_args()
    import babeldoc.main as upstream
    original = upstream.create_progress_handler
    lock = threading.Lock()

    def observed_handler(*args, **kwargs):
        context, handler = original(*args, **kwargs)
        def update(event):
            snapshot = progress_snapshot(event)
            if snapshot is not None:
                snapshot["updatedAt"] = time.time()
                with lock:
                    atomic_json(options.progress_file, snapshot)
            handler(event)
        return context, update

    upstream.create_progress_handler = observed_handler
    sys.argv = ["babeldoc"] + remaining
    upstream.cli()


if __name__ == "__main__":
    if sys.platform == "win32":
        multiprocessing.set_start_method("spawn")
    main()
