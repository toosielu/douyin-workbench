import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

if importlib.util.find_spec('sau_demo.cli'):
    from sau_demo import cli
else:
    cli = None


class CliTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(cli, 'CLI is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = []

    def test_demo_publishes_four_simulated_items_and_skips_second_run(self):
        code = cli.main(['demo'], root=self.root, log=self.output.append)
        self.assertEqual(code, 0)
        report = json.loads((self.root / 'demo-output/sau/latest-report.json').read_text(encoding='utf-8'))
        self.assertTrue(report['simulation'])
        self.assertEqual(report['firstRun']['counts'], {'SIMULATED': 4})
        self.assertEqual(report['repeatRun']['counts'], {'SKIPPED': 4})
        self.assertFalse((self.root / 'data/sau-publish').exists())

    def test_publish_confirmation_checked_before_config_or_worker(self):
        with patch.object(cli, 'run_worker', side_effect=AssertionError('must not start')):
            with self.assertRaisesRegex(ValueError, 'confirm-remote-write'):
                cli.main(['publish'], root=self.root, log=self.output.append)

    def test_missing_runtime_is_definite_pre_submit_failure(self):
        result = cli.run_worker({'action': 'upload'}, root=self.root, confirmed=True)
        self.assertEqual(result['status'], 'FAILED_BEFORE_SUBMIT')

    def test_spawn_failure_is_definite_pre_submit_failure(self):
        python = self.root / '.sau-demo-venv/Scripts/python.exe'
        python.parent.mkdir(parents=True)
        python.write_bytes(b'fake executable for offline test')
        with patch.object(cli.subprocess, 'Popen', side_effect=OSError('cannot spawn')):
            result = cli.run_worker({'action': 'upload'}, root=self.root, confirmed=True)
        self.assertEqual(result['status'], 'FAILED_BEFORE_SUBMIT')

    def test_watchdog_cleanup_has_timeout_and_falls_back_to_kill(self):
        process = MagicMock()
        process.poll.return_value = None
        with patch.object(cli.os, 'name', 'nt'), patch.object(cli.subprocess, 'run',
                side_effect=cli.subprocess.TimeoutExpired('taskkill', 10)) as taskkill:
            cli._stop_worker(process)
        self.assertEqual(taskkill.call_args.kwargs['timeout'], 10)
        process.kill.assert_called_once()
        process.wait.assert_called_once_with(timeout=10)

    def test_plan_then_changed_config_cannot_publish(self):
        video = self.root / 'video.mp4'
        video.write_bytes(b'test-fixture-only')
        config = self.root / 'accounts.json'
        raw = {'accounts': [{'account': 'alpha', 'videos': [{'file': 'video.mp4', 'title': '测试'}]}]}
        config.write_text(json.dumps(raw), encoding='utf-8')
        cli.main(['plan', '--config', str(config)], root=self.root, log=self.output.append)
        raw['accounts'][0]['videos'][0]['title'] = '改标题'
        config.write_text(json.dumps(raw), encoding='utf-8')
        with patch.object(cli, 'run_worker', side_effect=AssertionError('must not start')):
            with self.assertRaisesRegex(ValueError, 'plan|预览'):
                cli.main(['publish', '--config', str(config), '--confirm-remote-write'], root=self.root, log=self.output.append)

    def test_confirmed_publish_passes_exact_job_to_worker_and_reports_unverified(self):
        (self.root / 'video.mp4').write_bytes(b'test-fixture-only')
        config = self.root / 'accounts.json'
        config.write_text(json.dumps({'intervalSeconds': 0, 'accounts': [
            {'account': 'alpha', 'videos': [{'file': 'video.mp4', 'title': '测试', 'declaration': None}]}]}), encoding='utf-8')
        cli.main(['plan', '--config', str(config)], root=self.root, log=self.output.append)
        with patch.object(cli, 'run_worker', return_value={'status': 'SUBMITTED_UNVERIFIED'}) as worker:
            self.assertEqual(cli.main(['publish', '--config', str(config), '--confirm-remote-write'], root=self.root, log=self.output.append), 0)
        request = worker.call_args.args[0]
        self.assertEqual(request['account'], 'alpha')
        self.assertIsNone(request['declaration'])
        self.assertEqual(request['action'], 'upload')
        self.assertTrue(worker.call_args.kwargs['confirmed'])


if __name__ == '__main__':
    unittest.main()
