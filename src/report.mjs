export function makeReport(config, jobs, date) {
  return { date, accounts: config.accounts.map(account => {
    const rows = jobs.filter(j => j.accountId === account.id && j.date === date);
    const taskRows = rows.filter(j => j.mode !== 'ordinary' && j.taskId != null);
    const counts = {};
    for (const j of rows) counts[j.status] = (counts[j.status] ?? 0) + 1;
    return { accountId: account.id, counts,
      submittedTaskIds: [...new Set(taskRows.filter(j => ['PENDING_REVIEW', 'APPROVED'].includes(j.status)).map(j => j.taskId))],
      approvedTaskIds: [...new Set(taskRows.filter(j => j.status === 'APPROVED').map(j => j.taskId))] };
  }), jobs: jobs.map(j => ({ id: j.id, accountId: j.accountId, date: j.date, file: j.path,
    mode: j.mode === undefined ? 'task' : j.mode,
    title: j.title, taskId: j.taskId, taskName: j.taskName, status: j.status,
    platformId: j.platformId, error: j.error })) };
}
