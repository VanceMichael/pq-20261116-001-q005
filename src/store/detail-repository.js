const SUPERSEDE_MESSAGE = "a newer list observation made this task obsolete";

export class DetailRepository {
  constructor(database) {
    this.database = database;
    this.supersedeStale = database.prepare(`UPDATE detail_tasks
      SET status='superseded', finished_at=?, error_code='newer_observation', error_message=?
      WHERE feed_id=? AND status='pending' AND EXISTS (
        SELECT 1 FROM articles a WHERE a.article_id=detail_tasks.article_id
          AND a.last_seen_at=? AND a.title != detail_tasks.observed_title)`);
    this.enqueueMissing = database.prepare(`INSERT INTO detail_tasks
      (feed_id, article_id, requested_url, observed_title, list_seen_at, status, requested_at)
      SELECT a.feed_id, a.article_id, a.canonical_url, a.title, ?, 'pending', ?
      FROM articles a
      WHERE a.feed_id=? AND a.last_seen_at=?
        AND NOT EXISTS (SELECT 1 FROM detail_tasks t WHERE t.article_id=a.article_id AND t.status='pending')
        AND NOT EXISTS (SELECT 1 FROM detail_tasks t WHERE t.article_id=a.article_id AND t.observed_title=a.title)
      ON CONFLICT(article_id, list_seen_at) DO NOTHING`);
    this.pendingBatch = database.prepare(`SELECT * FROM detail_tasks
      WHERE feed_id=? AND status='pending' ORDER BY task_id ASC LIMIT ?`);
    this.taskById = database.prepare("SELECT * FROM detail_tasks WHERE task_id=?");
    this.succeed = database.prepare(`UPDATE detail_tasks SET status='succeeded',
      attempt_count=attempt_count+1, finished_at=?, obtained_at=?, http_status=?, final_url=?,
      fingerprint=?, duplicate=?, error_code=NULL, error_message=NULL
      WHERE task_id=? AND status='pending'`);
    this.fail = database.prepare(`UPDATE detail_tasks SET status='failed',
      attempt_count=attempt_count+1, finished_at=?, http_status=?, error_code=?, error_message=?
      WHERE task_id=? AND status='pending'`);
    this.supersedeLate = database.prepare(`UPDATE detail_tasks SET status='superseded',
      attempt_count=attempt_count+1, finished_at=?, http_status=?, error_code=?, error_message=?
      WHERE task_id=? AND status='pending'`);
    this.listTasks = database.prepare(`SELECT * FROM detail_tasks WHERE feed_id=?
      AND (? IS NULL OR status=?) ORDER BY task_id DESC LIMIT ?`);
    this.statsQuery = database.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='superseded' THEN 1 ELSE 0 END) AS superseded,
      MAX(obtained_at) AS last_obtained_at
      FROM detail_tasks WHERE feed_id=?`);
    this.failedTasks = database.prepare(`SELECT * FROM detail_tasks WHERE feed_id=? AND status='failed'
      AND (? IS NULL OR article_id=?) ORDER BY article_id ASC, task_id DESC`);
    this.pendingForArticle = database.prepare(`SELECT task_id FROM detail_tasks
      WHERE article_id=? AND status='pending' LIMIT 1`);
    this.taskAtObservation = database.prepare(`SELECT task_id FROM detail_tasks
      WHERE article_id=? AND list_seen_at=? AND task_id != ? LIMIT 1`);
    this.articleState = database.prepare(`SELECT article_id, canonical_url, title, last_seen_at
      FROM articles WHERE article_id=?`);
    this.rearm = database.prepare(`UPDATE detail_tasks SET status='pending',
      list_seen_at=?, requested_url=?, observed_title=?, requested_at=?, finished_at=NULL,
      obtained_at=NULL, http_status=NULL, final_url=NULL, fingerprint=NULL, duplicate=0,
      error_code=NULL, error_message=NULL
      WHERE task_id=? AND status='failed'`);
  }

  enqueueForCapture(feedId, capturedAt, now) {
    const superseded = Number(this.supersedeStale.run(now, SUPERSEDE_MESSAGE, feedId, capturedAt).changes);
    const enqueued = Number(this.enqueueMissing.run(capturedAt, now, feedId, capturedAt).changes);
    return { enqueued, superseded };
  }

  claim(feedId, limit) {
    return this.pendingBatch.all(feedId, limit).map(mapTask);
  }

  get(taskId) {
    const row = this.taskById.get(taskId);
    return row ? mapTask(row) : null;
  }

  completeSuccess(taskId, { finishedAt, obtainedAt, httpStatus, finalUrl, fingerprint, duplicate }) {
    return Number(this.succeed.run(finishedAt, obtainedAt, httpStatus, finalUrl, fingerprint,
      duplicate ? 1 : 0, taskId).changes) === 1;
  }

  completeFailure(taskId, { finishedAt, httpStatus, errorCode, errorMessage }) {
    return Number(this.fail.run(finishedAt, httpStatus, errorCode, errorMessage, taskId).changes) === 1;
  }

  completeSuperseded(taskId, { finishedAt, httpStatus = null, errorCode = "stale_result", errorMessage }) {
    return Number(this.supersedeLate.run(finishedAt, httpStatus, errorCode, errorMessage, taskId).changes) === 1;
  }

  list(feedId, { status = null, limit = 20 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.listTasks.all(feedId, status, status, safeLimit).map(mapTask);
  }

  stats(feedId) {
    const row = this.statsQuery.get(feedId);
    return {
      total: row.total,
      pending: row.pending ?? 0,
      succeeded: row.succeeded ?? 0,
      failed: row.failed ?? 0,
      superseded: row.superseded ?? 0,
      lastObtainedAt: row.last_obtained_at
    };
  }

  retryFailed(feedId, articleId, now) {
    const candidates = this.failedTasks.all(feedId, articleId, articleId);
    const retried = [];
    const skipped = [];
    const plannedArticles = new Set();
    for (const row of candidates) {
      const task = mapTask(row);
      if (plannedArticles.has(task.articleId)) {
        skipped.push({ taskId: task.taskId, articleId: task.articleId, reason: "newer_failed_task_retried" });
        continue;
      }
      plannedArticles.add(task.articleId);
      const article = this.articleState.get(task.articleId);
      if (!article) {
        skipped.push({ taskId: task.taskId, articleId: task.articleId, reason: "article_missing" });
        continue;
      }
      if (this.pendingForArticle.get(task.articleId)) {
        skipped.push({ taskId: task.taskId, articleId: task.articleId, reason: "pending_task_exists" });
        continue;
      }
      if (this.taskAtObservation.get(task.articleId, article.last_seen_at, task.taskId)) {
        skipped.push({ taskId: task.taskId, articleId: task.articleId, reason: "observation_already_tracked" });
        continue;
      }
      const changed = this.rearm.run(article.last_seen_at, article.canonical_url, article.title, now, task.taskId).changes;
      if (changed === 1) retried.push(this.get(task.taskId));
      else skipped.push({ taskId: task.taskId, articleId: task.articleId, reason: "task_state_changed" });
    }
    return { retried, skipped };
  }
}

function mapTask(row) {
  return {
    taskId: row.task_id,
    feedId: row.feed_id,
    articleId: row.article_id,
    requestedUrl: row.requested_url,
    observedTitle: row.observed_title,
    listSeenAt: row.list_seen_at,
    status: row.status,
    attemptCount: row.attempt_count,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
    obtainedAt: row.obtained_at,
    httpStatus: row.http_status,
    finalUrl: row.final_url,
    fingerprint: row.fingerprint,
    duplicate: Boolean(row.duplicate),
    errorCode: row.error_code,
    errorMessage: row.error_message
  };
}
