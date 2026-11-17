import test from "node:test";
import assert from "node:assert/strict";
import { extractDetail, detailFingerprint } from "../../src/feed/detail.js";

test("extracts author and summary from standard meta tags", () => {
  const html = `<html><head>
    <meta name="author" content="张三">
    <meta name="description" content="这是一条摘要。">
    </head><body></body></html>`;
  assert.deepEqual(extractDetail(html), { author: "张三", summary: "这是一条摘要。" });
});

test("prefers open graph and property variants when name tags are absent", () => {
  const html = `<html><head>
    <meta property="article:author" content="李四">
    <meta property="og:description" content="OG 摘要">
    </head></html>`;
  assert.deepEqual(extractDetail(html), { author: "李四", summary: "OG 摘要" });
});

test("falls back to class-marked blocks and decodes entities", () => {
  const html = `<html><body>
    <span class="byline">王五 &amp; 赵六</span>
    <p class="article-summary">摘要&nbsp;含<b>标记</b></p>
    </body></html>`;
  const detail = extractDetail(html);
  assert.equal(detail.author, "王五 & 赵六");
  assert.equal(detail.summary, "摘要 含 标记");
});

test("normalizes whitespace and caps overly long fields", () => {
  const longSummary = `长${"很".repeat(3000)}`;
  const html = `<meta name="author" content="  作者\n  名  "><meta name="description" content="${longSummary}">`;
  const detail = extractDetail(html);
  assert.equal(detail.author, "作者 名");
  assert.equal(detail.summary.length, 2000);
});

test("returns null fields when the page carries no usable detail markers", () => {
  assert.deepEqual(extractDetail("<html><body><p>plain</p></body></html>"), { author: null, summary: null });
});

test("rejects empty or oversized detail pages", () => {
  assert.throws(() => extractDetail(""), TypeError);
  assert.throws(() => extractDetail("x".repeat(5_000_001)), RangeError);
});

test("fingerprints identical field sets identically and distinguishes changes", () => {
  const base = detailFingerprint({ author: "张三", summary: "摘要" });
  assert.equal(base, detailFingerprint({ author: "张三", summary: "摘要" }));
  assert.notEqual(base, detailFingerprint({ author: "张三", summary: "另一个摘要" }));
  assert.notEqual(base, detailFingerprint({ author: "张三", summary: null }));
});
