"""Command line entry for the local SAU publishing demo."""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

from .core import atomic_json, build_plan, execute_plan, execution_lock, local_path, validate_alias

ROOT = Path(__file__).absolute().parent.parent


def _stop_worker(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        try:
            subprocess.run(['taskkill.exe', '/PID', str(process.pid), '/T', '/F'],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           creationflags=subprocess.CREATE_NO_WINDOW, check=False, timeout=10)
        except (OSError, subprocess.TimeoutExpired):
            pass
    if process.poll() is None:
        process.kill()
    process.wait(timeout=10)


def run_worker(request, *, root=ROOT, confirmed=False):
    """Use argument arrays, an isolated process, and a hard watchdog."""
    if request['action'] == 'upload' and not confirmed:
        raise ValueError('真实上传前需要 --confirm-remote-write')
    root = Path(root)
    python = root / '.sau-demo-venv/Scripts/python.exe'
    if not python.exists():
        return {'status': 'FAILED_BEFORE_SUBMIT', 'platformId': None,
                'message': '请先运行 setup-sau-demo.cmd 安装本地运行环境；尚未启动上传'}
    state = root / 'data/sau-publish'
    state.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='worker-', dir=state) as directory:
        request_file, result_file = Path(directory) / 'request.json', Path(directory) / 'result.json'
        atomic_json(request_file, request)
        args = [str(python), '-X', 'utf8', '-m', 'sau_demo.worker',
                '--repo', str(root / 'social-auto-upload'), '--request', str(request_file), '--result', str(result_file)]
        if confirmed:
            args.append('--confirm-remote-write')
        env = {**os.environ, 'PYTHONUTF8': '1', 'PLAYWRIGHT_BROWSERS_PATH': str(root / '.sau-demo-browsers')}
        flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
        try:
            process = subprocess.Popen(args, cwd=root, env=env, stdin=subprocess.DEVNULL,
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       creationflags=flags)
        except OSError:
            return {'status': 'FAILED_BEFORE_SUBMIT', 'platformId': None,
                    'message': '本地上传进程未能启动，尚未进行远程上传；请检查 Python 环境'}
        try:
            process.communicate(timeout=request.get('timeoutSeconds', 600) + 20)
        except subprocess.TimeoutExpired:
            _stop_worker(process)
            return {'status': 'UNKNOWN' if request['action'] == 'upload' else 'FAILED_BEFORE_SUBMIT',
                    'platformId': None, 'message': '任务超过时限，已停止子进程；发布结果须人工核对'}
        except BaseException:
            _stop_worker(process)
            raise
        if not result_file.is_file():
            return {'status': 'UNKNOWN' if request['action'] == 'upload' else 'FAILED_BEFORE_SUBMIT',
                    'platformId': None, 'message': '上传模块未返回结构化结果，请检查环境并核对平台'}
        result = json.loads(result_file.read_text(encoding='utf-8'))
        if process.returncode != 0 and result.get('status') in {'SUBMITTED_UNVERIFIED', 'READY', 'LOGIN_SAVED'}:
            return {'status': 'UNKNOWN', 'platformId': None, 'message': '执行状态与回执矛盾，请人工核对'}
        return result


def _print_report(report, log):
    log(json.dumps(report, ensure_ascii=False, indent=2))
    if not report.get('simulation') and report.get('counts', {}).get('SUBMITTED_UNVERIFIED'):
        log('上传模块已返回，但未获取唯一作品 ID；请在各账号作品管理中核对，不能据此认定审核通过。')


def demo(root, log):
    output = root / 'demo-output/sau'
    run = output / 'runs' / uuid.uuid4().hex
    run.mkdir(parents=True)
    accounts = []
    for alias in ['demo-a', 'demo-b']:
        videos = []
        for index in range(1, 3):
            file = run / f'{alias}-{index}.mp4'
            # These are deliberately NOT playable videos. Live mode rejects this configuration.
            file.write_bytes(f'SIMULATION ONLY: {alias}/{index}'.encode('utf-8'))
            videos.append({'file': str(file), 'title': f'{alias} 模拟作品 {index}'})
        accounts.append({'account': alias, 'videos': videos})
    plan = build_plan({'simulation': True, 'intervalSeconds': 0, 'accounts': accounts}, run)
    atomic_json(run / 'plan.json', plan)
    worker = lambda job: {'status': 'SIMULATED', 'platformId': None, 'message': '离线模拟，未上传任何数据'}
    log('离线演示：两个虚拟账号，各两条模拟作品；不会打开浏览器。')
    first = execute_plan(plan, run / 'state', worker, simulation=True, log=log)
    log('再次执行同一批次，验证同账号素材防重：')
    repeated = execute_plan(plan, run / 'state', worker, simulation=True, log=log)
    report = {'simulation': True, 'firstRun': first, 'repeatRun': repeated, 'directory': str(run)}
    atomic_json(output / 'latest-report.json', report)
    log(f'首次：{first["counts"]}；重复：{repeated["counts"]}')
    log(f'报告：{output / "latest-report.json"}')
    return 0


def main(argv=None, *, root=ROOT, log=print):
    root = Path(root)
    parser = argparse.ArgumentParser(description='抖音多账号普通视频发布 Demo；默认不执行远程写入')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('demo', help='两账号离线模拟和重复执行测试')
    commands.add_parser('report', help='查看真实批次的最近执行结果')
    for command in ['plan', 'publish']:
        sub = commands.add_parser(command, help='离线预览批次' if command == 'plan' else '执行已预览并确认的真实批次')
        sub.add_argument('--config', default=str(root / 'config/sau-accounts.local.json'))
        if command == 'publish':
            sub.add_argument('--confirm-remote-write', action='store_true')
    for command in ['login', 'check']:
        sub = commands.add_parser(command, help='打开浏览器手动登录并保存会话' if command == 'login' else '检查指定账号会话')
        sub.add_argument('--account', required=True)
        sub.add_argument('--timeout', type=int, default=600)
    args = parser.parse_args(argv)
    if args.command == 'demo':
        return demo(root, log)
    state = root / 'data/sau-publish'
    if args.command == 'report':
        report = state / 'last-report.json'
        if not report.exists():
            log('尚无真实批次报告。离线演示结果见 demo-output/sau/latest-report.json。')
            return 0
        _print_report(json.loads(report.read_text(encoding='utf-8')), log)
        return 0
    if args.command in {'login', 'check'}:
        alias = validate_alias(args.account)
        if not 30 <= args.timeout <= 3600:
            raise ValueError('--timeout 应为 30–3600 秒')
        log(f'{args.command}: {alias}；登录时请确认浏览器中的实际账号与别名对应。')
        with execution_lock(state):
            result = run_worker({'action': args.command, 'account': alias, 'headless': False,
                                 'timeoutSeconds': args.timeout}, root=root)
        log(json.dumps(result, ensure_ascii=False, indent=2))
        return 0 if result.get('status') in {'READY', 'LOGIN_SAVED'} else 1
    if args.command == 'publish' and not args.confirm_remote_write:
        raise ValueError('真实上传前需要 --confirm-remote-write；先使用 plan 核对具体账号和素材')
    config_file = local_path(args.config, root)
    if not config_file.is_file():
        raise ValueError(f'配置不存在：{config_file}。请从 config/sau-accounts.example.json 复制并填写真实素材路径')
    plan = build_plan(json.loads(config_file.read_text(encoding='utf-8')), config_file.parent)
    if plan['simulation']:
        raise ValueError('真实入口拒绝模拟配置，请使用 demo 命令')
    preview = state / 'plan.json'
    if args.command == 'plan':
        with execution_lock(state):
            atomic_json(preview, plan)
        log('离线预览，未打开浏览器、未上传。每个别名必须由你核对为正确的实际抖音账号。')
        for job in plan['jobs']:
            cookie = root / 'social-auto-upload/cookies' / f'douyin_{job["account"]}.json'
            declaration = job['declaration'] or '不主动设置声明'
            log(f'{job["account"]} | {job["title"]} | {job["file"]} | 声明: {declaration} | 登录文件: {"存在，尚未联网校验" if cookie.exists() else "待登录"}')
        log(f'计划 ID：{plan["planId"]}\n已保存：{preview}')
        return 0
    if not preview.is_file() or json.loads(preview.read_text(encoding='utf-8')).get('planId') != plan['planId']:
        raise ValueError('缺少对应预览，或配置/素材已变化；请重新执行 plan 并核对批次')
    result = execute_plan(plan, state,
                          lambda job: run_worker({**job, 'action': 'upload'}, root=root, confirmed=True),
                          confirmed=True, log=log)
    _print_report(result, log)
    return 1 if any(result['counts'].get(status) for status in ['FAILED_BEFORE_SUBMIT', 'UNKNOWN', 'BLOCKED']) else 0
