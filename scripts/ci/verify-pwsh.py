#!/usr/bin/env python3
"""Check a PATH-provided PowerShell adapter through a real interactive PTY."""

import errno
import fcntl
import os
import pty
import select
import signal
import sys
import struct
import termios
import time
import uuid


class Probe:
    def __init__(self):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            try:
                os.environ.update(TERM="dumb", NO_COLOR="1")
                fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 160, 0, 0))
                os.execvp("pwsh", ["pwsh", "-NoLogo", "-NoProfile"])
            except OSError as error:
                print(f"Cannot start pwsh: {error}", file=sys.stderr, flush=True)
                os._exit(127)
        self.status = None
        self.output = b""

    def poll(self):
        if self.status is None:
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                self.status = status
        return self.status

    def read(self, timeout):
        if select.select([self.fd], [], [], timeout)[0]:
            try:
                chunk = os.read(self.fd, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""  # Linux reports PTY hangup as EIO.
            self.output = (self.output + chunk)[-1048576:]

    def send(self, line):
        data = (line + "\r").encode("utf-8")
        while data:
            data = data[os.write(self.fd, data):]

    def expect(self, marker, timeout=10):
        expected = marker.encode("utf-8")
        deadline = time.monotonic() + timeout
        while expected not in self.output:
            if self.poll() is not None:
                self.read(0)
                if expected in self.output:
                    return
                raise RuntimeError(f"pwsh exited before {marker}")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError(f"timeout waiting for {marker}")
            self.read(min(0.1, remaining))

    def expect_waiting(self, completion, duration=0.3):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            self.read(min(0.05, max(0, deadline - time.monotonic())))
            if completion.encode("utf-8") in self.output:
                raise RuntimeError("Read-Host completed before input was sent")
            if self.poll() is not None:
                raise RuntimeError("pwsh exited while Read-Host awaited input")

    def expect_exit(self, expected, timeout=10):
        deadline = time.monotonic() + timeout
        while self.poll() is None:
            if time.monotonic() >= deadline:
                raise RuntimeError("timeout waiting for pwsh to exit")
            self.read(0.05)
        actual = os.waitstatus_to_exitcode(self.status)
        if actual != expected:
            raise RuntimeError(f"pwsh exit code: expected {expected}, got {actual}")

    def close(self):
        try:
            if self.poll() is None:
                # pty.fork() owns this new session; never signal the caller's group.
                os.killpg(self.pid, signal.SIGTERM)
                deadline = time.monotonic() + 1
                while self.poll() is None and time.monotonic() < deadline:
                    time.sleep(0.02)
                if self.poll() is None:
                    os.killpg(self.pid, signal.SIGKILL)
                    _, self.status = os.waitpid(self.pid, 0)
        except ProcessLookupError:
            self.poll()
        finally:
            os.close(self.fd)


def main():
    token = uuid.uuid4().hex[:12]

    def marker(name):
        return f"APEX_{name}_{token}"

    def expression(name):
        # The expected marker never appears intact in submitted source/echo.
        return f"('APEX_' + '{name}_{token}')"

    probe = Probe()
    try:
        probe.expect("> ")
        probe.send(f"Write-Output {expression('READY')}")
        probe.expect(marker("READY"))

        probe.send(
            f"Write-Output ({expression('CWD')} + '=' + $PWD.Path + '=' + {expression('CWD_END')})"
        )
        probe.expect(marker("CWD") + "=" + os.getcwd() + "=" + marker("CWD_END"))
        print("PASS startup preserves the working directory", flush=True)

        probe.send(
            f"Write-Output ({expression('PSREADLINE')} + '=' + "
            "@(Get-Module PSReadLine).Count)"
        )
        probe.expect(marker("PSREADLINE") + "=0")
        print("PASS headless console does not load unsupported PSReadLine", flush=True)

        read_deadline = time.monotonic() + 10
        probe.send(
            f"$answer = Read-Host {expression('QUESTION')}; "
            f"Write-Output ({expression('READ_DONE')} + '=' + $answer)"
        )
        probe.expect(marker("QUESTION"), timeout=max(0, read_deadline - time.monotonic()))
        probe.expect_waiting(marker("READ_DONE"))
        probe.send("delayed-input")
        probe.expect(marker("READ_DONE") + "=delayed-input", timeout=max(0, read_deadline - time.monotonic()))
        print("PASS Read-Host waits for and receives subsequent input", flush=True)

        probe.send(
            "& /bin/sh -c 'exit 7'; "
            f"Write-Output ({expression('NATIVE_EXIT')} + '=' + $LASTEXITCODE)"
        )
        probe.expect(marker("NATIVE_EXIT") + "=7")
        print("PASS native process exit code is 7", flush=True)

        probe.send(
            f"Write-Output ({expression('UTF8')} + '=' + [char]0x4e2d + [char]0x6587)"
        )
        probe.expect(marker("UTF8") + "=中文")
        print("PASS UTF-8 output: 中文", flush=True)

        probe.send("exit 13")
        probe.expect_exit(13)
        print("PASS PowerShell exits with code 13", flush=True)
        return 0
    except (OSError, RuntimeError) as error:
        print(f"FAIL {error}", file=sys.stderr)
        print(probe.output[-4000:].decode("utf-8", errors="replace"), file=sys.stderr)
        return 1
    finally:
        probe.close()


if __name__ == "__main__":
    sys.exit(main())
