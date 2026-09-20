import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

if importlib.util.find_spec('sau_demo.core'):
    from sau_demo import core
else:
    core = None


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(core, 'Multi-account batch implementation is not present yet')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        for name, content in [('a.mp4', b'first-video'), ('b.mp4', b'second-video')]:
            (self.base / name).write_bytes(content)
        self.raw = {'simulation': False, 'intervalSeconds': 0, 'timeoutSeconds': 30,
                    'accounts': [
                        {'account': 'account-a', 'videos': [{'file': 'a.mp4', 'title': 'A 的作品'}]},
                        {'account': 'account-b', 'videos': [{'file': 'a.mp4', 'title': 'B 的作品'}]}]}
        self.state = self.base / 'state'

    def plan(self, raw=None):
        return core.build_plan(raw or self.raw, self.base)

    def test_plan_maps_same_material_to_independent_accounts(self):
        plan = self.plan()
        self.assertEqual([j['account'] for j in plan['jobs']], ['account-a', 'account-b'])
        self.assertEqual(plan['jobs'][0]['sha256'], plan['jobs'][1]['sha256'])
        self.assertNotEqual(plan['jobs'][0]['key'], plan['jobs'][1]['key'])
        self.assertEqual(plan['jobs'][0]['file'], str(self.base / 'a.mp4'))
        self.assertIsNone(plan['jobs'][0]['declaration'])

    def test_invalid_alias_duplicate_and_network_paths_are_rejected(self):
        for alias in ('../escape', 'CON', 'account-a/other'):
            raw = copy.deepcopy(self.raw)
            raw['accounts'][0]['account'] = alias
            with self.subTest(alias=alias), self.assertRaises(ValueError):
                self.plan(raw)
        raw = copy.deepcopy(self.raw)
        raw['accounts'][1]['account'] = 'ACCOUNT-A'
        with self.assertRaises(ValueError):
            self.plan(raw)
        raw = copy.deepcopy(self.raw)
        raw['accounts'][0]['videos'][0]['file'] = r'\\internal\share\video.mp4'
        with self.assertRaises(ValueError):
            self.plan(raw)

    def test_unknown_task_fields_and_missing_video_are_rejected(self):
        raw = copy.deepcopy(self.raw)
        raw['accounts'][0]['videos'][0]['taskId'] = '123'
        with self.assertRaises(ValueError):
            self.plan(raw)
        (self.base / 'a.mp4').unlink()
        with self.assertRaises(ValueError):
            self.plan()

    def test_parent_link_is_rejected_before_touching_child(self):
        link, child = self.base / 'link', self.base / 'link/video.mp4'
        def is_link(path):
            if path == child:
                self.fail('Accessed child through link before validating parent')
            return path == link
        with patch.object(Path, 'is_symlink', new=is_link):
            with self.assertRaises(ValueError):
                core.local_path(str(child), self.base)

    def test_publish_requires_confirmation_before_any_action(self):
        calls = []
        with self.assertRaises(ValueError):
            core.execute_plan(self.plan(), self.state, lambda job: calls.append(job))
        self.assertEqual(calls, [])
        self.assertFalse(self.state.exists())

    def test_simulation_cannot_be_sent_to_live_worker(self):
        plan = self.plan({**self.raw, 'simulation': True})
        with self.assertRaises(ValueError):
            core.execute_plan(plan, self.state, lambda job: self.fail('called'), confirmed=True)

    def test_submitting_is_saved_before_worker_and_repeated_run_is_skipped(self):
        calls = []
        def worker(job):
            ledger = json.loads((self.state / 'ledger.json').read_text(encoding='utf-8'))
            self.assertEqual(ledger['jobs'][job['key']]['status'], 'SUBMITTING')
            calls.append(job['account'])
            return {'status': 'SUBMITTED_UNVERIFIED', 'platformId': None, 'message': 'submitted'}
        result = core.execute_plan(self.plan(), self.state, worker, confirmed=True)
        self.assertEqual(calls, ['account-a', 'account-b'])
        self.assertEqual(result['counts']['SUBMITTED_UNVERIFIED'], 2)
        repeated = core.execute_plan(self.plan(), self.state, worker, confirmed=True)
        self.assertEqual(repeated['counts']['SKIPPED'], 2)
        self.assertEqual(len(calls), 2)

    def test_unknown_stops_same_account_but_next_account_continues(self):
        raw = copy.deepcopy(self.raw)
        raw['accounts'][0]['videos'].append({'file': 'b.mp4', 'title': '第二条'})
        calls = []
        def worker(job):
            calls.append(job['account'])
            return {'status': 'UNKNOWN' if job['account'] == 'account-a' else 'SUBMITTED_UNVERIFIED'}
        result = core.execute_plan(self.plan(raw), self.state, worker, confirmed=True)
        self.assertEqual(calls, ['account-a', 'account-b'])
        self.assertEqual([o['status'] for o in result['outcomes']],
                         ['UNKNOWN', 'BLOCKED', 'SUBMITTED_UNVERIFIED'])
        again = core.execute_plan(self.plan(raw), self.state, worker, confirmed=True)
        self.assertEqual([o['status'] for o in again['outcomes']], ['BLOCKED', 'BLOCKED', 'SKIPPED'])

    def test_crashed_submitting_blocks_on_restart(self):
        plan = self.plan()
        def worker(job):
            raise KeyboardInterrupt()
        with self.assertRaises(KeyboardInterrupt):
            core.execute_plan(plan, self.state, worker, confirmed=True)
        result = core.execute_plan(plan, self.state,
                                  lambda job: {'status': 'SUBMITTED_UNVERIFIED'}, confirmed=True)
        self.assertEqual(result['outcomes'][0]['status'], 'BLOCKED')
        self.assertEqual(result['outcomes'][1]['status'], 'SUBMITTED_UNVERIFIED')

    def test_missing_login_is_retryable_and_does_not_stop_other_account(self):
        result = core.execute_plan(self.plan(), self.state,
                                  lambda job: {'status': 'FAILED_BEFORE_SUBMIT'}, confirmed=True)
        self.assertEqual(result['counts']['FAILED_BEFORE_SUBMIT'], 2)
        result = core.execute_plan(self.plan(), self.state,
                                  lambda job: {'status': 'SUBMITTED_UNVERIFIED'}, confirmed=True)
        self.assertEqual(result['counts']['SUBMITTED_UNVERIFIED'], 2)

    def test_changed_material_after_preview_is_not_uploaded(self):
        plan = self.plan()
        (self.base / 'a.mp4').write_bytes(b'changed')
        calls = []
        result = core.execute_plan(plan, self.state, lambda job: calls.append(job), confirmed=True)
        self.assertFalse(calls)
        self.assertEqual(result['counts']['FAILED_BEFORE_SUBMIT'], 2)

    def test_worker_exception_or_malformed_result_is_unknown(self):
        def worker(job):
            if job['account'] == 'account-a':
                raise TimeoutError('must not retry automatically')
            return {'status': 'SUCCESS'}
        result = core.execute_plan(self.plan(), self.state, worker, confirmed=True)
        self.assertEqual(result['counts']['UNKNOWN'], 2)

    def test_lock_prevents_second_runner(self):
        self.state.mkdir()
        (self.state / 'run.lock').write_text('another runner', encoding='utf-8')
        with self.assertRaises(RuntimeError):
            core.execute_plan(self.plan(), self.state, lambda job: self.fail('called'), confirmed=True)

    def test_simulation_and_live_ledgers_cannot_mix(self):
        plan = self.plan({**self.raw, 'simulation': True})
        result = core.execute_plan(plan, self.state, lambda job: {'status': 'SIMULATED'}, simulation=True)
        self.assertTrue(result['simulation'])
        with self.assertRaises(ValueError):
            core.execute_plan(self.plan(), self.state, lambda job: self.fail('called'), confirmed=True)


if __name__ == '__main__':
    unittest.main()
