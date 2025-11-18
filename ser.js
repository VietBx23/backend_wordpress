// server.js
import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const app = express();

// ---------------- CONFIG ----------------
const BASE_STORE_URL = "https://www.tadu.com/store/98-a-0-15-a-20-p-{page}-909";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TaduHybrid/1.0)" };
const MAX_BOOK_WORKERS = 15;
const MAX_CHAPTER_WORKERS = 10;

// ---------------- SAFE GET ----------------
async function safeGet(url, retries = 2, sleepMs = 100) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      return resp.data;
    } catch (err) {
      console.warn(`[Lỗi mạng] ${err.message} (thử ${attempt}/${retries})`);
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }
  throw new Error(`Không thể truy cập ${url} sau ${retries} lần`);
}

// ---------------- LẤY DANH SÁCH BOOK ----------------
async function getBookIds(page) {
  const url = BASE_STORE_URL.replace("{page}", page);
  console.log(`Lấy danh sách book page ${page}`);
  const html = await safeGet(url);
  const $ = cheerio.load(html);
  const ids = new Set();

  $("a.bookImg[href]").each((i, el) => {
    const m = $(el).attr("href").match(/\/book\/(\d+)\//);
    if (m) ids.add(m[1]);
  });

  console.log(`Tìm thấy ${ids.size} book trên page ${page}`);
  return Array.from(ids).sort();
}

// ---------------- LẤY THÔNG TIN BOOK ----------------
async function crawlBookInfo(bookId) {
  const url = `https://www.tadu.com/book/${bookId}/`;
  console.log(`Crawl info book ${bookId}`);
  const html = await safeGet(url);
  const $ = cheerio.load(html);

  const title = $("a.bkNm[data-name]").attr("data-name") || "";
  const author = $("span.author").text().trim() || "";
  
  let img_url = $("img[data-src]").attr("data-src") || $("img").attr("src") || "";
  if (img_url.startsWith("//")) img_url = "https:" + img_url;
  else if (img_url.startsWith("/")) img_url = "https://www.tadu.com" + img_url;
  if (!img_url) img_url = $('meta[property="og:image"]').attr("content") || "";

  const description = $("p.intro").text().trim() || "";

  const genres = [];
  $("div.sortList a").each((i, el) => genres.push($(el).text().trim()));

  return { id: bookId, title, author, cover_image: img_url, description, genres, url };
}

// ---------------- LẤY CHƯƠNG ----------------
async function crawlChapterTitle(bookId, chapterIndex) {
  const url = `https://www.tadu.com/book/${bookId}/${chapterIndex}/?isfirstpart=true`;
  const html = await safeGet(url);
  const $ = cheerio.load(html);
  const h4s = $("h4");
  if (h4s.length >= 2) return $(h4s[1]).text().trim();
  else if (h4s.length >= 1) return $(h4s[0]).text().trim();
  return `Chương ${chapterIndex}`;
}

async function crawlChapterContent(bookId, chapterIndex) {
  const apiUrl = `https://www.tadu.com/getPartContentByCodeTable/${bookId}/${chapterIndex}`;
  try {
    const data = await safeGet(apiUrl);
    if (data.status !== 200) {
      console.warn(`Chapter ${chapterIndex} book ${bookId} trả về status ${data.status}`);
      return "";
    }
    const $ = cheerio.load(data.data.content || "");
    return $.text().replace(/\r/g, "");
  } catch (err) {
    console.error(`Lỗi lấy content chapter ${chapterIndex} book ${bookId}: ${err.message}`);
    return "";
  }
}

async function crawlFirstNChapters(bookId, n) {
  const limit = pLimit(MAX_CHAPTER_WORKERS);
  const chapters = await Promise.all(
    Array.from({ length: n }, (_, i) => i + 1).map(i =>
      limit(async () => {
        const title = await crawlChapterTitle(bookId, i);
        const content = await crawlChapterContent(bookId, i);
        console.log(`Hoàn tất chapter ${i} book ${bookId}`);
        return { index: i, title, content };
      })
    )
  );
  return chapters;
}

// ---------------- API ----------------
app.get("/", (req, res) => res.send("✅ Tadu Crawler Node.js đang hoạt động!"));

app.get("/crawl", async (req, res) => {
  const pageNum = parseInt(req.query.page || "1");
  const numChapters = parseInt(req.query.num_chapters || "5");

  try {
    const bookIds = await getBookIds(pageNum);
    if (!bookIds.length) return res.status(404).json({ error: "Không tìm thấy book nào" });

    const limit = pLimit(MAX_BOOK_WORKERS);
    const results = await Promise.allSettled(
      bookIds.map(bookId => limit(async () => {
        const info = await crawlBookInfo(bookId);
        info.chapters = await crawlFirstNChapters(bookId, numChapters);
        console.log(`Hoàn tất crawl book ${bookId}`);
        return info;
      }))
    );

    const successResults = results.filter(r => r.status === "fulfilled").map(r => r.value);
    res.json({ results: successResults });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(8080, () => console.log("Server chạy tại http://localhost:8080"));
