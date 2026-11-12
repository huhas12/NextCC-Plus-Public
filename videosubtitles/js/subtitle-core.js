/* SPDX-FileCopyrightText: 2026 Dimitrios Kokkotis
 * SPDX-License-Identifier: AGPL-3.0-or-later */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NCVideoSubtitlesCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const MAX_BYTES = 2 * 1024 * 1024;
    const MAX_CUES = 20000;
    const normal = value => value.normalize('NFC').toLocaleLowerCase();
    const stem = value => normal(value.replace(/\.[^.]+$/, ''));

    function decode(bytes, encoding = 'auto') {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.byteLength > MAX_BYTES) throw new Error('size');
        if (encoding !== 'auto') return new TextDecoder(encoding, { fatal: true }).decode(data);
        if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
        if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
        try { return new TextDecoder('utf-8', { fatal: true }).decode(data); }
        catch (_) { return new TextDecoder('windows-1253').decode(data); }
    }

    function timestamp(value) {
        const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(value);
        if (!match || +match[2] >= 60 || +match[3] >= 60) return NaN;
        return +(match[1] || 0) * 3600 + +match[2] * 60 + +match[3] + Number('0.' + match[4]);
    }

    function plainText(value) {
        const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '\u200e', rlm: '\u200f' };
        return value.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '')
            .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|lrm|rlm);/gi, (all, entity) => {
                if (entity[0] !== '#') return entities[entity.toLowerCase()] || all;
                const code = /^#x/i.test(entity) ? parseInt(entity.slice(2), 16) : +entity.slice(1);
                return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
                    ? String.fromCodePoint(code) : '\ufffd';
            }).trim();
    }

    function parse(text) {
        if (text.length > MAX_BYTES) throw new Error('size');
        const blocks = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split(/\n[\t ]*\n/);
        const cues = [];
        let skipped = 0;
        for (let block of blocks) {
            block = block.trim();
            if (!block || /^(WEBVTT(?:[ \t]|$)|NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/.test(block)) continue;
            const lines = block.split('\n');
            const at = lines[0].includes('-->') ? 0 : 1;
            const match = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[at] || '');
            if (!match) { skipped++; continue; }
            const start = timestamp(match[1]);
            const end = timestamp(match[2]);
            const content = plainText(lines.slice(at + 1).join('\n'));
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !content) { skipped++; continue; }
            if (cues.length >= MAX_CUES) throw new Error('cues');
            cues.push({ start, end, text: content });
        }
        if (!cues.length) throw new Error('format');
        return { cues: indexCues(cues), skipped };
    }

    function indexCues(cues) {
        cues.sort((a, b) => a.start - b.start || a.end - b.end);
        let maxEnd = 0;
        for (const cue of cues) { maxEnd = Math.max(maxEnd, cue.end); cue.maxEnd = maxEnd; }
        return cues;
    }

    function firstCueAfter(cues, seconds) {
        let low = 0;
        let high = cues.length;
        while (low < high) {
            const mid = (low + high) >>> 1;
            if (cues[mid].start <= seconds) low = mid + 1;
            else high = mid;
        }
        return low;
    }

    // Binary search plus the prefix maximum supports both seeking and overlapping cues.
    function textAt(cues, seconds) {
        const lines = [];
        for (let i = firstCueAfter(cues, seconds) - 1; i >= 0 && cues[i].maxEnd > seconds; i--) {
            if (cues[i].end > seconds) lines.push(cues[i].text);
        }
        return lines.reverse().join('\n');
    }

    function activeCueAt(cues, seconds) {
        for (let i = firstCueAfter(cues, seconds) - 1; i >= 0 && cues[i].maxEnd > seconds; i--) {
            if (cues[i].end > seconds) return cues[i];
        }
        return null;
    }

    const milliseconds = seconds => Math.round(seconds * 1000);
    const validTime = seconds => Number.isFinite(seconds) && seconds >= 0 && Number.isSafeInteger(milliseconds(seconds));

    function retime(cues, first, second, duration = Infinity) {
        if (![first, ...(second ? [second] : [])].every(point => validTime(point?.subtitle) && validTime(point?.video))) throw new Error('sync-time');
        if (second && (second.subtitle <= first.subtitle || second.video <= first.video)) throw new Error('sync-order');
        const rate = second ? (second.video - first.video) / (second.subtitle - first.subtitle) : 1;
        const limit = Number.isFinite(duration) && duration >= 0 ? duration : Infinity;
        const corrected = [];
        const at = seconds => first.video + (seconds - first.subtitle) * rate;
        for (const cue of cues) {
            const start = milliseconds(Math.max(0, at(cue.start)));
            const end = milliseconds(Math.min(limit, at(cue.end)));
            if (end <= start) continue;
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) throw new Error('sync-time');
            corrected.push({ start: start / 1000, end: end / 1000, text: cue.text, sourceStart: cue.start });
        }
        return indexCues(corrected);
    }

    function formatTime(seconds, separator) {
        const ms = milliseconds(seconds);
        const hhmmss = [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60];
        return hhmmss.map(value => String(value).padStart(2, '0')).join(':') + separator + String(ms % 1000).padStart(3, '0');
    }

    function serialize(cues, format) {
        if (!cues.length) throw new Error('format');
        if (format !== 'srt' && format !== 'vtt') throw new Error('format');
        const vtt = format === 'vtt';
        const separator = vtt ? '.' : ',';
        const blocks = cues.map((cue, index) => {
            const times = formatTime(cue.start, separator) + ' --> ' + formatTime(cue.end, separator);
            const content = cue.text.replace(/\r\n?/g, '\n').replace(/\n(?:[\t ]*\n)+/g, '\n')
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return (vtt ? '' : `${index + 1}\n`) + times + '\n' + content;
        });
        return (vtt ? 'WEBVTT\n\n' : '') + blocks.join('\n\n') + '\n';
    }

    const languageAliases = { el: ['el', 'ell', 'gre', 'gr', 'greek'], en: ['en', 'eng', 'english'], fr: ['fr', 'fra', 'fre', 'french'], de: ['de', 'deu', 'ger', 'german'], it: ['it', 'ita'], es: ['es', 'spa'] };
    function score(name, videoName, locale = 'en') {
        const sub = stem(name);
        const video = stem(videoName);
        if (sub === video) return 100;
        if (!sub.startsWith(video)) return 0;
        const suffix = sub.slice(video.length);
        if (!/^[. _-]/.test(suffix)) return 0;
        const parts = suffix.split(/[. _]+/).flatMap(part => part.includes('-') && !/^(pt-br|es-mx|zh-cn|zh-tw)$/.test(part) ? part.split('-') : [part]).filter(Boolean);
        const locales = Array.isArray(locale) ? locale : [locale];
        const languageCodes = 'af sq am ar hy as az eu be bn bs br bg my ca zh zh-cn zh-tw cs da nl en eo et fi fr gl ka de el gu he hi hu is id it ja kn kk km ko ku lo lv lt lb mk ms ml mt mn ne no nn oc fa pl pt pt-br ro ru sr si sk sl so es es-mx sw sv tl ta te th tr uk ur uz vi cy'.split(' ');
        const known = Object.values(languageAliases).flat().concat(languageCodes, ['forced', 'sdh', 'cc', 'default']);
        if (!parts.length || parts.some(part => !known.includes(part))) return 0;
        for (let priority = 0; priority < locales.length; priority++) {
            const raw = locales[priority].toLowerCase();
            const code = ['pt-br', 'es-mx', 'zh-cn', 'zh-tw'].includes(raw) ? raw : raw.split(/[-_]/)[0];
            const preferred = languageAliases[code] || [code];
            if (parts.some(part => preferred.includes(part))) return 150 - priority * 10;
        }
        return 80;
    }

    function context(source, origin) {
        try {
            const url = new URL(source, origin);
            if (url.origin !== origin || url.username || url.password) return null;
            if (!/\/remote\.php\/(?:dav\/files\/[^/]+\/|webdav\/)/.test(url.pathname)) return null;
            if (url.pathname.endsWith('/')) return null;
            const name = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf('/') + 1));
            url.search = ''; url.hash = '';
            const folder = new URL(url.href);
            folder.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1);
            const match = /\/remote\.php\/(?:dav\/files\/[^/]+|webdav)(\/.*)$/.exec(url.pathname);
            const path = match ? match[1].split('/').map(decodeURIComponent).join('/') : null;
            return { video: url.href, folder: folder.href, name, path };
        } catch (_) { return null; }
    }

    // Public discovery stays beneath the existing share token. Nextcloud's DAV
    // endpoint, not this client, authorizes every read (password, expiry and permissions).
    function publicContext(source, origin, share) {
        try {
            if (!share?.enabled || !/^[a-zA-Z0-9_-]{5,128}$/.test(share.token) || typeof share.isFolder !== 'boolean') return null;
            const webroot = share.webroot || '';
            if (typeof webroot !== 'string' || /[?#\\\x00-\x1f]/.test(webroot) || (webroot && (!webroot.startsWith('/') || webroot.endsWith('/')))) return null;
            const url = new URL(source, origin);
            if (url.origin !== origin || url.username || url.password) return null;
            const root = new URL(webroot + '/public.php/dav/files/' + encodeURIComponent(share.token) + '/', origin);
            if (root.origin !== origin) return null;
            const safePart = value => {
                if (!value || value === '.' || value === '..' || /[/\\\x00-\x1f\x7f]/.test(value)) throw new Error('path');
                return value;
            };
            const safeParts = raw => raw.split('/').map(part => safePart(decodeURIComponent(part)));
            let parts;
            if (!share.isFolder && (url.pathname === root.pathname || url.pathname === root.pathname.slice(0, -1))) {
                parts = [share.name];
            } else if (url.pathname.startsWith(root.pathname)) {
                parts = safeParts(url.pathname.slice(root.pathname.length));
            } else {
                const bases = [webroot + '/s/' + share.token + '/download', webroot + '/index.php/s/' + share.token + '/download'];
                const base = bases.find(value => url.pathname === value || url.pathname.startsWith(value + '/'));
                if (!base) return null;
                if (!share.isFolder) parts = [share.name];
                else if (url.pathname !== base) parts = safeParts(url.pathname.slice(base.length + 1));
                else {
                    const file = url.searchParams.get('files');
                    const path = url.searchParams.get('path') || '/';
                    if (!file || !path.startsWith('/')) return null;
                    const parents = path === '/' ? [] : path.slice(1).split('/').map(safePart);
                    parts = parents.concat(safePart(file));
                }
            }
            if (!parts.length || parts.some(part => typeof part !== 'string' || !part || /[/\\\x00-\x1f\x7f]/.test(part))) return null;
            const name = parts.at(-1);
            if (!share.isFolder && name !== share.name) return null;
            const folder = share.isFolder ? new URL(parts.slice(0, -1).map(encodeURIComponent).join('/') + (parts.length > 1 ? '/' : ''), root).href : null;
            return { video: url.href, folder, name, path: null, public: true };
        } catch (_) { return null; }
    }

    function childUrl(href, folder) {
        try {
            const parent = new URL(folder);
            const url = new URL(href, parent);
            if (url.origin !== parent.origin || url.username || url.password || url.search || url.hash) return null;
            // Compare canonical decoded segments; DAV servers may encode Unicode differently.
            const a = url.pathname.split('/').map(decodeURIComponent);
            const b = parent.pathname.split('/').slice(0, -1).map(decodeURIComponent);
            if (a.length !== b.length + 1 || !a.at(-1) || b.some((part, i) => part !== a[i])) return null;
            if (a.some(part => part.includes('/') || part.includes('\\') || part.includes('\0'))) return null;
            return { url: url.href, name: a.at(-1) };
        } catch (_) { return null; }
    }

    return { MAX_BYTES, MAX_CUES, decode, timestamp, plainText, parse, textAt, activeCueAt, retime, serialize, score, context, publicContext, childUrl };
}));
