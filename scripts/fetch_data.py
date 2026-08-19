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
    """
    Возвращает (lids, taskManagers).
    lids — отфильтрованный список для отображения строк отчёта (без ранних
    статусов и без тестовых менеджеров).
    taskManagers — {taskId: managerName} для ВСЕХ задач ЛИДа независимо от
    статуса (кроме тестовых менеджеров) — нужен, чтобы звонки по лидам на
    раннем статусе (например «Новая») всё равно засчитывались менеджеру.
    """
    lids = []
    task_managers = {}
    offset = 0
    while True:
        page = api('task/list', {
            'offset': offset, 'pageSize': 100,
            'fields': 'id,name,status,33484,33322,33526,33544',
            'filters': [{'type': 51, 'operator': 'equal', 'value': 127543}]
        })
        tasks = page.get('tasks') or []
        for t in tasks:
            cfd = {f['field']['id']: f for f in (t.get('customFieldData') or [])}
            mgr = (cfd.get(33484, {}).get('value') or {}).get('name')
            if mgr and mgr in EXCLUDED_MANAGERS:
                continue
            task_managers[t['id']] = mgr

            sname = (t.get('status') or {}).get('name', '')
            if sname in EXCLUDED_STATUSES:
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
        # Шаг по факту полученных записей: Planfix иногда отдаёт неполную
        # страницу не только в конце списка (сетевые сбои/лимиты), поэтому
        # нельзя останавливаться просто по "меньше 100" — иначе теряем хвост.
        offset += len(tasks)
        if len(tasks) == 0:
            break
        time.sleep(0.1)
    return lids, task_managers

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

# Без фильтра по дате Planfix API отдаёт неполный список entry (проверено:
# ~2500 записей без фильтра против ~3400 с широким фильтром 2000-2099).
# Поэтому фильтр по дате ставим ВСЕГДА, даже когда нужны все записи.
WIDE_DATE_FILTER = lambda field: {'type': 3101, 'field': field, 'operator': 'equal', 'value': {
    'dateType': 'otherRange', 'dateFrom': '01-01-2000', 'dateTo': '31-12-2099'
}}

def fetch_datatag_entries(datatag_id, fields, date_field, label):
    """
    Постранично тянет все entry аналитики. Planfix иногда молча укорачивает
    страницу (throttling под нагрузкой — замечено после ~90+ запросов подряд
    внутри одного прогона), не возвращая ошибку. Поэтому короткую непустую
    страницу не считаем концом списка сразу — повторяем тот же offset с
    паузой и берём больший из двух результатов; концом считаем только
    страницу, которая пуста и на повторном запросе.
    """
    entries_all = []
    offset = 0
    while True:
        page = api(f'datatag/{datatag_id}/entry/list', {
            'offset': offset, 'pageSize': 100,
            'fields': fields,
            'filters': [WIDE_DATE_FILTER(date_field)]
        })
        entries = page.get('dataTagEntries') or []

        if len(entries) < 100:
            time.sleep(1.5)
            retry_page = api(f'datatag/{datatag_id}/entry/list', {
                'offset': offset, 'pageSize': 100,
                'fields': fields,
                'filters': [WIDE_DATE_FILTER(date_field)]
            })
            retry_entries = retry_page.get('dataTagEntries') or []
            if len(retry_entries) > len(entries):
                entries = retry_entries

        entries_all.extend(entries)
        print(f'  {label} loaded: {len(entries_all)} (offset {offset})')
        offset += len(entries)
        if len(entries) == 0:
            break
        time.sleep(0.3)
    return entries_all

def fetch_kasaniya():
    """
    Аналитика «Касания» (id=2730) — источник «до ЛПР». Считаем по полю
    «Сотрудник» (11438) напрямую, как в нативном отчёте Planfix — статус
    задачи ЛИДа и её наличие в отфильтрованном списке роли не играют.
    """
    kasaniya = []
    for e in fetch_datatag_entries(2730, 'key,task,11434,11438,11488', 11434, 'Kasaniya'):
        cfd = {f['field']['id']: f for f in (e.get('customFieldData') or [])}
        kasaniya.append({
            'taskId':   (e.get('task') or {}).get('id'),
            'date':     (cfd.get(11434, {}).get('value') or {}).get('datetime', ''),
            'employee': cfd.get(11438, {}).get('stringValue', ''),
            'isLPR':    cfd.get(11488, {}).get('value') == '1' or cfd.get(11488, {}).get('stringValue') == '1',
        })
    return kasaniya

def fetch_calls():
    """
    Аналитика «Звонок» (id=2734) — реальный журнал телефонии, источник
    «Дозвонов». Считаем по полю «Сотрудник» (11462) напрямую, как в
    нативном отчёте Planfix «Эффективность менеджеров холодных лидов» —
    учитываются ВСЕ звонки (включая не привязанные ни к одной задаче),
    статус задачи ЛИДа роли не играет. Недозвоны (11484) не считаются.
    """
    calls = []
    for e in fetch_datatag_entries(2734, 'key,task,11454,11462,11484', 11454, 'Calls'):
        cfd = {f['field']['id']: f for f in (e.get('customFieldData') or [])}
        missed = cfd.get(11484, {}).get('value') is True or cfd.get(11484, {}).get('stringValue') == '1'
        calls.append({
            'taskId':   (e.get('task') or {}).get('id'),
            'date':     (cfd.get(11454, {}).get('value') or {}).get('datetime', ''),
            'employee': cfd.get(11462, {}).get('stringValue', ''),
            'missed':   missed,
        })
    return calls

def main():
    print('=== Fetching LIDs ===')
    lids, task_managers = fetch_lids()

    print('=== Fetching Requests ===')
    requests = fetch_requests(lids)

    print('=== Fetching Kasaniya ===')
    kasaniya = fetch_kasaniya()

    print('=== Fetching Calls ===')
    calls = fetch_calls()

    updated = datetime.now(timezone.utc).strftime('%d.%m.%Y %H:%M UTC')
    cache = {
        'lids': lids, 'requests': requests, 'kasaniya': kasaniya, 'calls': calls,
        'taskManagers': task_managers, 'updated': updated,
    }

    out_path = os.path.normpath(OUT)
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))

    size_kb = os.path.getsize(out_path) // 1024
    print(f'\n✓ Saved to {out_path} ({size_kb} KB)')
    print(f'  LIDs: {len(lids)}, Requests: {len(requests)}, Kasaniya: {len(kasaniya)}, Calls: {len(calls)}')
    print(f'  Updated: {updated}')

if __name__ == '__main__':
    main()
