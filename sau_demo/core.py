"""Offline planning and durable, serial execution. No browser dependencies."""
import ctypes
import hashlib
import json
import os
import re
import time
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def local_path(value, base):
    if not isinstance(value, str) or not value.strip() or re.match(r'^[\\/]{2}', value) or '://' in value:
        raise ValueError('仅支持本机文件，不接受 URL 或网络共享路径')
    path = Path(os.path.abspath(Path(base) / value))
    if str(path).startswith(('\\\\', '//')):
        raise ValueError('Demo 不连接网络共享路径')
    if os.name == 'nt' and ctypes.windll.kernel32.GetDriveTypeW(str(path.anchor)) == 4:
        raise ValueError('Demo 不连接映射网络盘，请先把素材复制到本机')
    for parent in (*reversed(path.parents), path):
        if parent.is_symlink() or (hasattr(parent, 'is_junction') and parent.is_junction()):
            raise ValueError('Demo 不接受符号链接或目录连接')
    return path


def file_hash(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def validate_alias(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,48}', value) or re.fullmatch(r'(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])', value):
        raise ValueError('账号别名须为 1–48 位字母、数字、下划线或连字符，且不能是系统保留名称')
    return value


def _keys(value, allowed, label):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError(f'{label} 有不支持的字段；本 Demo 仅支持普通视频发布，不支持任务绑定')


def build_plan(raw, base):
    _keys(raw, ['simulation', 'accounts', 'intervalSeconds', 'timeoutSeconds', 'headless'], '配置')
    simulation = raw.get('simulation', False)
    headless = raw.get('headless', False)
    interval, timeout = raw.get('intervalSeconds', 15), raw.get('timeoutSeconds', 600)
    if type(simulation) is not bool or type(headless) is not bool:
        raise ValueError('simulation/headless 必须是布尔值')
    if type(interval) is not int or not 0 <= interval <= 3600 or type(timeout) is not int or not 30 <= timeout <= 3600:
        raise ValueError('intervalSeconds 应为 0–3600；timeoutSeconds 应为 30–3600')
    accounts = raw.get('accounts')
    if not isinstance(accounts, list) or not 1 <= len(accounts) <= 20:
        raise ValueError('Demo 需要 1–20 个账号，首次建议两个账号各一条')
    jobs, aliases, used = [], set(), set()
    for account in accounts:
        _keys(account, ['account', 'videos'], '账号')
        alias = validate_alias(account.get('account'))
        if alias.lower() in aliases:
            raise ValueError('账号别名重复（不区分大小写）')
        aliases.add(alias.lower())
        videos = account.get('videos')
        if not isinstance(videos, list) or not 1 <= len(videos) <= 10:
            raise ValueError('Demo 每账号需要 1–10 条视频')
        for video in videos:
            _keys(video, ['file', 'title', 'description', 'tags', 'declaration'], '视频')
            file = local_path(video.get('file'), base)
            if file.suffix.lower() not in {'.mp4', '.mov', '.m4v'} or not file.is_file() or file.stat().st_size == 0:
                raise ValueError(f'视频不存在、为空或格式不支持: {file}')
            title = video.get('title')
            description, tags, declaration = video.get('description', ''), video.get('tags', []), video.get('declaration')
            if not isinstance(title, str) or not title.strip() or len(title.strip()) > 30:
                raise ValueError('标题需要 1–30 个字符')
            if not isinstance(description, str) or len(description) > 1000:
                raise ValueError('简介需要字符串，最长 1000 个字符')
            if not isinstance(tags, list) or len(tags) > 10 or any(not isinstance(tag, str) or not tag.strip() or len(tag) > 30 for tag in tags):
                raise ValueError('tags 需要最多 10 个非空话题字符串')
            if declaration is not None and (not isinstance(declaration, str) or not declaration.strip()):
                raise ValueError('declaration 应为 null 或平台声明的准确文字')
            fingerprint = file_hash(file)
            key = alias.lower() + ':' + fingerprint
            if key in used:
                raise ValueError(f'同账号配置重复素材: {alias} / {file.name}')
            used.add(key)
            jobs.append(dict(key=key, account=alias, file=str(file), sha256=fingerprint,
                             title=title.strip(), description=description, tags=tags,
                             declaration=declaration, headless=headless, timeoutSeconds=timeout))
    plan = dict(version=1, simulation=simulation, intervalSeconds=interval, jobs=jobs)
    plan['planId'] = hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    return plan


@contextmanager
def execution_lock(state_dir):
    state_dir = Path(state_dir)
    state_dir.mkdir(parents=True, exist_ok=True)
    lock = state_dir / 'run.lock'
    try:
        stream = lock.open('x', encoding='utf-8')
    except FileExistsError:
        raise RuntimeError(f'已有执行锁 {lock}；先确认旧进程已结束，再人工清理锁，勿并行运行') from None
    try:
        with stream:
            json.dump({'pid': os.getpid(), 'startedAt': now()}, stream)
        yield
    finally:
        lock.unlink(missing_ok=True)


def execute_plan(plan, state_dir, worker, *, confirmed=False, simulation=False, log=lambda text: None):
    if not simulation and not confirmed:
        raise ValueError('真实上传前需要 --confirm-remote-write')
    if bool(plan.get('simulation')) != simulation:
        raise ValueError('模拟配置与真实发布不能混用')
    state_dir = Path(state_dir)
    outcomes = []
    with execution_lock(state_dir):
        ledger_file = state_dir / 'ledger.json'
        ledger = json.loads(ledger_file.read_text(encoding='utf-8')) if ledger_file.exists() else {'version': 1, 'simulation': simulation, 'jobs': {}}
        if ledger.get('version') != 1 or ledger.get('simulation') is not simulation or not isinstance(ledger.get('jobs'), dict):
            raise ValueError('台账格式或模拟标记不匹配，拒绝执行')
        blocked = {record['account'].lower() for record in ledger['jobs'].values()
                   if record['status'] in {'SUBMITTING', 'UNKNOWN'}}
        for job in plan['jobs']:
            alias, key = job['account'], job['key']
            existing = ledger['jobs'].get(key)
            outcome = {'account': alias, 'file': job['file'], 'sha256': job['sha256']}
            if alias.lower() in blocked:
                outcome.update(status='BLOCKED', message='该账号有未核实的提交，请先查看平台记录')
            elif existing and existing['status'] in {'SUBMITTED_UNVERIFIED', 'SIMULATED'}:
                outcome.update(status='SKIPPED', message='台账中已有相同账号、相同素材的记录', previousStatus=existing['status'])
            else:
                try:
                    actual = local_path(job['file'], Path.cwd())
                    if file_hash(actual) != job['sha256']:
                        raise ValueError('素材在预览后发生变化')
                except (OSError, ValueError):
                    result = {'status': 'FAILED_BEFORE_SUBMIT', 'message': '素材已变化或不可读取；重新检查并预览', 'platformId': None}
                else:
                    record = {**job, 'status': 'SUBMITTING', 'updatedAt': now(),
                              'attempts': (existing or {}).get('attempts', 0) + 1}
                    ledger['jobs'][key] = record
                    atomic_json(ledger_file, ledger)
                    log(f'{alias} / {Path(job["file"]).name}: {"模拟执行" if simulation else "开始上传与发布"}')
                    try:
                        result = worker(job)
                        allowed = {'SIMULATED', 'FAILED_BEFORE_SUBMIT', 'UNKNOWN'} if simulation else {'SUBMITTED_UNVERIFIED', 'FAILED_BEFORE_SUBMIT', 'UNKNOWN'}
                        if not isinstance(result, dict) or result.get('status') not in allowed:
                            raise ValueError('invalid worker result')
                    except Exception:
                        result = {'status': 'UNKNOWN', 'message': '执行异常或结果缺失，禁止自动重试；请人工核对平台', 'platformId': None}
                ledger['jobs'][key] = {**job, **result, 'updatedAt': now(),
                                       'attempts': ledger['jobs'].get(key, {}).get('attempts', 0)}
                atomic_json(ledger_file, ledger)
                outcome.update(result)
                if result['status'] in {'UNKNOWN', 'FAILED_BEFORE_SUBMIT'}:
                    blocked.add(alias.lower())
                if not simulation and plan['intervalSeconds'] and result['status'] == 'SUBMITTED_UNVERIFIED':
                    time.sleep(plan['intervalSeconds'])
            log(f'{alias}: {outcome["status"]}')
            outcomes.append(outcome)
        report = dict(version=1, simulation=simulation, planId=plan['planId'], createdAt=now(),
                      counts=dict(Counter(item['status'] for item in outcomes)), outcomes=outcomes)
        atomic_json(state_dir / 'last-report.json', report)
        return report
