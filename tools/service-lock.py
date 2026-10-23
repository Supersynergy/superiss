"""Hold an OS advisory lock across exec; no stale PID lock reclamation."""
import fcntl
import json
import os
from pathlib import Path
import sys
import uuid

lock, owner, config_hash, *command = sys.argv[1:]
fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit('service already running')
held = fcntl.fcntl(fd, fcntl.F_DUPFD, 198)
os.close(fd)
os.set_inheritable(held, True)
instance = uuid.uuid4().hex
temporary = Path(owner + '.' + instance + '.tmp')
with temporary.open('x') as stream:
    os.chmod(temporary, 0o600)
    json.dump(dict(pid=os.getpid(), instance=instance, configHash=config_hash), stream)
    stream.flush()
    os.fsync(stream.fileno())
os.replace(temporary, owner)
environment = dict(os.environ, SIS_SERVICE_LOCK_FD=str(held), SIS_SERVICE_INSTANCE=instance)
os.execve(command[0], command, environment)
