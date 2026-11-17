import test from "node:test";
import assert from "node:assert/strict";
import { makeArchive, page, standardItems, baseFeed, captureTime, detailPage, detailFetcher } from "../helpers.js";
import { NewsArchive } from "../../src/service/archive.js";
import { PageFetcher } from "../../src/acquisition/page-fetcher.js";
import { createHttpServer } from "../../src/http/server.js";

const articleUrl = (id) => `https://news.example.test/2026/11-16/article-${id}.shtml`;

function mutableClock(start = "2026-11-16T02:00:01.000Z") {
  const state = { now: start };
  return { clock: () => new Date(state.now), set: (value) => { state.now = value; } };
}

async function waitFor(condition, message = "condition was not met in time") {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

test("accepted lists enqueue detail tasks that are queryable apart from list acceptance", async (t) => {
  const { clock } = mutableClock();
  const { archive } = await makeArchive(t, { clock });
  archive.registerFeed(baseFeed);
  const first = archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  assert.equal(first.accepted, true);
  assert.deepEqual(first.details, { enqueued: 4, superseded: 0 });

  const items = archive.listItems("daily-main").items;
  assert.equal(items.length, 4);
  assert.ok(items.every((item) => item.detailAuthor === null && item.detailSummary === null));
  assert.ok(items.every((item) => item.detailObtainedAt === null && item.detailSourceUrl === null));

  const pending = archive.listDetailTasks("daily-main", { status: "pending" });
  assert.equal(pending.tasks.length, 4);
  assert.ok(pending.tasks.every((task) => task.status === "pending" && task.attemptCount === 0));
  assert.equal(pending.tasks[0].listSeenAt, captureTime(1));
  assert.equal(pending.statistics.pending, 4);

  const status = archive.feedStatus("daily-main");
  assert.equal(status.statistics.total, 4);
  assert.deepEqual({ ...status.details, lastObtainedAt: null }, {
    total: 4, pending: 4, succeeded: 0, failed: 0, superseded: 0, lastObtainedAt: null
  });

  const again = archive.importSnapshot("daily-main", `${page(standardItems(4))}\n<!-- recaptured -->`, captureTime(2));
  assert.equal(again.accepted, true);
  assert.deepEqual(again.details, { enqueued: 0, superseded: 0 });
  assert.equal(archive.listDetailTasks("daily-main").statistics.pending, 4);
});

test("collects author and summary with provenance once per pending task", async (t) => {
  const { clock, set } = mutableClock();
  const fetcher = detailFetcher({
    [articleUrl(1)]: { author: "张三", summary: "第一条摘要", finalUrl: "https://news.example.test/2026/11-16/article-1-final.shtml" },
    [articleUrl(2)]: { author: "李四", summary: "第二条摘要" },
    [articleUrl(3)]: { author: "王五" },
    [articleUrl(4)]: {}
  });
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  set("2026-11-16T02:00:05.000Z");
  const summary = await archive.collectDetails("daily-main");
  assert.equal(summary.claimed, 4);
  assert.equal(summary.succeeded, 3);
  assert.equal(summary.failed, 1);
  assert.equal(summary.results.find((result) => result.status === "failed").errorCode, "detail_fields_missing");
  assert.equal(fetcher.calls.length, 4);
  assert.deepEqual(fetcher.calls[0].allowedHosts, ["news.example.test"]);

  const first = archive.listItems("daily-main").items
    .find((item) => item.canonicalUrl === articleUrl(1));
  assert.equal(first.detailAuthor, "张三");
  assert.equal(first.detailSummary, "第一条摘要");
  assert.equal(first.detailObtainedAt, "2026-11-16T02:00:05.000Z");
  assert.equal(first.detailSourceUrl, "https://news.example.test/2026/11-16/article-1-final.shtml");
  assert.equal(first.detailListSeenAt, captureTime(1));

  const partial = archive.listItems("daily-main").items
    .find((item) => item.canonicalUrl === articleUrl(3));
  assert.equal(partial.detailAuthor, "王五");
  assert.equal(partial.detailSummary, null);
  assert.equal(partial.detailObtainedAt, "2026-11-16T02:00:05.000Z");

  const empty = archive.listItems("daily-main").items
    .find((item) => item.canonicalUrl === articleUrl(4));
  assert.equal(empty.detailAuthor, null);
  assert.equal(empty.detailObtainedAt, null);

  const tasks = archive.listDetailTasks("daily-main", { status: "succeeded" });
  assert.equal(tasks.tasks.length, 3);
  assert.ok(tasks.tasks.every((task) => task.attemptCount === 1 && task.duplicate === false));
  const statistics = archive.feedStatus("daily-main").details;
  assert.equal(statistics.failed, 1);
  assert.equal(statistics.lastObtainedAt, "2026-11-16T02:00:05.000Z");

  const second = await archive.collectDetails("daily-main");
  assert.equal(second.claimed, 0);
  assert.equal(fetcher.calls.length, 4);
  assert.equal(archive.listDetailTasks("daily-main", { status: "failed" }).tasks.length, 1);
});

test("keeps previous fields and their provenance when a refresh of detail fails, then retries", async (t) => {
  const { clock, set } = mutableClock();
  let failing = false;
  let version = 1;
  const fetcher = detailFetcher((url) => {
    if (failing && url === articleUrl(1)) {
      return { error: Object.assign(new Error("upstream timeout"), { code: "fetch_failed" }) };
    }
    return { html: detailPage(version === 1 ? { author: "初版作者", summary: "初版摘要" } : { author: "修订作者", summary: "修订摘要" }) };
  });
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  set("2026-11-16T02:00:05.000Z");
  await archive.collectDetails("daily-main");
  const before = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(before.detailAuthor, "初版作者");
  assert.equal(before.detailObtainedAt, "2026-11-16T02:00:05.000Z");

  archive.importSnapshot("daily-main", page([{ id: 1, title: "更新后的标题" }, { id: 2 }, { id: 3 }]), captureTime(10));
  set("2026-11-16T02:00:20.000Z");
  failing = true;
  const failedRun = await archive.collectDetails("daily-main");
  assert.equal(failedRun.failed, 1);
  assert.equal(failedRun.results[0].errorCode, "fetch_failed");

  const retained = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(retained.title, "更新后的标题");
  assert.equal(retained.detailAuthor, "初版作者");
  assert.equal(retained.detailSummary, "初版摘要");
  assert.equal(retained.detailObtainedAt, "2026-11-16T02:00:05.000Z");
  assert.equal(retained.detailListSeenAt, captureTime(1));
  const failedTask = archive.listDetailTasks("daily-main", { status: "failed" }).tasks[0];
  assert.equal(failedTask.errorCode, "fetch_failed");
  assert.equal(failedTask.attemptCount, 1);

  failing = false;
  version = 2;
  set("2026-11-16T02:00:30.000Z");
  const retry = archive.retryDetails("daily-main");
  assert.equal(retry.retried, 1);
  assert.equal(retry.tasks[0].status, "pending");
  assert.equal(retry.tasks[0].attemptCount, 1);
  assert.equal(retry.tasks[0].listSeenAt, captureTime(10));

  const recovered = await archive.collectDetails("daily-main");
  assert.equal(recovered.succeeded, 1);
  assert.equal(recovered.duplicates, 0);
  const updated = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(updated.detailAuthor, "修订作者");
  assert.equal(updated.detailObtainedAt, "2026-11-16T02:00:30.000Z");
  assert.equal(updated.detailListSeenAt, captureTime(10));
  const task = archive.listDetailTasks("daily-main", { status: "succeeded" }).tasks
    .find((entry) => entry.articleId === updated.articleId && entry.listSeenAt === captureTime(10));
  assert.equal(task.attemptCount, 2);
});

test("discards a stale in-flight detail result instead of overwriting fields from a newer list round", async (t) => {
  const { clock } = mutableClock();
  let releaseGate;
  let gateOpen = false;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const fetcher = detailFetcher((url) => {
    if (url === articleUrl(1) && !gateOpen) {
      return { gate, html: detailPage({ author: "过期作者", summary: "过期摘要" }) };
    }
    if (url === articleUrl(1)) return { html: detailPage({ author: "新版作者", summary: "新版摘要" }) };
    return { html: detailPage({ author: "常规作者", summary: "常规摘要" }) };
  });
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));

  const firstRun = archive.collectDetails("daily-main");
  await waitFor(() => fetcher.calls.length === 3, "expected all three detail fetches to start");
  await waitFor(() => archive.listDetailTasks("daily-main", { status: "succeeded" }).tasks.length === 2);

  const second = archive.importSnapshot("daily-main",
    page([{ id: 1, title: "改名后的标题" }, { id: 2 }, { id: 3 }]), captureTime(2));
  assert.deepEqual(second.details, { enqueued: 1, superseded: 1 });

  gateOpen = true;
  releaseGate();
  const firstSummary = await firstRun;
  assert.equal(firstSummary.succeeded, 2);
  assert.equal(firstSummary.superseded, 1);
  const staleEntry = firstSummary.results.find((result) => result.requestedUrl === articleUrl(1));
  assert.equal(staleEntry.status, "superseded");

  const interim = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(interim.detailAuthor, null);
  assert.equal(archive.listDetailTasks("daily-main", { status: "pending" }).tasks.length, 1);

  const secondSummary = await archive.collectDetails("daily-main");
  assert.equal(secondSummary.succeeded, 1);
  const article = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(article.detailAuthor, "新版作者");
  assert.equal(article.detailSummary, "新版摘要");
  assert.equal(article.detailListSeenAt, captureTime(2));
  const tasks = archive.listDetailTasks("daily-main");
  assert.equal(tasks.statistics.superseded, 1);
  assert.equal(tasks.statistics.succeeded, 3);
});

test("treats an identical detail body as a duplicate that only advances the observation watermark", async (t) => {
  const { clock, set } = mutableClock();
  const fetcher = detailFetcher(() => ({ html: detailPage({ author: "固定作者", summary: "固定摘要" }) }));
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  set("2026-11-16T02:00:05.000Z");
  await archive.collectDetails("daily-main");
  const original = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(original.detailObtainedAt, "2026-11-16T02:00:05.000Z");

  archive.importSnapshot("daily-main", page([{ id: 1, title: "标题微调" }, { id: 2 }, { id: 3 }]), captureTime(9));
  set("2026-11-16T02:00:12.000Z");
  const summary = await archive.collectDetails("daily-main");
  assert.equal(summary.succeeded, 1);
  assert.equal(summary.duplicates, 1);

  const after = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(after.detailAuthor, "固定作者");
  assert.equal(after.detailObtainedAt, "2026-11-16T02:00:05.000Z");
  assert.equal(after.detailListSeenAt, captureTime(9));
  const task = archive.listDetailTasks("daily-main", { status: "succeeded" }).tasks
    .find((entry) => entry.listSeenAt === captureTime(9));
  assert.equal(task.duplicate, true);
});

test("applies detail to a quieted article without resurrecting it or touching observation fields", async (t) => {
  const { clock } = mutableClock();
  const fetcher = detailFetcher(() => ({ html: detailPage({ author: "迟到作者", summary: "迟到摘要" }) }));
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(4)), captureTime(1));
  for (const second of [2, 3, 4]) {
    archive.importSnapshot("daily-main", `${page(standardItems(3, 2))}<!--${second}-->`, captureTime(second));
  }
  const quietBefore = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(quietBefore.visibility, "quiet");
  assert.equal(quietBefore.missingStreak, 3);

  const summary = await archive.collectDetails("daily-main");
  assert.equal(summary.succeeded, 4);
  const quietAfter = archive.articles.get("daily-main", articleUrl(1));
  assert.equal(quietAfter.visibility, "quiet");
  assert.equal(quietAfter.lastSeenAt, captureTime(1));
  assert.equal(quietAfter.seenCount, 1);
  assert.equal(quietAfter.missingStreak, 3);
  assert.equal(quietAfter.detailAuthor, "迟到作者");
  assert.equal(archive.listItems("daily-main", { visibility: "visible" }).items.length, 3);
  assert.equal(archive.listItems("daily-main", { visibility: "quiet" }).items.length, 1);
});

test("keeps pending detail tasks across a process restart and resumes collection", async (t) => {
  const { clock } = mutableClock();
  const fetcher = detailFetcher(() => ({ html: detailPage({ author: "恢复作者", summary: "恢复摘要" }) }));
  const { archive, filename } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  assert.equal(archive.listDetailTasks("daily-main").statistics.pending, 3);
  archive.close();

  const reopened = new NewsArchive(filename, { clock, fetcher });
  t.after(() => reopened.close());
  const pending = reopened.listDetailTasks("daily-main", { status: "pending" });
  assert.equal(pending.tasks.length, 3);
  const summary = await reopened.collectDetails("daily-main");
  assert.equal(summary.succeeded, 3);
  assert.equal(reopened.listDetailTasks("daily-main").statistics.pending, 0);
  assert.ok(reopened.listItems("daily-main").items.every((item) => item.detailAuthor === "恢复作者"));
});

test("skips retrying a failed task when a newer pending task already covers the article", async (t) => {
  const { clock } = mutableClock();
  let failing = true;
  const fetcher = detailFetcher(() => failing
    ? { error: Object.assign(new Error("upstream timeout"), { code: "fetch_failed" }) }
    : { html: detailPage({ author: "补抓作者", summary: "补抓摘要" }) });
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const failedRun = await archive.collectDetails("daily-main");
  assert.equal(failedRun.failed, 3);

  archive.importSnapshot("daily-main", page([{ id: 1, title: "新标题" }, { id: 2 }, { id: 3 }]), captureTime(6));
  const retry = archive.retryDetails("daily-main");
  assert.equal(retry.retried, 2);
  const skipped = retry.skipped.find((entry) => entry.reason === "pending_task_exists");
  assert.ok(skipped, "expected the stale failed task to be skipped in favor of the pending one");
  assert.equal(archive.listDetailTasks("daily-main", { status: "pending" }).tasks.length, 3);

  failing = false;
  const recovered = await archive.collectDetails("daily-main");
  assert.equal(recovered.succeeded, 3);
  assert.equal(archive.listDetailTasks("daily-main").statistics.failed, 1);
});

test("coalesces concurrent collect calls into one run of bounded fetches", async (t) => {
  const { clock } = mutableClock();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = detailFetcher(() => ({ gate, html: detailPage({ author: "作者", summary: "摘要" }) }));
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(5)), captureTime(1));
  const first = archive.collectDetails("daily-main");
  const second = archive.collectDetails("daily-main");
  assert.equal(archive.detailService.pending("daily-main"), true);
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(left.claimed, 5);
  assert.equal(fetcher.calls.length, 5);
});

test("enforces the source host allowlist and byte budget on detail fetches", async (t) => {
  const fetcher = new PageFetcher({
    fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://other-example.test/track" } })
  });
  const { archive } = await makeArchive(t, { fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const summary = await archive.collectDetails("daily-main");
  assert.equal(summary.failed, 3);
  assert.ok(summary.results.every((result) => result.errorCode === "host_not_allowed"));
  const tasks = archive.listDetailTasks("daily-main", { status: "failed" });
  assert.equal(tasks.tasks.length, 3);
  assert.ok(archive.listItems("daily-main").items.every((item) => item.detailAuthor === null));
});

test("exposes detail collection over HTTP with validation and unknown-feed handling", async (t) => {
  const { clock } = mutableClock();
  const fetcher = detailFetcher(() => ({ html: detailPage({ author: "接口作者", summary: "接口摘要" }) }));
  const { archive } = await makeArchive(t, { clock, fetcher });
  archive.registerFeed(baseFeed);
  archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  const app = createHttpServer(archive, { host: "127.0.0.1", port: 0, logger: { error() {} } });
  const address = await app.listen();
  t.after(() => app.close());
  const root = `http://127.0.0.1:${address.port}/v1/feeds/daily-main`;

  const listed = await fetch(`${root}/details?status=pending`);
  assert.equal(listed.status, 200);
  const listing = await listed.json();
  assert.equal(listing.tasks.length, 3);
  assert.equal(listing.statistics.pending, 3);

  const invalid = await fetch(`${root}/details?status=bogus`);
  assert.equal(invalid.status, 400);

  const badLimit = await fetch(`${root}/details/collect`, { method: "POST", body: JSON.stringify({ limit: 0 }) });
  assert.equal(badLimit.status, 400);

  const collected = await fetch(`${root}/details/collect`, { method: "POST" });
  assert.equal(collected.status, 200);
  const run = await collected.json();
  assert.equal(run.succeeded, 3);

  const items = await fetch(`${root}/items`);
  const payload = await items.json();
  assert.ok(payload.items.every((item) => item.detailAuthor === "接口作者"));
  assert.ok(payload.items.every((item) => item.detailSourceUrl));

  const retried = await fetch(`${root}/details/retry`, { method: "POST", body: JSON.stringify({}) });
  assert.equal(retried.status, 200);
  assert.equal((await retried.json()).retried, 0);

  const missingFeed = await fetch("http://127.0.0.1:" + address.port + "/v1/feeds/unknown/details");
  assert.equal(missingFeed.status, 404);
  const missingCollect = await fetch("http://127.0.0.1:" + address.port + "/v1/feeds/unknown/details/collect", { method: "POST" });
  assert.equal(missingCollect.status, 404);
});
