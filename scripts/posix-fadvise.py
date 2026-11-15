#!/usr/bin/env python3
"""Release clean page-cache pages for explicitly named regular files."""

import json
import os
import stat
import sys


def main():
    paths = json.load(sys.stdin)
    if not isinstance(paths, list) or not hasattr(os, "posix_fadvise"):
        print(json.dumps({"supported": False, "advised": 0}))
        return
    advised = 0
    for value in paths:
        if not isinstance(value, str) or not os.path.isabs(value):
            continue
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(value, flags)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    continue
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                advised += 1
            finally:
                os.close(fd)
        except (FileNotFoundError, PermissionError, OSError):
            continue
    print(json.dumps({"supported": True, "advised": advised}))


if __name__ == "__main__":
    main()
