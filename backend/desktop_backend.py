"""Standalone local backend entry point used by the Windows desktop bundle."""

import argparse
import multiprocessing
import os
from pathlib import Path
import sys


def main():
    if "--office-worker" in sys.argv:
        from app.office_worker import main as office_main
        office_main()
        return
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--no-access-log", action="store_true")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    if "BAI_DATA_DIR" not in os.environ and getattr(sys, "frozen", False):
        local = Path(os.environ["LOCALAPPDATA"])
        current = local / "XiaoXi_Agent"
        legacy = local / "com.qinbai.baiagent"
        if not current.exists() and legacy.exists():
            try:
                legacy.rename(current)
            except OSError:
                current = legacy
        os.environ["BAI_DATA_DIR"] = str(current)
    import uvicorn
    from app.main import app

    uvicorn.run(app, host=args.host, port=args.port, access_log=False, log_level="info")


if __name__ == "__main__":
    multiprocessing.freeze_support()
    main()
