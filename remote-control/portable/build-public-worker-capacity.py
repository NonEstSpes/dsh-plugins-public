"""Assemble Worker 0.1.7-public.2 from two immutable, pinned release ZIPs.
Only stages a new archive: no config reads, installation, profile access or network.
Usage: python build-public-worker-capacity.py --input DSH-Worker-0.1.7.zip --bridge bridge-0.1.6.zip --out NEW_DIRECTORY
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import importlib.util
import io
import json
import zipfile

BASE_SHA256 = 'ee58719236c9b7e26543ef4fe95ac1535af4c6bfd3e811ff86412ecc9815482e'
BRIDGE_SHA256 = '1c56e1719019ae6298519df4c1fa8f55a529cf5de819e78dfff6e0f334d265d6'
BRIDGE_TREE = '64fc94dd1df618700ca99280d51bbcd2990ca1e375f40430801491a9091d8153'
VERSION = '0.1.7-public.2'
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('public_worker_notices', HERE / 'build-public-worker.py')
notices = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notices)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def read_pinned(filename, expected_hash, prefix):
    raw = filename.read_bytes()
    if digest(raw) != expected_hash:
        raise SystemExit('Input release digest mismatch: ' + filename.name)
    files = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        if archive.testzip() is not None:
            raise SystemExit('Input ZIP CRC mismatch')
        for item in archive.infolist():
            if item.is_dir():
                continue
            parts = PurePosixPath(item.filename).parts
            if len(parts) < 2 or parts[0] != prefix or '..' in parts or '\\' in item.filename:
                raise SystemExit('Unexpected ZIP member')
            name = '/'.join(parts[1:])
            if name in files:
                raise SystemExit('Duplicate ZIP member')
            files[name] = archive.read(item)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--bridge', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit('Output must be a new directory; refusing overwrite')
    payload = read_pinned(args.input, BASE_SHA256, 'worker-release-0.1.7')
    base_manifest = json.loads(payload['build-manifest.json'])
    for name, expected in base_manifest['fileHashes'].items():
        if name not in payload or digest(payload[name]) != expected:
            raise SystemExit('Base Worker member hash mismatch')
    preserved = {name: data for name, data in payload.items() if name.startswith('native-sdk/') or name == 'create-role.mjs'}
    bridge = read_pinned(args.bridge, BRIDGE_SHA256, 'bundle-release-0.1.6')
    package = json.loads(bridge['package.json'])
    report = json.loads(bridge['bridge-release-report.json'])
    bridge_hashes = {name: digest(data) for name, data in sorted(bridge.items()) if name != 'bridge-release-report.json'}
    tree = digest(''.join(name + '\0' + value + '\n' for name, value in bridge_hashes.items()).encode())
    if len(bridge) != 42 or tree != BRIDGE_TREE or report['treeHashExcludingThisReport'] != tree:
        raise SystemExit('Bridge closed payload receipt mismatch')
    if package['name'] != '@dsh-remote/control-bridge' or package['version'] != '0.1.6' or package['engines']['dsh'] != '0.2.2-rc.1' or package['dsh'].get('client'):
        raise SystemExit('Bridge identity or platform mismatch')
    if package['peerDependencies']['@dsh-remote/worker-session-controller'] != '0.1.7':
        raise SystemExit('Bridge native SDK peer mismatch')
    for name in list(payload):
        if name.startswith('bridge/'):
            del payload[name]
    payload.update({'bridge/' + name: data for name, data in bridge.items()})
    outer = json.loads(payload['package.json'])
    outer['version'] = VERSION
    outer['description'] = 'Already-paired v2 Worker: native provider 0.1.7 and receipt-capacity Bridge 0.1.6; inactive until explicit role configuration'
    outer['files'] += ['licenses', 'PUBLIC-RELEASE.md']
    payload['package.json'] = encoded(outer)
    readme = (HERE / 'README.capacity.ru.md').read_text(encoding='utf-8')
    if '# Переносимый native Worker 0.1.7-public.2' not in readme or 'мост **0.1.6**' not in readme:
        raise SystemExit('Public Worker README does not match this release')
    payload['README.ru.md'] = readme.encode('utf-8')
    payload['TRANSPORT.md'] = bridge['TRANSPORT.md']
    payload['UPGRADE.md'] = (notices.WARNING + bridge['UPGRADE.md'].decode('utf-8')).encode('utf-8')
    payload['licenses/DeepSeek-Harness-LICENSE.txt'] = notices.LICENSE.encode('utf-8')
    payload['PUBLIC-RELEASE.md'] = ('''# Public distribution 0.1.7-public.2

Contains native provider 0.1.7 and the exact published Bridge 0.1.6 capacity fix. Every native-sdk/ file and create-role.mjs is byte-for-byte preserved from the pinned Worker 0.1.7 base. Every bridge/ file equals the pinned Bridge 0.1.6 release, not the older 0.1.5 bridge.

The outgoing v2 record budget is 8192 with at most 256 pending messages; retention, authenticated receipts and existing operation identities are preserved. This is finite capacity, not unlimited throughput or a guarantee of exactly-once native effects. Old Bridge <=0.1.5 cannot read an outbox exceeding 512 records; read UPGRADE.md before replacement or rollback.

No pairing keys, settings, private state, profiles, journals or new-device pairing wizard are included. Target: DSH 0.2.2-rc.1, Node >=24.9, already-paired Worker config v2. Shared SDK and registry dependencies are not vendored. Download/extraction does not activate a Worker or authorize stopping the only remote channel. No remote installation or WAN acceptance is claimed.

DeepSeek Harness-derived native SDK: Copyright (c) 2026 DeepSeek, MIT License. Full notice: licenses/DeepSeek-Harness-LICENSE.txt. Preserve dependency-specific licenses and attribution.
''').encode('utf-8')
    payload.pop('SHA256SUMS')
    payload.pop('build-manifest.json')
    hashes = {name: digest(data) for name, data in sorted(payload.items())}
    provider_hashes = {name: value for name, value in hashes.items() if name.startswith(('native-sdk/', 'bridge/'))}
    manifest = {**base_manifest, 'packageVersion': VERSION,
                'bridge': {'artifact': 'plugin-bridge/bundle-release-0.1.6', 'sha256': BRIDGE_TREE},
                'fileHashes': hashes, 'providerFileHashes': provider_hashes,
                'payloadTreeHash': digest(''.join(name + '\0' + value + '\n' for name, value in hashes.items()).encode()),
                'publicDistribution': {'inputSha256': BASE_SHA256, 'bridgeZipSha256': BRIDGE_SHA256,
                                       'nativeSdkBytesUnchanged': True, 'roleGeneratorBytesUnchanged': True,
                                       'bridgeBytesMatchPublishedArtifact': True, 'privateHistoryIncluded': False}}
    payload['build-manifest.json'] = encoded(manifest)
    payload['SHA256SUMS'] = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(payload.items())).encode('utf-8')
    if any(payload[name] != data for name, data in preserved.items()):
        raise SystemExit('Native SDK or role generator changed')
    if any(payload['bridge/' + name] != data for name, data in bridge.items()):
        raise SystemExit('Bridge differs from published artifact')
    args.out.mkdir(parents=True)
    archive_path = args.out / f'DSH-Worker-{VERSION}.zip'
    with zipfile.ZipFile(archive_path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in sorted(payload.items()):
            info = zipfile.ZipInfo(f'worker-release-{VERSION}/{name}', date_time=(2026, 11, 15, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, data)
    with zipfile.ZipFile(archive_path) as archive:
        if archive.testzip() is not None or len(archive.infolist()) != len(payload):
            raise SystemExit('Output ZIP CRC/list mismatch')
        for name, data in payload.items():
            if archive.read(f'worker-release-{VERSION}/{name}') != data:
                raise SystemExit('Output ZIP member differs')
    checksum = digest(archive_path.read_bytes())
    (args.out / (archive_path.name + '.sha256')).write_text(checksum + '  ' + archive_path.name + '\n', encoding='utf-8')
    print(json.dumps({'archive': archive_path.name, 'files': len(payload), 'sha256': checksum,
                      'nativeAndRoleFilesPreserved': len(preserved), 'publishedBridgeFilesMatched': len(bridge), 'installed': False}))


if __name__ == '__main__':
    main()
