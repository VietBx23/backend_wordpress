import express from 'express';
import { chromium } from 'playwright';
import dotenv from 'dotenv';
dotenv.config(); // Load biến môi trường từ .env
const app = express();

const BASE_URL = 'https://www.writerworking.net';

// --- Tối ưu: số trang song song ---
const MAX_BOOK_TABS = 24;    // số truyện crawl cùng lúc
const MAX_CHAPTER_TABS = 20; // số chương crawl cùng lúc

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Crawl nội dung 1 chương (lấy title + content) ---
async function crawlChapterContent(context, chapterUrl) {
    const page = await context.newPage();
    await page.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image','stylesheet','font','media'].includes(type)) route.abort();
        else route.continue();
    });

    let content = '';
    let title = '';
    try {
        console.log(`[Chapter] Crawl: ${chapterUrl}`);
        await page.goto(chapterUrl, { timeout: 30000 });

        const data = await page.evaluate(() => {
            const div = document.querySelector("#booktxthtml");
            const content = div
                ? Array.from(div.querySelectorAll("p"))
                      .map(p => p.innerText.trim())
                      .filter(t => t.length > 0)
                      .join("\n")
                : '';

            // Lấy title chương: ưu tiên h1, nếu không có lấy document.title
            let titleText = '';
            const h1 = document.querySelector("h1");
            if (h1) {
                titleText = h1.innerText.trim();
            } else if (document.title) {
                titleText = document.title.trim();
            }

            // Bỏ phần trong ngoặc (), （）
            titleText = titleText.replace(/[\(\（].*?[\)\）]/g, '').trim();

            return { content, title: titleText };
        });

        content = data.content;
        title = data.title;

    } catch (e) {
        console.log(`[Chapter] Lỗi: ${chapterUrl}`, e);
    } finally {
        await page.close();
    }

    return { content, title };
}

// --- Crawl N chương song song ---
async function crawlChapters(context, bookId, numChapters = 20) {
    const xsUrl = `${BASE_URL}/xs/${bookId}/1/`;
    const page = await context.newPage();
    let chapters = [];

    try {
        await page.goto(xsUrl, { timeout: 30000 });
        chapters = await page.evaluate(({num, baseUrl}) => {
            const lis = Array.from(document.querySelectorAll("div.all ul li")).slice(0, num);
            return lis.map(li => {
                const a = li.querySelector("a");
                if (!a) return null;
                const onclick = a.getAttribute("onclick") || "";
                const match = onclick.match(/location\.href='(.*?)'/);
                const url = match ? match[1] : null;
                return { url: url ? baseUrl + url.replace(/\\/g, "") : null };
            }).filter(x => x);
        }, { num: numChapters, baseUrl: BASE_URL });
    } catch (e) {
        console.log(`[Chapters] Lỗi crawl list: ${xsUrl}`, e);
    } finally {
        await page.close();
    }

    // Crawl chương song song tối đa MAX_CHAPTER_TABS
    for (let i = 0; i < chapters.length; i += MAX_CHAPTER_TABS) {
        const batch = chapters.slice(i, i + MAX_CHAPTER_TABS).map(ch =>
            ch.url ? crawlChapterContent(context, ch.url) : Promise.resolve({ content: "", title: "" })
        );
        const results = await Promise.all(batch);
        results.forEach((res, idx) => {
            chapters[i + idx].content = res.content;
            chapters[i + idx].title = res.title;  // Lưu title
        });
    }

    return chapters;
}

// --- Crawl chi tiết truyện ---
async function crawlBookDetail(context, bookUrl) {
    const page = await context.newPage();
    let author = '';
    let genres = '';
    try {
        console.log(`[BookDetail] Crawl: ${bookUrl}`);
        await page.goto(bookUrl, { timeout: 30000 });
        const data = await page.evaluate(() => {
            let authorText = '';
            const authorP = Array.from(document.querySelectorAll("p"))
                                .find(p => p.querySelector("b")?.innerText.trim() === "作者：");
            if (authorP) {
                const a = authorP.querySelector("a");
                if (a) authorText = a.innerText.trim();
            }
            let genreText = '';
            const ol = document.querySelector("ol.container");
            if (ol && ol.querySelectorAll("li").length >= 2) {
                genreText = ol.querySelectorAll("li")[1].innerText.trim();
            }
            return { author: authorText, genres: genreText };
        });
        author = data.author;
        genres = data.genres;
        console.log(`[BookDetail] Hoàn tất: Tác giả=${author}, Thể loại=${genres}`);
    } catch (e) {
        console.log(`[BookDetail] Lỗi crawl: ${bookUrl}`, e);
    } finally {
        await page.close();
    }
    return { author, genres };
}

// --- Crawl truyện song song ---
async function crawlBooks(browser, pageNum = 1, numChapters = 20) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/ben/all/${pageNum}/`, { timeout: 30000 });

    let books = await page.evaluate(() => {
        return Array.from(document.querySelectorAll("dl"))
            .filter(dl => !dl.closest('div.right.hidden-xs'))
            .map(dl => {
                const a = dl.querySelector("dt a");
                const img = dl.querySelector("a.cover img");
                const desc = dl.querySelector("dd");
                const bookIdMatch = a ? a.getAttribute("href").match(/\/kanshu\/(\d+)\//) : null;
                return {
                    url: a ? (a.href.startsWith('http') ? a.href : BASE_URL + a.getAttribute('href')) : null,
                    bookId: bookIdMatch ? bookIdMatch[1] : null,
                    title: a?.title || a?.innerText,
                    author: '',
                    cover_image: img ? (img.getAttribute('data-src') || img.getAttribute('src')) : null,
                    description: desc ? desc.innerText.trim() : '',
                    genres: [],
                    chapters: []
                };
            });
    });
    await page.close();

    const results = [];
    for (let i = 0; i < books.length; i += MAX_BOOK_TABS) {
        const batch = books.slice(i, i + MAX_BOOK_TABS).map(async book => {
            if (book.url && book.bookId) {
                console.log(`[Book] Crawl: ${book.title}`);
                const detail = await crawlBookDetail(context, book.url);
                book.author = detail.author || '';
                book.genres = detail.genres ? [detail.genres] : [];
                book.chapters = await crawlChapters(context, book.bookId, numChapters);
                console.log(`[Book] Hoàn tất: ${book.title}`);
            }
            return book;
        });
        results.push(...await Promise.all(batch));
    }

    await context.close();
    return results;
}

// --- Routes ---
app.get('/', (req, res) => {
    res.send('API is working. Use /crawl?page=1&num_chapters=5');
});

app.get('/crawl', async (req, res) => {
    const pageNum = parseInt(req.query.page) || 1;
    const numChapters = parseInt(req.query.num_chapters) || 5;
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        const books = await crawlBooks(browser, pageNum, numChapters);
        res.json({ results: books });
    } catch (e) {
        res.status(500).json({ error: e.toString() });
    } finally {
        await browser.close();
    }
});


const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

