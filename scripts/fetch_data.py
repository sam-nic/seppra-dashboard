#!/usr/bin/env python3
"""
Fetches all Seppra data from Planfix and saves to data/cache.json.
Run locally or via GitHub Actions.
"""
import json, os, ssl, urllib.request, urllib.parse, time
from datetime import datetime, timezone

TOKEN = os.environ.get('PLANFIX_TOKEN')
if not TOKEN:
    raise RuntimeError('PLANFIX_TOKEN environment variable is required')
BASE  = 'https://seppra.planfix.ru/rest'
OUT   = os.path.join(os.path.dirname(__file__), '..', 'data', 'cache.json')

EXCLUDED_MANAGERS = {'Алексей Сущиц', 'Владимир Львович Чвиховский'}
EXCLUDED_STATUSES = {'Новая', 'Черновик', 'Выход на контакт'}

ctx = ssl._create_unverified_context()

def api(path, body=None):
    url = f'{BASE}/{path}'
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Content-Type': 'application/json'
    }, method='POST' if body is not None else 'GET')
    with urllib.request.urlopen(req, context=ctx, timeout=30) as r:
        return json.loads(r.read())

def fetch_lids():
    lids = []
    offset = 0
    while True:
        page = api('task/list', {
            'offset': offset, 'pageSize': 100,
            'fields': 'id,name,status,33484,33322,33526,33544',
            'filters': [{'type': 51, 'operator': 'equal', 'value': 127543}]
        })
        tasks = page.get('tasks') or []
        for t in tasks:
            sname = (t.get('status') or {}).get('name', '')
            if sname in EXCLUDED_STATUSES:
                continue
            cfd = {f['field']['id']: f for f in (t.get('customFieldData') or [])}
            mgr = (cfd.get(33484, {}).get('value') or {}).get('name')
            if mgr and mgr in EXCLUDED_MANAGERS:
                continue
            req_val = cfd.get(33322, {}).get('value') or []
            lids.append({
                'id':          t['id'],
                'name':        t.get('name', '').lstrip('👤').strip(),
                'manager':     mgr,
                'requests':    [{'id': r['id'], 'name': r.get('name', '')} for r in (req_val if isinstance(req_val, list) else [])],
                'plannedDate': (cfd.get(33526, {}).get('value') or {}).get('date', ''),
                'qualDate':    (cfd.get(33544, {}).get('value') or {}).get('date', ''),
            })
        print(f'  LIDs loaded: {len(lids)} (offset {offset})')
        offset += 100
        if len(tasks) < 100:
            break
        time.sleep(0.1)
    return lids

def fetch_requests(lids):
    req_ids = list({r['id'] for l in lids for r in l['requests']})
    requests = {}
    CONC = 8
    print(f'  Fetching {len(req_ids)} requests...')
    for i in range(0, len(req_ids), CONC):
        chunk = req_ids[i:i+CONC]
        for rid in chunk:
            try:
                r = api(f'task/{rid}?fields=id,dateTime,33420,33534')
                t = r.get('task')
                if t:
                    cfd = {f['field']['id']: f for f in (t.get('customFieldData') or [])}
                    requests[str(t['id'])] = {
                        'created': (t.get('dateTime') or {}).get('datetime', ''),
                        'kpDate':  (cfd.get(33420, {}).get('value') or {}).get('datetime', ''),
                        'nomDate': (cfd.get(33534, {}).get('value') or {}).get('datetime', ''),
                    }
            except Exception as e:
                print(f'    Request {rid} error: {e}')
        if i % 40 == 0:
            print(f'  Requests: {i+len(chunk)}/{len(req_ids)}')
        time.sleep(0.05)
    return requests

def fetch_kasaniya():
    kasaniya = []
    offset = 0
    while True:
        page = api('datatag/2730/entry/list', {
            'offset': offset, 'pageSize': 100,
            'fields': 'key,task,11434,11488,11490'
        })
        entries = page.get('dataTagEntries') or []
        for e in entries:
            task_id = (e.get('task') or {}).get('id')
            if not task_id:
                continue
            cfd = {f['field']['id']: f for f in (e.get('customFieldData') or [])}
            kasaniya.append({
                'taskId': task_id,
                'date':   (cfd.get(11434, {}).get('value') or {}).get('datetime', ''),
                'isCall': cfd.get(11490, {}).get('value') == '1' or cfd.get(11490, {}).get('stringValue') == '1',
                'isLPR':  cfd.get(11488, {}).get('value') == '1' or cfd.get(11488, {}).get('stringValue') == '1',
            })
        print(f'  Kasaniya loaded: {len(kasaniya)} (offset {offset})')
        offset += 100
        if len(entries) < 100:
            break
        time.sleep(0.1)
    return kasaniya

def main():
    print('=== Fetching LIDs ===')
    lids = fetch_lids()

    print('=== Fetching Requests ===')
    requests = fetch_requests(lids)

    print('=== Fetching Kasaniya ===')
    kasaniya = fetch_kasaniya()

    updated = datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M UTC')
    cache = {'lids': lids, 'requests': requests, 'kasaniya': kasaniya, 'updated': updated}

    out_path = os.path.normpath(OUT)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(out_path) // 1024
    print(f'\n✓ Saved to {out_path} ({size_kb} KB)')
    print(f'  LIDs: {len(lids)}, Requests: {len(requests)}, Kasaniya: {len(kasaniya)}')
    print(f'  Updated: {updated}')

if __name__ == '__main__':
    main()
