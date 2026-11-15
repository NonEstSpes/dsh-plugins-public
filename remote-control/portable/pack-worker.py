"""Pack only the published Worker checksum list; never include local pairing or profile data."""
from pathlib import Path, PurePosixPath
import hashlib
import json
import re
import zipfile

base = Path(__file__).resolve().parent
source = base / 'worker-release-0.1.7'
archive = base / 'DSH-Worker-0.1.7.zip'
sums = source.joinpath('SHA256SUMS').read_text(encoding='utf-8')
expected = {}
for line in sums.splitlines():
    digest, name = line.split('  ', 1)
    parts = PurePosixPath(name).parts
    if not re.fullmatch(r'[a-f0-9]{64}', digest) or not parts or name.startswith('/') or '..' in parts or '\\' in name or name in expected:
        raise ValueError('Invalid published checksum entry')
    expected[name] = digest
expected['SHA256SUMS'] = hashlib.sha256(sums.encode('utf-8')).hexdigest()
contents = {}
for name, digest in expected.items():
    parts = PurePosixPath(name).parts
    if any(part in {'.git', '.private', 'private', 'node_modules', 'profiles', 'tests', 'fixtures'} or part.startswith('.env') for part in parts):
        raise ValueError('Private or undeclared development data in payload')
    filename = source / name
    if filename.is_symlink() or not filename.is_file():
        raise ValueError('Payload is not a regular published file')
    data = filename.read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('Published file checksum changed')
    if filename.suffix in {'.json', '.js', '.mjs', '.map', '.md'}:
        text = data.decode('utf-8')
        if re.search(r'"(?:sharedKey|relayToken|apiKey|clientSecret)"\s*:\s*"[A-Za-z0-9_~.-]{32,}"', text):
            raise ValueError('Credential-like literal in payload')
        if re.search(r'-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----', text):
            raise ValueError('Private key in payload')
    contents[name] = data
patch = json.loads(contents['cordis.patch.yml'])
bridge = [entry for row in patch for entry in row.get('insert', []) if entry['id'] == 'remote-native-control-bridge']
if len(bridge) != 1 or bridge[0].get('disabled') is not True or 'config' in bridge[0]:
    raise ValueError('Portable Bridge must remain disabled without a settings pointer')
with zipfile.ZipFile(archive, mode='x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as packed:
    for name, data in sorted(contents.items()):
        entry = zipfile.ZipInfo('worker-release-0.1.7/' + name, date_time=(2026, 11, 14, 0, 0, 0))
        entry.compress_type = zipfile.ZIP_DEFLATED
        entry.external_attr = 0o100644 << 16
        packed.writestr(entry, data)
with zipfile.ZipFile(archive) as packed:
    if packed.testzip() is not None or len(packed.namelist()) != len(contents):
        raise ValueError('ZIP integrity check failed')
    for name, data in contents.items():
        if packed.read('worker-release-0.1.7/' + name) != data:
            raise ValueError('Packed contents differ from checked publication')
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
with archive.with_suffix('.zip.sha256').open('x', encoding='utf-8', newline='\n') as out:
    out.write(digest + '  ' + archive.name + '\n')
print(json.dumps({'archive': str(archive), 'files': len(contents), 'bytes': archive.stat().st_size, 'sha256': digest, 'credentialsIncluded': False, 'installed': False}, ensure_ascii=False))
