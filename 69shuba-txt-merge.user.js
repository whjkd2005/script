// ==UserScript==
// @name         69书吧 - 合并下载TXT（独立版）
// @namespace    http://tampermonkey.net/
// @version      1.0.0
// @description  独立脚本：把整本书或指定章节区间合并导出为单个 TXT；不注入任何阅读样式、不接管方向键，可与「文章样式优化+左右键翻页」原脚本同时安装
// @author       You
// @match        https://69shuba.tw/*
// @match        https://www.69shuba.tw/*
// @match        https://69shuba.cx/*
// @match        https://www.69shuba.cx/*
// @match        https://69shuba.com/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      69shuba.tw
// @connect      69shuba.cx
// @connect      69shuba.com
// @connect      *
// @noframes
// @run-at       document-end
// @license      允许其他人使用代码
// ==/UserScript==
(function () {
    'use strict';

    /* =========================================================================
     * 0. 兼容层
     * ========================================================================= */
    const addStyle = (css) => {
        if (typeof GM_addStyle === 'function') {
            try { return GM_addStyle(css); } catch (e) { /* ignore */ }
        }
        const s = document.createElement('style');
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
    };
    const store = {
        get(k, d) {
            try {
                if (typeof GM_getValue === 'function') return GM_getValue(k, d);
                const v = localStorage.getItem(k);
                return v == null ? d : JSON.parse(v);
            } catch (e) { return d; }
        },
        set(k, v) {
            try {
                if (typeof GM_setValue === 'function') GM_setValue(k, v);
                else localStorage.setItem(k, JSON.stringify(v));
            } catch (e) { /* ignore */ }
        }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

    /* =========================================================================
     * 3. 网络
     * ========================================================================= */
    const pending = new Set();

    function fetchText(url, timeout = 25000) {
        return new Promise((resolve, reject) => {
            if (typeof GM_xmlhttpRequest === 'function') {
                let handle = null;
                handle = GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    timeout,
                    headers: {
                        'Referer': location.href,
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    },
                    onload: (r) => {
                        pending.delete(handle);
                        if (r.status >= 200 && r.status < 400) resolve(r.responseText);
                        else reject(new Error('HTTP ' + r.status));
                    },
                    ontimeout: () => { pending.delete(handle); reject(new Error('请求超时')); },
                    onerror: () => { pending.delete(handle); reject(new Error('网络错误')); },
                    onabort: () => { pending.delete(handle); reject(new Error('已取消')); }
                });
                if (handle && typeof handle.abort === 'function') pending.add(handle);
            } else {
                fetch(url, { credentials: 'include' })
                    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
                    .then(resolve, reject);
            }
        });
    }

    function abortAll() {
        pending.forEach(h => { try { h.abort(); } catch (e) { /* ignore */ } });
        pending.clear();
    }

    /* =========================================================================
     * 4. 页面自带解密脚本的通用执行器
     *    —— 不逆向加密算法：用桩环境跑站点自己的脚本，捕获明文与导航 URL
     * ========================================================================= */
    const rev = (s) => s.split('').reverse().join('');
    function pickDecryptScript(html) {
        const list = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
        return list.find(s => /getElementById\("/.test(s) && /getAttribute\("/.test(s) && /\.join\(''\)/.test(s));
    }

    function extractMeta(html) {
        const s = pickDecryptScript(html);
        if (!s) return { err: '未找到解密脚本（可能是拦截页/改版）' };
        const id = (s.match(/getElementById\("([^"]+)"\)/) || [])[1];
        const attr = (s.match(/getAttribute\("([^"]+)"\)/) || [])[1];
        if (!id || !attr) return { err: '解密脚本结构变化' };
        const elM = html.match(new RegExp('id="' + id + '"[^>]*?' + attr + '="([^"]*)"')) ||
                    html.match(new RegExp(attr + '="([^"]*)"[^>]*?id="' + id + '"'));
        return { script: s, id, attr, attrValue: elM ? elM[1] : '' };
    }

    function countChapterItems(html) {
        const spans = html.match(/<li[^>]*>\s*<span[^>]*class="[^"]*ch-item[^"]*"/g);
        if (spans) return spans.length;
        const ul = html.match(/<ul[^>]*class="[^"]*last9[^"]*"[\s\S]*?<\/ul>/);
        if (!ul) return 0;
        return (ul[0].match(/<span/g) || []).length;
    }

    function runPage(html, opts) {
        opts = opts || {};
        const m = extractMeta(html);
        if (m.err) return { err: m.err };

        const result = { decrypted: '', navUrls: [], itemUrls: [], urls: [] };
        const clicks = [];
        const cache = new Map();
        const itemCount = opts.itemCount || 0;
        let items = null;
        let rootEl = null;

        function mkEl(tag, meta) {
            const el = {
                nodeName: (tag || 'div').toUpperCase(),
                attributes: [],
                textContent: '',
                firstChild: null,
                dataset: {},
                parentNode: { insertBefore() {}, removeChild() {}, appendChild() {}, parentNode: null },
                classList: {
                    contains: (c) => !!(meta && meta.classes && meta.classes.indexOf(c) >= 0),
                    add() {}, remove() {}
                },
                getAttribute: (n) => (n === m.attr ? m.attrValue : null),
                setAttribute() {},
                removeAttribute() {},
                appendChild() {},
                removeChild() {},
                insertBefore() {},
                querySelector: () => null,
                querySelectorAll: (sel) => {
                    if (itemCount && meta && meta.role === 'root' && typeof sel === 'string' && sel.charAt(0) === '.') {
                        if (!items) {
                            items = Array.from({ length: itemCount }, (_, i) => mkEl('span', { classes: [sel.slice(1)], idx: i }));
                        }
                        return items;
                    }
                    return [];
                },
                addEventListener: (type, fn) => { if (type === 'click') clicks.push({ el, fn }); },
                removeEventListener() {}
            };
            let inner = '';
            Object.defineProperty(el, 'innerHTML', {
                get: () => inner,
                set: (v) => {
                    inner = v;
                    if (typeof v === 'string' && v.length > result.decrypted.length) result.decrypted = v;
                }
            });
            return el;
        }

        const doc = {
            getElementById: (x) => {
                if (x !== m.id) return null;
                if (!rootEl) rootEl = mkEl('ul', { role: 'root' });
                return rootEl;
            },
            querySelector: () => null,
            querySelectorAll: (sel) => {
                if (!cache.has(sel)) cache.set(sel, [mkEl('a')]);
                return cache.get(sel);
            },
            createElement: (t) => mkEl(t),
            createDocumentFragment: () => mkEl('fragment'),
            addEventListener() {},
            currentScript: null
        };

        const win = {
            location: {
                _href: '',
                get href() { return this._href; },
                set href(v) { this._href = v; result.urls.push(v); },
                assign(v) { result.urls.push(v); }
            },
            open: (v) => result.urls.push(v),
            addEventListener() {},
            __emuErr: null
        };

        const patched = m.script.replace(/catch\s*\(\s*(\w+)\s*\)\s*\{\s*\}/, 'catch($1){window.__emuErr=$1&&$1.message;}');

        try {
            // eslint-disable-next-line no-new-func
            new Function('document', 'window', 'atob', 'btoa', 'Uint8Array', 'TextDecoder', 'String', patched)(
                doc, win, window.atob, window.btoa, Uint8Array, TextDecoder, String
            );
        } catch (e) {
            result.error = e.message;
        }
        if (win.__emuErr) result.innerError = win.__emuErr;

        const fire = (fn, target) => {
            const before = result.urls.length;
            try {
                fn({
                    isTrusted: true, preventDefault() {}, stopPropagation() {},
                    ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
                    button: 0, key: '', keyCode: 0, target, currentTarget: target
                });
            } catch (e) { /* ignore */ }
            return result.urls.slice(before);
        };

        if (!itemCount) {
            clicks.forEach(({ fn, el }) => {
                const got = fire(fn, el);
                if (got.length) result.navUrls.push(got[got.length - 1]);
            });
        } else {
            clicks.forEach(({ fn }) => {
                for (let i = 0; i < itemCount; i++) {
                    const got = fire(fn, items[i]);
                    if (got.length) result.itemUrls.push(got[got.length - 1]);
                }
            });
        }
        return result;
    }

    /* =========================================================================
     * 5. 文本处理
     * ========================================================================= */
    const decodeEntities = (s) => s
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');

    const AD_LINE = [
        /^(69\s*书吧|69書吧|69shuba)/i,
        /请记住本站|本站域名|请收藏本站|一秒记住|记住网址|手机阅读|电脑阅读/,
        /本章未完|点击下一页|继续阅读|请翻页|下一页继续/,
        /^(上一章|下一章|目录|返回目录|加入书签|加入書架|返回书页|书末页|书末頁)$/,
        /^https?:\/\//i,
        /^(广告|廣告)\b/,
        /章节错误|求月票|求推荐票|举报/
    ];
    const isAdLine = (s) => AD_LINE.some(re => re.test(s));

    function cleanTitle(t) {
        return decodeEntities(String(t || '')
            .replace(/<[^>]+>/g, '')
            .replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, '')
            .replace(/\s+/g, ' ')).trim();
    }

    function parseTocTitles(html) {
        const out = [];
        const re = /<li[^>]*>\s*<span[^>]*class="[^"]*ch-item[^"]*"[^>]*>([\s\S]*?)<\/span>/g;
        let m;
        while ((m = re.exec(html))) out.push(cleanTitle(m[1]));
        return out;
    }

    function extractPageTitle(html) {
        const m = html.match(/<h1[^>]*id="nr_title"[^>]*>([\s\S]*?)<\/h1>/) ||
                  html.match(/<h1[^>]*class="[^"]*nr_title[^"]*"[^>]*>([\s\S]*?)<\/h1>/);
        return m ? cleanTitle(m[1]) : '';
    }

    function htmlToLines(decryptedHtml) {
        const doc = new DOMParser().parseFromString(
            '<div id="__txt_root">' + decryptedHtml + '</div>', 'text/html'
        );
        const root = doc.getElementById('__txt_root');
        if (!root) return [];
        root.querySelectorAll('script, style, ins, iframe, noscript, form, button, .reader-ad, .adsbygoogle, [id*="ad-"], [class*="advert"]')
            .forEach(n => n.remove());

        const norm = (s) => String(s || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t\u3000]+/g, ' ')
            .trim();

        let lines = [];
        const ps = root.querySelectorAll('p');
        if (ps.length >= 2) {
            lines = [...ps].map(p => norm(p.textContent));
        } else {
            root.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
            root.querySelectorAll('div, li, h1, h2, h3').forEach(el => el.appendChild(doc.createTextNode('\n')));
            lines = String(root.textContent || '').split(/\r?\n/).map(norm);
        }
        return lines.filter(l => {
            if (!l) return false;
            if (isAdLine(l)) return false;
            // 丢掉只有标点的碎片段落
            if (l.length <= 2 && !/[\u4e00-\u9fa5A-Za-z0-9]/.test(l)) return false;
            return true;
        });
    }

    /* =========================================================================
     * 6. 业务：目录 / 章节 / 导出
     * ========================================================================= */
    const ORIGIN = location.origin;

    const state = {
        running: false,
        paused: false,
        cancel: false,
        bookId: null,
        bookName: '',
        author: '',
        toc: [],
        cache: new Map(),   // url -> {title, lines}
        ok: 0,
        fail: []
    };

    function detectContext() {
        const m = location.pathname.match(/^\/(?:read|book|indexlist)\/(\d+)\//) ||
                  location.pathname.match(/^\/(\d+)\//);
        if (m) state.bookId = m[1];
        const c = location.pathname.match(/^\/read\/\d+\/(\d+)/);
        state.currentChapterId = c ? c[1] : null;
    }

    function parseBookMeta(html) {
        const t = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const bm = t.match(/《([^》]+)》/);
        if (bm) state.bookName = bm[1].trim();
        if (!state.bookName) {
            const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
            state.bookName = cleanTitle(h1) || ('book-' + state.bookId);
        }
        const am = html.match(/作\s*者[：:]\s*(?:<a[^>]*>)?([^<\n]{1,40})/);
        if (am) state.author = decodeEntities(am[1]).trim();
    }

    const toAbs = (u) => (/^https?:/i.test(u) ? u : ORIGIN + u);

    async function buildToc(onStep) {
        const bookId = state.bookId;
        if (!bookId) throw new Error('无法识别书号，请在书籍目录页或阅读页使用');
        const toc = [];
        state.toc = toc;
        const seen = new Set();
        let lastTitles = '';

        for (let page = 1; page <= 300; page++) {
            if (state.cancel) throw new Error('已取消');
            const url = page === 1
                ? `${ORIGIN}/indexlist/${bookId}/`
                : `${ORIGIN}/indexlist/${bookId}/${page}/`;
            const html = await fetchText(url);
            if (page === 1) parseBookMeta(html);

            const titles = parseTocTitles(html);
            const res = runPage(html, { itemCount: titles.length });
            const urls = res.itemUrls || [];
            const got = Math.min(urls.length, titles.length);
            if (!got) break;

            let fresh = 0;
            for (let i = 0; i < got; i++) {
                const abs = toAbs(urls[i]);
                if (seen.has(abs)) continue;
                seen.add(abs);
                toc.push({
                    idx: toc.length + 1,
                    title: titles[i] || ('第' + (toc.length + 1) + '章'),
                    url: abs
                });
                fresh++;
            }
            onStep && onStep(page, toc.length, fresh);
            state.toc = toc;      // 增量保存，取消/失败时已抓到的目录不丢
            const stamp = titles.join('|');
            if (fresh === 0 || stamp === lastTitles) break;   // 翻到越界页会重复上一页内容
            lastTitles = stamp;
        }

        state.toc = toc;
        return toc;
    }

    async function fetchChapter(ch) {
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (state.cancel) throw new Error('已取消');
            try {
                const html = await fetchText(ch.url);
                const res = runPage(html);
                if (!res.decrypted) {
                    throw new Error(res.innerError || res.error || '正文为空（可能被拦截）');
                }
                const pageTitle = extractPageTitle(html);
                let lines = htmlToLines(res.decrypted);
                if (!lines.length) throw new Error('正文为空（可能被拦截）');

                // 超长章节可能分页：尝试补抓后续页
                const sp = pageTitle.match(/\(\s*(\d+)\s*\/\s*(\d+)\s*\)/);
                if (sp && +sp[2] > 1) {
                    const extra = await fetchSplitPages(html, ch.url, +sp[2]);
                    extra.forEach(arr => { lines = lines.concat(arr); });
                }
                return { title: pageTitle.replace(/\(\s*\d+\s*\/\s*\d+\s*\)/g, '').trim() || ch.title, lines };
            } catch (e) {
                lastErr = e;
                await sleep(700 * attempt + Math.random() * 500);
            }
        }
        throw lastErr || new Error('抓取失败');
    }

    async function fetchSplitPages(html, baseUrl, total) {
        const out = [];
        // 站点分页通常是 /read/<bid>/<cid>_2 或 ?p=2，这里按出现顺序尝试
        const cands = [];
        const re = /href="([^"]*(?:[?&]p=|_\d+|\/\d+\/?)[^"]*)"/g;
        let m;
        while ((m = re.exec(html))) {
            const u = m[1];
            if (!/\/read\//.test(u)) continue;
            if (u === baseUrl) continue;
            if (!/_(\d+)/.test(u) && !/[?&]p=(\d+)/.test(u)) continue;
            cands.push(toAbs(u));
        }
        const uniq = [...new Set(cands)].slice(0, total - 1);
        for (const u of uniq) {
            if (state.cancel) break;
            try {
                const h = await fetchText(u);
                const r = runPage(h);
                if (r.decrypted) out.push(htmlToLines(r.decrypted));
            } catch (e) { /* ignore */ }
            await sleep(jitter(500));
        }
        return out;
    }

    async function download(list, opts) {
        state.running = true;
        state.cancel = false;
        state.paused = false;
        state.ok = 0;
        state.fail = [];

        const total = list.length;
        let done = 0;
        let cursor = 0;

        const worker = async () => {
            for (;;) {
                if (state.cancel) return;
                while (state.paused && !state.cancel) await sleep(200);
                const i = cursor++;
                if (i >= total) return;
                const ch = list[i];
                if (state.cache.has(ch.url)) {
                    done++;
                    UI.progress(done, total);
                    continue;
                }
                try {
                    const rec = await fetchChapter(ch);
                    state.cache.set(ch.url, rec);
                    state.ok++;
                    UI.log('✓ ' + ch.title);
                } catch (e) {
                    state.fail.push({ ch, err: e.message });
                    UI.log('✗ ' + ch.title + ' — ' + e.message);
                }
                done++;
                UI.progress(done, total);
                if (done < total) await sleep(jitter(opts.delay));
            }
        };

        const n = Math.max(1, Math.min(4, opts.concurrency || 2));
        await Promise.all(Array.from({ length: n }, worker));
        state.running = false;
        return { ok: state.ok, fail: state.fail.length, total };
    }

    function buildText(list, opts) {
        const parts = [];
        const a = list[0] ? list[0].idx : 0;
        const b = list.length ? list[list.length - 1].idx : 0;
        const head = [
            '书名：' + (state.bookName || ''),
            state.author ? '作者：' + state.author : null,
            '来源：' + (state.bookId ? ORIGIN + '/book/' + state.bookId + '/' : location.href),
            '导出：' + new Date().toLocaleString('zh-CN'),
            '章节：第 ' + a + ' - ' + b + ' 章（共 ' + list.length + ' 章）',
            '='.repeat(40)
        ].filter(Boolean).join('\n');
        parts.push(head);

        list.forEach((ch) => {
            const rec = state.cache.get(ch.url);
            if (!rec) return;
            let block = '';
            if (opts.includeTitle) block += (rec.title || ch.title) + '\n\n';
            block += rec.lines.map(l => (opts.indent ? '\u3000\u3000' + l : l)).join('\n');
            parts.push(block);
        });
        return parts.join('\n\n\n') + '\n';
    }

    function saveText(filename, text) {
        const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 20000);
    }

    const safeName = (s) => String(s || 'book').replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(0, 80);

    /* =========================================================================
     * 7. 面板 UI
     * ========================================================================= */
    addStyle(`
        #txtdl-fab {
            position: fixed; right: 18px; bottom: 96px; z-index: 2147483600;
            width: 52px; height: 52px; border-radius: 50%;
            background: #2f6fed; color: #fff; border: none; cursor: pointer;
            font: 700 13px/1.1 "Microsoft YaHei", sans-serif;
            box-shadow: 0 4px 14px rgba(0,0,0,.28);
        }
        #txtdl-fab:hover { background: #255fd0; }

        #txtdl-panel {
            position: fixed; right: 18px; bottom: 18px; z-index: 2147483601;
            width: 348px; max-height: 78vh; display: none; flex-direction: column;
            background: #fff; color: #222; border: 1px solid #bbb; border-radius: 10px;
            box-shadow: 0 10px 32px rgba(0,0,0,.26); overflow: hidden;
            font: 13px/1.6 "Microsoft YaHei", -apple-system, sans-serif;
        }
        #txtdl-panel.open { display: flex; }
        #txtdl-head {
            display: flex; align-items: center; gap: 8px; padding: 8px 10px;
            background: #f4f5f7; border-bottom: 1px solid #ddd; cursor: move; user-select: none;
        }
        #txtdl-head b { flex: 1; font-size: 13px; font-weight: 700; }
        #txtdl-head button {
            border: none; background: transparent; cursor: pointer; font-size: 16px; line-height: 1;
            color: #555; padding: 2px 4px;
        }
        .txtdl-body { padding: 10px; overflow: auto; }
        .txtdl-book { font-weight: 700; color: #2f6fed; margin-bottom: 4px; word-break: break-all; }
        .txtdl-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
        .txtdl-row > label { flex: 0 0 62px; color: #444; }
        .txtdl-row input[type=number] {
            width: 68px; padding: 3px 5px; border: 1px solid #ccc; border-radius: 4px; font: inherit;
        }
        .txtdl-row .sep { color: #999; }
        .txtdl-chk { display: flex; gap: 12px; flex-wrap: wrap; margin: 8px 0; }
        .txtdl-chk label { display: flex; align-items: center; gap: 4px; color: #444; }
        #txtdl-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 4px; }
        #txtdl-actions button {
            flex: 1 1 46%; padding: 7px 4px; border: 1px solid #bbb; border-radius: 6px;
            background: #fafafa; cursor: pointer; font: inherit;
        }
        #txtdl-actions button:hover { background: #f0f0f0; }
        #txtdl-actions button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
        #txtdl-actions button.primary:hover { background: #255fd0; }
        #txtdl-actions button:disabled { opacity: .45; cursor: not-allowed; }
        #txtdl-bar { height: 8px; background: #eceef1; border-radius: 4px; overflow: hidden; margin: 8px 0 4px; }
        #txtdl-bar > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,#2f6fed,#39b0ff); transition: width .2s; }
        #txtdl-stat { font-size: 12px; color: #666; }
        #txtdl-log {
            height: 108px; overflow: auto; margin-top: 6px; padding: 6px 8px; border-radius: 5px;
            background: #1e1f22; color: #cfd3d8; white-space: pre-wrap; word-break: break-all;
            font: 11px/1.5 Consolas, "Courier New", monospace;
        }
    `);

    const UI = {
        panel: null,
        els: {},
        log(line) {
            const box = this.els.log;
            if (!box) return;
            box.textContent += (box.textContent ? '\n' : '') + line;
            const lines = box.textContent.split('\n');
            if (lines.length > 250) box.textContent = lines.slice(-250).join('\n');
            box.scrollTop = box.scrollHeight;
        },
        progress(done, total) {
            const el = this.els;
            if (!el.bar) return;
            const pct = total ? Math.round(done / total * 100) : 0;
            el.bar.style.width = pct + '%';
            el.stat.textContent = `进度 ${done}/${total}（${pct}%）成功 ${state.ok} 失败 ${state.fail.length}`;
        },
        setBusy(busy) {
            const el = this.els;
            el.btnLoad.disabled = busy;
            el.btnStart.disabled = busy;
            el.btnPause.disabled = !busy;
            el.btnExport.disabled = busy;
        },
        toggle(force) {
            const p = this.panel;
            if (!p) return;
            const open = typeof force === 'boolean' ? force : !p.classList.contains('open');
            p.classList.toggle('open', open);
        }
    };

    function buildPanel() {
        if (document.getElementById('txtdl-panel')) return;

        const fab = document.createElement('button');
        fab.id = 'txtdl-fab';
        fab.textContent = 'TXT';
        fab.title = '合并下载本书为 TXT（Alt+S）';
        fab.addEventListener('click', () => UI.toggle());

        const panel = document.createElement('div');
        panel.id = 'txtdl-panel';
        panel.innerHTML = `
            <div id="txtdl-head">
                <b>合并下载 TXT</b>
                <button data-act="min" title="收起">—</button>
                <button data-act="close" title="关闭">×</button>
            </div>
            <div class="txtdl-body">
                <div class="txtdl-book" id="txtdl-book">未识别书籍</div>
                <div class="txtdl-row">
                    <label>章节</label>
                    <input type="number" id="txtdl-from" min="1" value="1">
                    <span class="sep">~</span>
                    <input type="number" id="txtdl-to" min="1" value="1">
                    <span id="txtdl-total" style="color:#666">共 0 章</span>
                </div>
                <div class="txtdl-row">
                    <label>并发</label>
                    <input type="number" id="txtdl-conc" min="1" max="4" value="2">
                    <label style="flex:0 0 44px">间隔</label>
                    <input type="number" id="txtdl-delay" min="0" max="5000" step="100" value="800">
                    <span style="color:#666">ms</span>
                </div>
                <div class="txtdl-chk">
                    <label><input type="checkbox" id="txtdl-title" checked>含章节标题</label>
                    <label><input type="checkbox" id="txtdl-indent" checked>段落缩进</label>
                </div>
                <div id="txtdl-actions">
                    <button id="txtdl-load" class="primary">载入目录</button>
                    <button id="txtdl-start">开始下载</button>
                    <button id="txtdl-pause" disabled>暂停</button>
                    <button id="txtdl-cancel">取消</button>
                    <button id="txtdl-export">导出已下载</button>
                </div>
                <div id="txtdl-bar"><i></i></div>
                <div id="txtdl-stat">待载入目录</div>
                <div id="txtdl-log"></div>
            </div>
        `;

        document.body.appendChild(fab);
        document.body.appendChild(panel);
        UI.panel = panel;
        UI.els = {
            book: panel.querySelector('#txtdl-book'),
            from: panel.querySelector('#txtdl-from'),
            to: panel.querySelector('#txtdl-to'),
            total: panel.querySelector('#txtdl-total'),
            conc: panel.querySelector('#txtdl-conc'),
            delay: panel.querySelector('#txtdl-delay'),
            inclTitle: panel.querySelector('#txtdl-title'),
            indent: panel.querySelector('#txtdl-indent'),
            btnLoad: panel.querySelector('#txtdl-load'),
            btnStart: panel.querySelector('#txtdl-start'),
            btnPause: panel.querySelector('#txtdl-pause'),
            btnCancel: panel.querySelector('#txtdl-cancel'),
            btnExport: panel.querySelector('#txtdl-export'),
            bar: panel.querySelector('#txtdl-bar > i'),
            stat: panel.querySelector('#txtdl-stat'),
            log: panel.querySelector('#txtdl-log')
        };

        panel.querySelector('[data-act="min"]').addEventListener('click', () => UI.toggle(false));
        panel.querySelector('[data-act="close"]').addEventListener('click', () => UI.toggle(false));

        // 记住上次设置
        UI.els.conc.value = store.get('txtdl.conc', 2);
        UI.els.delay.value = store.get('txtdl.delay', 800);
        UI.els.inclTitle.checked = store.get('txtdl.title', true);
        UI.els.indent.checked = store.get('txtdl.indent', true);

        UI.els.btnLoad.addEventListener('click', loadToc);
        UI.els.btnStart.addEventListener('click', startDownload);
        UI.els.btnPause.addEventListener('click', () => {
            state.paused = !state.paused;
            UI.els.btnPause.textContent = state.paused ? '继续' : '暂停';
            UI.log(state.paused ? '已暂停' : '已继续');
        });
        UI.els.btnCancel.addEventListener('click', () => {
            state.cancel = true;
            state.paused = false;
            abortAll();
            UI.log('已取消');
            UI.setBusy(false);
        });
        UI.els.btnExport.addEventListener('click', () => exportRange(null));

        // 移动面板
        const head = panel.querySelector('#txtdl-head');
        let drag = null;
        head.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            const r = panel.getBoundingClientRect();
            drag = { x: e.clientX - r.left, y: e.clientY - r.top };
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.left = r.left + 'px';
            panel.style.top = r.top + 'px';
            e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!drag) return;
            panel.style.left = Math.max(0, e.clientX - drag.x) + 'px';
            panel.style.top = Math.max(0, e.clientY - drag.y) + 'px';
        });
        window.addEventListener('mouseup', () => { drag = null; });
    }

    /* =========================================================================
     * 8. 交互流程
     * ========================================================================= */
    async function loadToc() {
        if (state.running) return;
        detectContext();
        if (!state.bookId) {
            UI.log('未识别书号：请在 /book/<id>/ 或 /read/<id>/<cid> 页面使用');
            return;
        }
        UI.log('开始解析目录…');
        state.cancel = false;
        state.paused = false;
        UI.setBusy(true);
        try {
            const toc = await buildToc((page, count, fresh) => {
                UI.log(`目录第 ${page} 页：新增 ${fresh} 章，累计 ${count} 章`);
            });
            UI.els.book.textContent = (state.bookName || 'book') + (state.author ? ' / ' + state.author : '');
            UI.els.total.textContent = '共 ' + toc.length + ' 章';
            UI.els.from.max = toc.length;
            UI.els.to.max = toc.length;
            UI.els.to.value = toc.length;

            // 默认从当前所在章节开始
            let start = 1;
            if (state.currentChapterId) {
                const idx = toc.findIndex(c => c.url.indexOf('/' + state.currentChapterId) >= 0);
                if (idx >= 0) start = idx + 1;
            }
            UI.els.from.value = start;
            UI.els.stat.textContent = `目录就绪：${toc.length} 章`;
            UI.log(`目录解析完成，共 ${toc.length} 章`);
        } catch (e) {
            UI.log('目录解析失败：' + e.message);
            UI.els.stat.textContent = '目录解析失败';
        } finally {
            // 中途取消/失败时，已解析到的目录仍然可用
            const toc = state.toc || [];
            if (toc.length) {
                UI.els.book.textContent = (state.bookName || 'book') + (state.author ? ' / ' + state.author : '');
                UI.els.total.textContent = '共 ' + toc.length + ' 章';
                UI.els.from.max = toc.length;
                UI.els.to.max = toc.length;
                if (!UI.els.to.value || +UI.els.to.value === 1) UI.els.to.value = toc.length;
            }
            UI.setBusy(false);
        }
    }

    function currentList() {
        const toc = state.toc;
        if (!toc.length) return [];
        let a = Math.max(1, parseInt(UI.els.from.value, 10) || 1);
        let b = Math.min(toc.length, parseInt(UI.els.to.value, 10) || toc.length);
        if (a > b) [a, b] = [b, a];
        return toc.slice(a - 1, b);
    }

    async function startDownload() {
        if (state.running) return;
        detectContext();
        if (!state.toc.length) await loadToc();
        if (!state.toc.length) return;

        const list = currentList();
        if (!list.length) { UI.log('章节区间为空'); return; }

        store.set('txtdl.conc', parseInt(UI.els.conc.value, 10) || 2);
        store.set('txtdl.delay', parseInt(UI.els.delay.value, 10) || 800);
        store.set('txtdl.title', UI.els.inclTitle.checked);
        store.set('txtdl.indent', UI.els.indent.checked);

        UI.setBusy(true);
        UI.els.btnPause.textContent = '暂停';
        UI.log(`开始下载 ${list.length} 章…`);

        const res = await download(list, {
            concurrency: parseInt(UI.els.conc.value, 10) || 2,
            delay: parseInt(UI.els.delay.value, 10) || 800
        });

        UI.setBusy(false);
        UI.log(`下载结束：成功 ${res.ok}，失败 ${res.fail}，共 ${res.total}`);

        if (state.cache.size && !state.cancel) exportRange(list);
    }

    function exportRange(list) {
        const use = list || currentList();
        const ready = use.filter(c => state.cache.has(c.url));
        if (!ready.length) { UI.log('还没有可导出的章节'); return; }
        const text = buildText(ready, {
            includeTitle: UI.els.inclTitle ? UI.els.inclTitle.checked : true,
            indent: UI.els.indent ? UI.els.indent.checked : true
        });
        const name = safeName(
            (state.bookName || 'book') + '_' +
            (ready.length === state.toc.length ? '全本' : `第${ready[0].idx}-${ready[ready.length - 1].idx}章`) +
            '_' + ready.length + '章'
        ) + '.txt';
        saveText(name, text);
        UI.log('已导出：' + name);
    }

    // Alt+S 开关面板
    document.addEventListener('keydown', (e) => {
        if (e.altKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            UI.toggle();
        }
    });

    // 初始化
    function boot() {
        detectContext();
        buildPanel();
        if (state.bookId && /^\/(read|book|indexlist)\//.test(location.pathname)) {
            UI.els.book.textContent = '书号 ' + state.bookId + '（点击“载入目录”解析）';
        } else {
            UI.els.book.textContent = '当前页面无书籍信息';
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
