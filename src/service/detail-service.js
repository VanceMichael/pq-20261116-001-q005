import { extractDetail, detailFingerprint } from "../feed/detail.js";

const TASK_STATUSES = new Set(["pending", "succeeded", "failed", "superseded"]);
const DEFAULT_BATCH_SIZE = 20;
const MAX_BATCH_SIZE = 100;
const DEFAULT_CONCURRENCY = 4;

export class DetailService {
  constructor({ database, feeds, articles, details, fetcher, clock = () => new Date(),
    concurrency = DEFAULT_CONCURRENCY, maxTasksPerRun = DEFAULT_BATCH_SIZE }) {
    this.database = database;
    this.feeds = feeds;
    this.articles = articles;
    this.details = details;
    this.fetcher = fetcher;
    this.clock = clock;
    this.concurrency = boundedInteger(concurrency, 1, 16, "concurrency");
    this.maxTasksPerRun = boundedInteger(maxTasksPerRun, 1, MAX_BATCH_SIZE, "maxTasksPerRun");
    this.inFlight = new Map();
  }

  list(feedId, { status = null, limit = 20 } = {}) {
    if (!this.feeds.get(feedId)) return null;
    if (status !== null && !TASK_STATUSES.has(status)) {
      throw new TypeError("status must be pending, succeeded, failed or superseded");
    }
    return { tasks: this.details.list(feedId, { status, limit }), statistics: this.details.stats(feedId) };
  }

  stats(feedId) {
    return this.details.stats(feedId);
  }

  retry(feedId, { articleId = null } = {}) {
    if (!this.feeds.get(feedId)) return null;
    if (articleId !== null && (!Number.isSafeInteger(articleId) || articleId < 1)) {
      throw new TypeError("articleId must be a positive integer");
    }
    const now = this.clock().toISOString();
    const { retried, skipped } = this.details.retryFailed(feedId, articleId, now);
    return { feedId, retried: retried.length, skipped, tasks: retried };
  }

  collect(feedId, { limit } = {}) {
    if (!this.feeds.get(feedId)) return null;
    const batchSize = parseBatchLimit(limit, this.maxTasksPerRun);
    const active = this.inFlight.get(feedId);
    if (active) return active;
    const run = this.performCollect(feedId, batchSize).finally(() => {
      if (this.inFlight.get(feedId) === run) this.inFlight.delete(feedId);
    });
    this.inFlight.set(feedId, run);
    return run;
  }

  async performCollect(feedId, batchSize) {
    const feed = this.feeds.get(feedId);
    const tasks = this.details.claim(feedId, batchSize);
    const results = [];
    let cursor = 0;
    const workerCount = Math.min(this.concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor];
        cursor += 1;
        results.push(await this.execute(feed, task));
      }
    });
    await Promise.all(workers);
    results.sort((left, right) => left.taskId - right.taskId);
    return {
      feedId,
      claimed: tasks.length,
      succeeded: results.filter((result) => result.status === "succeeded").length,
      failed: results.filter((result) => result.status === "failed").length,
      superseded: results.filter((result) => result.status === "superseded").length,
      duplicates: results.filter((result) => result.duplicate).length,
      results
    };
  }

  async execute(feed, task) {
    try {
      const fetched = await this.fetcher.fetchPage(task.requestedUrl, feed.allowedHosts);
      const obtainedAt = this.clock().toISOString();
      const detail = extractDetail(fetched.html);
      if (!detail.author && !detail.summary) {
        return this.fail(task, {
          httpStatus: fetched.status,
          errorCode: "detail_fields_missing",
          errorMessage: "detail page has no extractable author or summary"
        });
      }
      return this.apply(task, fetched, detail, obtainedAt);
    } catch (error) {
      return this.fail(task, {
        httpStatus: error.status ?? null,
        errorCode: error.code ?? "detail_fetch_failed",
        errorMessage: String(error.message ?? error).slice(0, 500)
      });
    }
  }

  apply(task, fetched, detail, obtainedAt) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.details.get(task.taskId);
      if (!current || current.status !== "pending") {
        this.database.exec("COMMIT");
        return taskResult(task, current?.status ?? "superseded", { note: "task_state_changed" });
      }
      const article = this.articles.detailState(task.articleId);
      if (!article) {
        this.details.completeFailure(task.taskId, {
          finishedAt: obtainedAt, httpStatus: fetched.status,
          errorCode: "article_missing", errorMessage: "article no longer exists in the archive"
        });
        this.database.exec("COMMIT");
        return taskResult(task, "failed", { errorCode: "article_missing" });
      }
      if (article.detailListSeenAt && task.listSeenAt < article.detailListSeenAt) {
        this.details.completeSuperseded(task.taskId, {
          finishedAt: obtainedAt, httpStatus: fetched.status,
          errorMessage: "fields from a newer list observation are already stored"
        });
        this.database.exec("COMMIT");
        return taskResult(task, "superseded", { httpStatus: fetched.status });
      }
      const author = detail.author ?? article.detailAuthor;
      const summary = detail.summary ?? article.detailSummary;
      const fingerprint = detailFingerprint({ author, summary });
      const duplicate = article.detailFingerprint !== null && article.detailFingerprint === fingerprint;
      if (duplicate) {
        this.articles.bumpDetailWatermark(task.articleId, task.listSeenAt);
      } else {
        this.articles.applyDetail(task.articleId, {
          author: detail.author, summary: detail.summary, obtainedAt,
          sourceUrl: fetched.finalUrl ?? task.requestedUrl,
          listSeenAt: task.listSeenAt, fingerprint
        });
      }
      this.details.completeSuccess(task.taskId, {
        finishedAt: obtainedAt, obtainedAt, httpStatus: fetched.status,
        finalUrl: fetched.finalUrl ?? null, fingerprint, duplicate
      });
      this.database.exec("COMMIT");
      return taskResult(task, "succeeded", { duplicate, httpStatus: fetched.status });
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  fail(task, { httpStatus, errorCode, errorMessage }) {
    const finishedAt = this.clock().toISOString();
    const recorded = this.details.completeFailure(task.taskId, { finishedAt, httpStatus, errorCode, errorMessage });
    return taskResult(task, recorded ? "failed" : "superseded", { errorCode, errorMessage, httpStatus });
  }

  pending(feedId) {
    return this.inFlight.has(feedId);
  }
}

function taskResult(task, status, extra = {}) {
  return {
    taskId: task.taskId,
    articleId: task.articleId,
    requestedUrl: task.requestedUrl,
    status,
    duplicate: Boolean(extra.duplicate),
    httpStatus: extra.httpStatus ?? null,
    errorCode: extra.errorCode ?? null,
    errorMessage: extra.errorMessage ?? null
  };
}

function parseBatchLimit(limit, fallback) {
  if (limit === undefined || limit === null || limit === "") return fallback;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new RangeError(`detail collect limit must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

function boundedInteger(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
