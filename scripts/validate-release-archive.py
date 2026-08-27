#!/usr/bin/env python3
from __future__ import annotations

import gzip
import os
import re
import stat
import sys
import tarfile
from typing import BinaryIO
BLOCK_SIZE, MAX_EXTENSION_BYTES, MAX_PATH_BYTES = 512, 1024 * 1024, 512
MAX_COMPRESSED_BYTES, MAX_DECOMPRESSED_BYTES = 128 * 1024**2, 384 * 1024**2
MAX_MEMBER_BYTES, MAX_TOTAL_MEMBER_BYTES, MAX_MEMBERS = 160 * 1024**2, 320 * 1024**2, 10_000
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")
class UnsafeArchive(Exception): pass
def _reject() -> None:
    raise UnsafeArchive()
class _BoundedReader:
    def __init__(self, source: BinaryIO) -> None:
        self._source = source
        self._count = 0
    def read(self, size: int = -1) -> bytes:
        remaining_plus_one = MAX_DECOMPRESSED_BYTES - self._count + 1
        if size < 0 or size > remaining_plus_one:
            size = remaining_plus_one
        data = self._source.read(size)
        self._count += len(data)
        if self._count > MAX_DECOMPRESSED_BYTES:
            _reject()
        return data

class _RecordingReader:
    def __init__(self, source: BinaryIO, limit: int, payload_size: int, validator) -> None:
        self._source = source
        self._remaining = limit
        self._payload_size = payload_size
        self._validator = validator
        self.validated = False
        self.payload = bytearray()
    def read(self, size: int = -1) -> bytes:
        data = self._source.read(size)
        if self._remaining:
            captured = data[: self._remaining]
            self.payload.extend(captured)
            self._remaining -= len(captured)
        if not self.validated and len(self.payload) >= self._payload_size:
            self._validator(bytes(self.payload[: self._payload_size]))
            self.validated = True
        return data
    def tell(self) -> int:
        return self._source.tell()

def _strict_gnu_extension(payload: bytes) -> None:
    if not payload or payload[-1] != 0 or b"\0" in payload[:-1]:
        _reject()

def _strict_pax_extension(payload: bytes) -> None:
    if not payload or b"\0" in payload:
        _reject()
    position = 0
    while position < len(payload):
        separator = payload.find(b" ", position)
        length_text = payload[position:separator]
        if separator <= position or not length_text.isdigit() or length_text.startswith(b"0"):
            _reject()
        length = int(length_text)
        end = position + length
        if end > len(payload) or end <= separator + 3 or payload[end - 1] != 0x0A:
            _reject()
        record = payload[separator + 1 : end - 1]
        equals = record.find(b"=")
        keyword = record[:equals]
        value = record[equals + 1 :]
        if equals <= 0 or any(byte <= 0x20 or byte == 0x7F for byte in keyword):
            _reject()
        if keyword.lower().startswith(b"gnu.sparse"):
            _reject()
        if keyword in (b"size", b"uid", b"gid"):
            if len(value) > 32 or re.fullmatch(rb"0|[1-9][0-9]*", value) is None:
                _reject()
            maximum = MAX_MEMBER_BYTES if keyword == b"size" else 2**31 - 1
            if int(value) > maximum:
                _reject()
        elif keyword in (b"atime", b"ctime", b"mtime"):
            if len(value) > 64 or re.fullmatch(rb"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", value) is None:
                _reject()
        if str(length).encode("ascii") != length_text:
            _reject()
        position = end

class _BoundedTarInfo(tarfile.TarInfo):
    @classmethod
    def frombuf(cls, buffer: bytes, encoding: str, errors: str) -> tarfile.TarInfo:
        member = super().frombuf(buffer, encoding, errors)
        if member.type == tarfile.GNUTYPE_SPARSE:
            _reject()
        extension_types = {
            tarfile.GNUTYPE_LONGNAME,
            tarfile.GNUTYPE_LONGLINK,
            tarfile.XHDTYPE,
            tarfile.XGLTYPE,
            tarfile.SOLARIS_XHDTYPE,
        }
        limit = MAX_EXTENSION_BYTES if member.type in extension_types else MAX_MEMBER_BYTES
        if member.size < 0 or member.size > limit:
            _reject()
        return member
    def _validated_extension(self, archive, processor, validator):
        original = archive.fileobj
        recording = _RecordingReader(original, self._block(self.size), self.size, validator)
        archive.fileobj = recording
        try:
            following = processor(archive)
        finally:
            archive.fileobj = original
        if not recording.validated:
            _reject()
        return following
    def _proc_gnulong(self, archive):
        return self._validated_extension(archive, super()._proc_gnulong, _strict_gnu_extension)
    def _proc_pax(self, archive):
        return self._validated_extension(archive, super()._proc_pax, _strict_pax_extension)

def _checked_components(value: str) -> list[str]:
    try:
        encoded = value.encode("utf-8", "strict")
    except UnicodeError:
        _reject()
    if not value or len(encoded) > MAX_PATH_BYTES:
        _reject()
    if value.startswith("/") or "\\" in value:
        _reject()
    if any(ord(character) < 32 or ord(character) == 127 for character in value):
        _reject()
    components: list[str] = []
    for component in value.split("/"):
        if component in ("", "."):
            continue
        if _DRIVE_PREFIX.match(component):
            _reject()
        components.append(component)
    return components

def _member_path(value: str, strip: int) -> tuple[str, ...]:
    components = _checked_components(value)
    if ".." in components:
        _reject()
    if len(components) < strip:
        _reject()
    return tuple(components[strip:])

def _link_target(base: tuple[str, ...], value: str) -> tuple[str, ...]:
    resolved = list(base)
    for component in _checked_components(value):
        if component == "..":
            if not resolved:
                _reject()
            resolved.pop()
        else:
            resolved.append(component)
    if not resolved:
        _reject()
    return tuple(resolved)

def _member_kind(member: tarfile.TarInfo) -> str:
    if getattr(member, "sparse", None) is not None:
        _reject()
    if member.type in (tarfile.REGTYPE, tarfile.AREGTYPE):
        return "file"
    if member.type == tarfile.DIRTYPE:
        return "dir"
    if member.type == tarfile.SYMTYPE:
        return "symlink"
    if member.type == tarfile.LNKTYPE:
        return "hardlink"
    _reject()
    raise AssertionError("unreachable")

def _register_member(
    member: tarfile.TarInfo,
    entries: dict[tuple[str, ...], str],
    required_directories: set[tuple[str, ...]],
    strip: int,
) -> None:
    member_path = _member_path(member.name, strip)
    kind = _member_kind(member)
    if not member_path and kind != "dir":
        _reject()
    if member_path in entries:
        _reject()
    for index in range(1, len(member_path)):
        ancestor_kind = entries.get(member_path[:index])
        if ancestor_kind is not None and ancestor_kind != "dir":
            _reject()
    if kind != "dir" and member_path in required_directories:
        _reject()
    if kind == "symlink":
        _link_target(member_path[:-1], member.linkname)
    elif kind == "hardlink":
        target = _member_path(member.linkname, strip)
        if entries.get(target) != "file":
            _reject()
    if kind != "file" and member.size != 0:
        _reject()
    entries[member_path] = kind
    required_directories.update(member_path[:index] for index in range(1, len(member_path)))

def _inspect_members(file_descriptor: int, strip: int) -> int:
    os.lseek(file_descriptor, 0, os.SEEK_SET)
    entries, required_directories = {}, set()
    member_count = 0
    total_member_bytes = 0
    logical_end = 0
    with os.fdopen(os.dup(file_descriptor), "rb") as compressed:
        with gzip.GzipFile(fileobj=compressed, mode="rb") as expanded:
            bounded = _BoundedReader(expanded)
            with tarfile.open(
                fileobj=bounded,
                mode="r|",
                encoding="utf-8",
                errors="strict",
                tarinfo=_BoundedTarInfo,
            ) as archive:
                for member in archive:
                    member_count += 1
                    if member_count > MAX_MEMBERS:
                        _reject()
                    if member.size < 0 or member.size > MAX_MEMBER_BYTES:
                        _reject()
                    total_member_bytes += member.size
                    if total_member_bytes > MAX_TOTAL_MEMBER_BYTES:
                        _reject()
                    if any(key.lower().startswith("gnu.sparse") for key in member.pax_headers):
                        _reject()
                    _register_member(member, entries, required_directories, strip)
                    padded_size = ((member.size + BLOCK_SIZE - 1) // BLOCK_SIZE) * BLOCK_SIZE
                    logical_end = max(logical_end, member.offset_data + padded_size)
    return logical_end

def _verify_stream(file_descriptor: int, logical_end: int) -> None:
    if logical_end < 0 or logical_end % BLOCK_SIZE != 0:
        _reject()
    os.lseek(file_descriptor, 0, os.SEEK_SET)
    total = 0
    marker = bytearray()
    trailing_nonzero = False
    with os.fdopen(os.dup(file_descriptor), "rb") as compressed:
        with gzip.GzipFile(fileobj=compressed, mode="rb") as expanded:
            while True:
                chunk = expanded.read(64 * 1024)
                if not chunk:
                    break
                previous = total
                total += len(chunk)
                if total > MAX_DECOMPRESSED_BYTES:
                    _reject()
                start = max(0, logical_end - previous)
                if start >= len(chunk):
                    continue
                tail = chunk[start:]
                needed = 2 * BLOCK_SIZE - len(marker)
                marker.extend(tail[:needed])
                if any(tail[needed:]):
                    trailing_nonzero = True
    if total < logical_end + 2 * BLOCK_SIZE:
        _reject()
    if len(marker) != 2 * BLOCK_SIZE or any(marker) or trailing_nonzero:
        _reject()

def validate_release_archive(archive_path: str, strip: int = 0) -> None:
    if sys.version_info[:2] != (3, 11): _reject()
    if strip not in (0, 1): _reject()
    if os.path.islink(archive_path):
        _reject()
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    file_descriptor = os.open(archive_path, flags)
    try:
        metadata = os.fstat(file_descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            _reject()
        if metadata.st_size <= 0 or metadata.st_size > MAX_COMPRESSED_BYTES:
            _reject()
        logical_end = _inspect_members(file_descriptor, strip)
        _verify_stream(file_descriptor, logical_end)
    finally:
        os.close(file_descriptor)

def main(arguments: list[str]) -> int:
    try:
        if len(arguments) != 2 or arguments[1] not in ("0", "1"):
            _reject()
        validate_release_archive(arguments[0], int(arguments[1]))
    except Exception:
        sys.stderr.buffer.write(b"Release archive validation failed.\n")
        return 1
    sys.stdout.buffer.write(b"Release archive is safe.\n")
    return 0

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
