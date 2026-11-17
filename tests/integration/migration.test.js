import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NewsArchive } from "../../src/service/archive.js";
import { SCHEMA_V1, SCHEMA_VERSION } from "../../src/store/database.js";
import { page, standardItems, baseFeed, captureTime, detailPage, detailFetcher } from "../helpers.js";

async function makeV1Database(t) {
  const directory = await mkdtemp(join(tmpdir(), "news-archive-migration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, "archive.sqlite");
  const database = new DatabaseSync(filename);
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(SCHEMA_V1);
  database.exec("PRAGMA user_version = 1");
  database.prepare(`INSERT INTO feeds (feed_id, base_url, allowed_hosts_json, minimum_items, missing_threshold,
    last_accepted_at, last_item_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(baseFeed.feedId, baseFeed.baseUrl, JSON.stringify(baseFeed.allowedHosts), 3, 3,
      "2026-11-15T10:00:00.000Z", 1, "2026-11-15T09:00:00.000Z", "2026-11-15T10:00:00.000Z");
  database.prepare(`INSERT INTO captures (capture_id, feed_id, fingerprint, captured_at, accepted, candidate_count,
    normalized_count, rejected_count, duplicate_count, reason) VALUES (1, ?, 'legacy-fingerprint', ?, 1, 1, 1, 0, 0, NULL)`)
    .run(baseFeed.feedId, "2026-11-15T10:00:00.000Z");
  database.prepare(`INSERT INTO articles (feed_id, canonical_url, title, published_at, first_seen_at, last_seen_at,
    seen_count, missing_streak, visibility, review_state, review_revision)
    VALUES (?, ?, ?, NULL, ?, ?, 1, 0, 'visible', 'confirmed', 2)`)
    .run(baseFeed.feedId, "https://news.example.test/2026/11-15/legacy.shtml", "旧稿",
      "2026-11-15T09:00:00.000Z", "2026-11-15T10:00:00.000Z");
  database.prepare("INSERT INTO capture_items (capture_id, article_id, source_index) VALUES (1, 1, 0)").run();
  database.prepare(`INSERT INTO review_events (article_id, prior_state, next_state, note, revision, changed_at)
    VALUES (1, 'unreviewed', 'confirmed', 'legacy note', 2, '2026-11-15T10:00:00.000Z')`).run();
  database.close();
  return filename;
}

test("migrates a version 1 archive and keeps list, review and new detail behavior working", async (t) => {
  const filename = await makeV1Database(t);
  const fetcher = detailFetcher(() => ({ html: detailPage({ author: "迁移作者", summary: "迁移摘要" }) }));
  const archive = new NewsArchive(filename, { clock: () => new Date("2026-11-16T02:00:01.000Z"), fetcher });
  t.after(() => archive.close());

  assert.equal(archive.database.prepare("PRAGMA user_version").get().user_version, SCHEMA_VERSION);
  const status = archive.feedStatus("daily-main");
  assert.equal(status.lastAcceptedAt, "2026-11-15T10:00:00.000Z");
  assert.equal(status.statistics.total, 1);
  assert.equal(status.details.total, 0);

  const legacy = archive.listItems("daily-main").items[0];
  assert.equal(legacy.title, "旧稿");
  assert.equal(legacy.reviewState, "confirmed");
  assert.equal(legacy.detailAuthor, null);
  assert.equal(legacy.detailObtainedAt, null);

  const conflict = archive.reviewArticle("daily-main", legacy.articleId, { state: "withdrawn", expectedRevision: 1 });
  assert.equal(conflict.status, 409);
  const reviewed = archive.reviewArticle("daily-main", legacy.articleId, { state: "withdrawn", expectedRevision: 2 });
  assert.equal(reviewed.status, 200);
  assert.equal(archive.reviewEvents("daily-main", legacy.articleId).events.length, 2);

  const imported = archive.importSnapshot("daily-main", page(standardItems(3)), captureTime(1));
  assert.equal(imported.accepted, true);
  assert.equal(imported.details.enqueued, 3);
  const collected = await archive.collectDetails("daily-main");
  assert.equal(collected.succeeded, 3);
  assert.ok(archive.listItems("daily-main").items
    .filter((item) => item.title.startsWith("标题"))
    .every((item) => item.detailAuthor === "迁移作者"));
  assert.equal(archive.auditIntegrity().status, "consistent");
});
