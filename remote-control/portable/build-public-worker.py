"""Add public-distribution notices and safe-upgrade docs without changing Worker/Bridge runtime.
Usage: python build-public-worker.py --input DSH-Worker-0.1.7.zip --out NEW_DIRECTORY
The original ZIP must match the pinned verified digest. No installation or configuration reads.
"""
from pathlib import Path, PurePosixPath
import argparse
import hashlib
import io
import json
import zipfile

BASE_SHA256 = 'ee58719236c9b7e26543ef4fe95ac1535af4c6bfd3e811ff86412ecc9815482e'
VERSION = '0.1.7-public.1'
LICENSE = '''MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
'''
WARNING = '''## Единственный канал доступа

Если старый Worker — единственная связь с устройством, **не выполняйте установку, отключение пакетов, остановку или перезапуск из этой инструкции** до проверки независимого канала восстановления. Нельзя использовать один приватный stateDir одновременно двумя версиями Worker. Отдельный локальный процесс OpenCode не создаёт входящего сетевого канала и не гарантирует восстановление связи.

До появления резервного доступа агент может только проверить версии/права, скачать архив, проверить SHA256 и подготовить план. Согласованная резервная копия живого изменяемого состояния может требовать штатной остановки — не останавливайте единственный канал ради неё. Не меняйте grants, ключи, TLS-проверки или VPN-настройки для обхода этой проблемы.

'''
PUBLIC_NOTE = '''# Public distribution

This is portable wrapper 0.1.7-public.1, containing native provider 0.1.7 and Bridge 0.1.5. All bytes under native-sdk/ and bridge/ and the role generator are unchanged from the verified 0.1.7 input. Only outer package version/publication metadata, documentation, checksums, and licensing notices differ.

The wrapper does not contain pairing secrets, settings, profiles, private state or a first-pairing wizard. It does not activate a Worker by download/extraction. Target: DSH 0.2.2-rc.1 and Node >=24.9, already-paired v2 Worker.

The native SDK fork derives from DeepSeek Harness, Copyright (c) 2026 DeepSeek, MIT License. The full notice is in licenses/DeepSeek-Harness-LICENSE.txt. Shared SDK and registry dependencies are not vendored; their own licenses apply.

The input SHA256 and exact published file hashes are in build-manifest.json and SHA256SUMS. Original production installation/state is not modified by this packaging script. A checksum and static scan do not establish operational readiness or a risk-free remote upgrade.
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode('utf-8')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit('Output must be a new directory; refusing overwrite')
    source = args.input.read_bytes()
    if digest(source) != BASE_SHA256:
        raise SystemExit('Input does not match the verified Worker 0.1.7 digest')
    payload = {}
    with zipfile.ZipFile(io.BytesIO(source)) as archive:
        if archive.testzip() is not None:
            raise SystemExit('Invalid input ZIP CRC')
        for item in archive.infolist():
            if item.is_dir():
                continue
            parts = PurePosixPath(item.filename).parts
            if len(parts) < 2 or parts[0] != 'worker-release-0.1.7' or '..' in parts or '\\' in item.filename:
                raise SystemExit('Unexpected input archive member')
            name = '/'.join(parts[1:])
            if name in payload:
                raise SystemExit('Duplicate input member')
            payload[name] = archive.read(item)
    original_manifest = json.loads(payload['build-manifest.json'])
    for name, expected in original_manifest['fileHashes'].items():
        if name not in payload or digest(payload[name]) != expected:
            raise SystemExit('Input member hash mismatch')
    preserved = {name: data for name, data in payload.items() if name.startswith(('native-sdk/', 'bridge/')) or name == 'create-role.mjs'}
    package = json.loads(payload['package.json'])
    package['version'] = VERSION
    package['files'] += ['licenses', 'PUBLIC-RELEASE.md']
    payload['package.json'] = encoded(package)
    readme = payload['README.ru.md'].decode('utf-8')
    readme = readme.replace('# Переносимый native Worker 0.1.7', '# Переносимый native Worker 0.1.7-public.1', 1)
    readme = readme.replace('## Совместимость и состав', WARNING + '## Совместимость и состав', 1)
    payload['README.ru.md'] = readme.encode('utf-8')
    payload['UPGRADE.md'] = (WARNING + payload['UPGRADE.md'].decode('utf-8')).encode('utf-8')
    payload['licenses/DeepSeek-Harness-LICENSE.txt'] = LICENSE.encode('utf-8')
    payload['PUBLIC-RELEASE.md'] = PUBLIC_NOTE.encode('utf-8')
    payload.pop('SHA256SUMS')
    payload.pop('build-manifest.json')
    hashes = {name: digest(data) for name, data in sorted(payload.items())}
    manifest = {**original_manifest, 'packageVersion': VERSION, 'fileHashes': hashes,
                'payloadTreeHash': digest(''.join(name + '\0' + value + '\n' for name, value in hashes.items()).encode()),
                'publicDistribution': {'inputSha256': BASE_SHA256, 'providerBytesUnchanged': True, 'privateHistoryIncluded': False}}
    payload['build-manifest.json'] = encoded(manifest)
    payload['SHA256SUMS'] = ''.join(digest(data) + '  ' + name + '\n' for name, data in sorted(payload.items())).encode('utf-8')
    if any(payload[name] != data for name, data in preserved.items()):
        raise SystemExit('Runtime/provider or role-generator bytes changed')
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
            raise SystemExit('Output ZIP verification failed')
        for name, data in payload.items():
            if archive.read(f'worker-release-{VERSION}/{name}') != data:
                raise SystemExit('Output ZIP member verification failed')
    checksum = digest(archive_path.read_bytes())
    (args.out / (archive_path.name + '.sha256')).write_text(checksum + '  ' + archive_path.name + '\n', encoding='utf-8')
    print(json.dumps({'archive': archive_path.name, 'files': len(payload), 'sha256': checksum, 'runtimeAndRoleFilesPreserved': len(preserved), 'installed': False}))


if __name__ == '__main__':
    main()
