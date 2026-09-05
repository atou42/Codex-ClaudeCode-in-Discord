"""Construct verified unattached Git objects; deliberately never update any ref."""
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile
import urllib.request
import zlib

REPO = 'atou42/agents-in-discord'
MAIN = '88244c11b9f4b4b0f4c7f7213b8d1c1f501f48d2'
BASE = f'https://api.github.com/repos/{REPO}/'
OUTPUT = Path('object-evidence')
OUTPUT.mkdir()

def api(endpoint, payload=None):
    # This process cannot publish branches, merge PRs, or call service endpoints.
    if payload is not None:
        assert endpoint in ('git/blobs', 'git/trees', 'git/commits')
    else:
        assert endpoint.startswith(('git/blobs/', 'git/commits/', 'git/ref/heads/', 'contents/'))
    request = urllib.request.Request(BASE + endpoint,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
                 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'},
        method='GET' if payload is None else 'POST')
    with urllib.request.urlopen(request, timeout=45) as response:
        return json.load(response)

def blob_hash(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()

def read_blob(sha):
    reply = api('git/blobs/' + sha)
    data = base64.b64decode(reply['content'])
    assert blob_hash(data) == sha
    return data

def allowed(path):
    parts = PurePosixPath(path).parts
    return (not path.startswith('/') and '..' not in parts and '.git' not in parts
            and (path == 'package.json' or path.startswith(('src/', 'test/', 'docs/'))))

def existing(path, parent, expected=None):
    assert allowed(path)
    reply = api(f'contents/{path}?ref={parent}')
    data = base64.b64decode(reply['content'])
    assert reply['sha'] == blob_hash(data)
    if expected is not None:
        assert reply['sha'] == expected, path
    return data

assert api('git/ref/heads/main')['object']['sha'] == MAIN
manifest = json.loads(Path('builder-manifest.json').read_text())
created = {}
results = []
for item in manifest:
    name = item['id']
    parent = created.get(item['parent'], item['parent'])
    assert re.fullmatch('[0-9a-f]{40}', parent)
    assert api('git/commits/' + parent)['tree']['sha'] == item['parent_tree']
    if name.startswith('pr'):
        assert api('git/ref/heads/' + item['branch'])['object']['sha'] == parent
    raw = read_blob(item['patch_blob']) if item['patch_blob'] else b''
    patch = json.loads(zlib.decompress(raw))['patch'] if item['compressed'] else raw.decode()
    chunks = [x for x in re.split(r'(?=^diff --git )', patch, flags=re.M) if x.strip()]
    files = {}
    with tempfile.TemporaryDirectory(prefix='round2-object-') as temporary:
        root = Path(temporary)
        subprocess.run(['git', 'init', '-q', str(root)], check=True)
        for chunk in chunks:
            header = re.match(r'diff --git a/(\S+) b/(\S+)\n', chunk)
            assert header and header[1] == header[2]
            path = header[1]
            assert allowed(path) and path not in files
            index = re.search(r'^index ([0-9a-f]{40})\.\.([0-9a-f]{40})(?: 100644)?$', chunk, re.M)
            assert index, path
            before, after = index.groups()
            assert after != '0' * 40
            files[path] = {'before': before, 'after': after}
            target = root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            if before != '0' * 40:
                target.write_bytes(existing(path, parent, before))
        if patch:
            subprocess.run(['git', 'apply', '--check', '-'], cwd=root, input=patch.encode(), check=True)
            subprocess.run(['git', 'apply', '-'], cwd=root, input=patch.encode(), check=True)
        if item['entry']:
            path = 'package.json'
            data = existing(path, parent)
            anchor, addition = item['entry']
            needle = f'test/{anchor}.test.mjs '
            text = data.decode()
            assert text.count(needle) == 1 and f'test/{addition}.test.mjs' not in text
            text = text.replace(needle, needle + f'test/{addition}.test.mjs ')
            (root / path).write_text(text)
            files[path] = {'before': blob_hash(data), 'after': item['package_after']}
        # Check every resulting byte BEFORE creating any tree or commit for this batch.
        for path, info in files.items():
            assert blob_hash((root / path).read_bytes()) == info['after'], path
        elements = []
        for path, info in files.items():
            data = (root / path).read_bytes()
            uploaded = api('git/blobs', {'content': base64.b64encode(data).decode(), 'encoding': 'base64'})
            assert uploaded['sha'] == info['after'], path
            elements.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': uploaded['sha']})
            destination = OUTPUT / name / path
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(data)
        tree = api('git/trees', {'base_tree': item['parent_tree'], 'tree': elements})
        assert tree['sha'] == item['tree'], name
        commit = api('git/commits', {'message': item['message'], 'tree': tree['sha'], 'parents': [parent]})
        assert commit['tree']['sha'] == item['tree']
        created[name] = commit['sha']
        results.append({'id': name, 'branch': item['branch'], 'parent': parent,
                        'commit': commit['sha'], 'tree': tree['sha'], 'files': files})
        (OUTPUT / 'objects.json').write_text(json.dumps(results, indent=2))
        print(name, commit['sha'], tree['sha'], 'verified; no ref updated', flush=True)
assert api('git/ref/heads/main')['object']['sha'] == MAIN
shutil.copyfile('builder-manifest.json', OUTPUT / 'builder-manifest.json')
