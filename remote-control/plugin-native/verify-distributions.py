"""Read-only ZIP closure and pinned Client verification; no PowerShell policy changes."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import zipfile
from datetime import datetime, timezone

base = Path(__file__).resolve().parent
inventory = json.loads((base / 'dist/input-inventory.json').read_text(encoding='utf-8'))
refresh = json.loads((base / 'client-refresh-report.json').read_text(encoding='utf-8'))
results = []
for role, prefix in [('controller', 'bundle/'), ('worker', 'worker-bundle/')]:
    archive_path = base / f'dist/{role}-extension-0.1.0.zip'
    with zipfile.ZipFile(archive_path) as archive:
        files = [entry for entry in archive.infolist() if not entry.is_dir()]
        if len(files) != inventory[role]['files']:
            raise RuntimeError(f'{role}: archive file count mismatch')
        names = set(archive.namelist())
        for entry in files:
            if not entry.filename.startswith(prefix) or '\\' in entry.filename or '..' in PurePosixPath(entry.filename).parts:
                raise RuntimeError(f'Nonportable archive path: {entry.filename}')
        manifest = json.loads(archive.read(prefix + 'package.json'))
        for name, spec in manifest.get('dependencies', {}).items():
            if not spec.startswith('file:./'):
                raise RuntimeError(f'{role}: noninternal dependency {name}')
            child_path = prefix + spec[7:] + '/package.json'
            child = json.loads(archive.read(child_path))
            if child['name'] != name:
                raise RuntimeError(f'{role}: dependency identity mismatch {name}')
        for change in refresh['changes']:
            if role == 'worker' and not change['file'].startswith('packages/worker-session-controller/'):
                continue
            actual = hashlib.sha256(archive.read(prefix + change['file'])).hexdigest()
            if actual != change['after']:
                raise RuntimeError(f'{role}: stale Client {change["file"]}')
        if archive.testzip() is not None:
            raise RuntimeError(f'{role}: ZIP CRC failure')
    results.append(dict(role=role, file=str(archive_path), name=manifest['name'], version=manifest['version'],
                        sha256=hashlib.file_digest(archive_path.open('rb'), 'sha256').hexdigest(),
                        bytes=archive_path.stat().st_size, files=len(files), root=prefix,
                        internalDependenciesVerified=True, latestAckClientsVerified=True, crcVerified=True))
report = dict(builtAt=datetime.now(timezone.utc).isoformat(), archives=results,
              noRuntimeCopies=True, workerConfigRequiresExplicitPreservation=True)
(base / 'dist/distribution-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
for result in results:
    print(f'READY {result["role"]} {result["bytes"]} bytes SHA256 {result["sha256"]}')
