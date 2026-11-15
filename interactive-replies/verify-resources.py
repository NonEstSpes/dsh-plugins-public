from pathlib import Path
import json
from lxml import etree

p = Path(__file__).resolve().parent
m = json.loads((p / 'package.json').read_text(encoding='utf-8'))
assert m['version'] == '1.0.3'
assert (p / 'client.js').read_bytes() == (p / 'dist' / m['version'] / 'client.js').read_bytes(), 'Legacy and versioned clients must match'
assert m['dsh']['client']['inject'][-1] == '@deepseek-ai/dsh-client-locale'
dictionaries = [json.loads((p / 'locale' / (lang + '.json')).read_text(encoding='utf-8')) for lang in ('ru', 'en')]
assert dictionaries[0].keys() == dictionaries[1].keys()
for dictionary in dictionaries:
    assert dictionary['meta']['title'] and dictionary['meta']['description']
    assert 'pilot' not in dictionary['meta']['title'].lower()
root = etree.parse(str(p / 'icon.svg')).getroot()
assert root.tag == '{http://www.w3.org/2000/svg}svg'
assert (p / 'icon.svg').stat().st_size < 262144
for export in ('.', './client', './icon'):
    assert (p / m['exports'][export]).is_file(), export
for filename in ('host.js', 'state.js', 'validation.js', 'catalog-info.js', 'admission.js', 'client.js'):
    assert (p / 'dist' / m['version'] / filename).is_file(), filename
for filename in ('cordis.patch.yml', 'README.md', 'THIRD_PARTY_NOTICES.md'):
    assert (p / filename).is_file(), filename
assert 'Vue' in (p / 'THIRD_PARTY_NOTICES.md').read_text(encoding='utf-8')
print('Versioned Host/Client exports, locale parity/metadata, original SVG and shipped resources: valid')
