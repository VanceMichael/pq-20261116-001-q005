const ENTITY_MAP = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'],
  ["apos", "'"], ["nbsp", " "], ["mdash", "—"], ["hellip", "…"]
]);

const AUTHOR_META_KEYS = new Set(["author", "article:author", "twitter:creator"]);
const SUMMARY_META_KEYS = new Set(["description", "og:description", "twitter:description"]);
const AUTHOR_CLASS = /(?:^|[\s_\-:.])(?:author|byline)(?=[\s_\-:.]|$)/i;
const SUMMARY_CLASS = /(?:^|[\s_\-:.])(?:summary|abstract|intro|excerpt)(?=[\s_\-:.]|$)/i;

const AUTHOR_MAX = 200;
const SUMMARY_MAX = 2000;

export function extractDetail(html) {
  if (typeof html !== "string" || html.length === 0) throw new TypeError("detail HTML must be a non-empty string");
  if (html.length > 5_000_000) throw new RangeError("detail page exceeds 5 MB");
  const meta = scanMetaTags(html);
  const blocks = scanClassBlocks(html);
  return {
    author: cleanField(firstPresent(meta.author, blocks.author), AUTHOR_MAX),
    summary: cleanField(firstPresent(meta.summary, blocks.summary), SUMMARY_MAX)
  };
}

export function detailFingerprint({ author, summary }) {
  return createHash("sha256").update(JSON.stringify([author ?? null, summary ?? null]), "utf8").digest("hex");
}

function scanMetaTags(html) {
  const found = { author: null, summary: null };
  const pattern = /<meta\b[^>]*>/gi;
  let match;
  while ((match = pattern.exec(html)) && (!found.author || !found.summary)) {
    const attributes = parseAttributes(match[0]);
    const key = (attributes.name ?? attributes.property ?? "").toLowerCase();
    const content = attributes.content;
    if (!key || !content) continue;
    if (!found.author && AUTHOR_META_KEYS.has(key)) found.author = content;
    if (!found.summary && SUMMARY_META_KEYS.has(key)) found.summary = content;
  }
  return found;
}

function scanClassBlocks(html) {
  const found = { author: null, summary: null };
  const pattern = /<(?:span|div|p|section)\b[^>]*>[\s\S]{0,1200}?<\/(?:span|div|p|section)>/gi;
  let match;
  while ((match = pattern.exec(html)) && (!found.author || !found.summary)) {
    const openTagEnd = match[0].indexOf(">");
    const attributes = parseAttributes(match[0].slice(0, openTagEnd + 1));
    const className = attributes.class ?? "";
    if (!className) continue;
    const text = textContent(match[0].slice(openTagEnd + 1));
    if (!text) continue;
    if (!found.author && AUTHOR_CLASS.test(className)) found.author = text;
    if (!found.summary && SUMMARY_CLASS.test(className)) found.summary = text;
  }
  return found;
}

function parseAttributes(tag) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = pattern.exec(tag))) {
    const key = match[1].toLowerCase();
    if (!(key in attributes)) attributes[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function textContent(fragment) {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\s]+/g, " ")).trim();
}

function cleanField(value, maxLength) {
  if (typeof value !== "string") return null;
  const cleaned = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0) ?? null;
}

function decodeEntities(value) {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const number = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(number) && number > 0 && number <= 0x10ffff
        ? String.fromCodePoint(number)
        : "�";
    }
    return ENTITY_MAP.get(entity.toLowerCase()) ?? match;
  });
}

import { createHash } from "node:crypto";
