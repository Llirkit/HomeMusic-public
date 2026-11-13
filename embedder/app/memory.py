"""Best-effort release of unused native heap pages after a model is unloaded."""

import ctypes
import os
from pathlib import Path


def resident_bytes() -> int | None:
    try:
        return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")
    except (OSError, ValueError, IndexError, AttributeError):
        return None


def trim_allocator() -> bool:
    """glibc's arenas retain freed PyTorch/NumPy buffers; return whole free pages, not live allocations.

    Other platforms/allocators can omit malloc_trim. Garbage collection still works there.
    """
    try:
        trim = ctypes.CDLL(None).malloc_trim
        trim.argtypes = [ctypes.c_size_t]
        trim.restype = ctypes.c_int
        return bool(trim(0))
    except (OSError, AttributeError):
        return False
