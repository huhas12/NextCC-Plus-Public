/* SPDX-FileCopyrightText: 2026 Dimitrios Kokkotis
 * SPDX-License-Identifier: AGPL-3.0-or-later */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.NCVideoSubtitleOptions = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const SEARCH_ENGINES = [
        ['google', 'Google', 'https://www.google.com/search?q={query}'],
        ['bing', 'Bing', 'https://www.bing.com/search?q={query}'],
        ['duckduckgo', 'DuckDuckGo', 'https://duckduckgo.com/?q={query}'],
        ['brave', 'Brave Search', 'https://search.brave.com/search?q={query}'],
        ['startpage', 'Startpage', 'https://www.startpage.com/sp/search?query={query}'],
        ['ecosia', 'Ecosia', 'https://www.ecosia.org/search?q={query}'],
        ['qwant', 'Qwant', 'https://www.qwant.com/?q={query}'],
        ['yahoo', 'Yahoo Search', 'https://search.yahoo.com/search?p={query}'],
    ].map(([id, name, url]) => ({ id, name, url }));
    function validSearchTemplate(value) {
        if (typeof value !== 'string' || value.length > 2048 || value.split('{query}').length !== 2
            || !/^https:\/\/[^/?#{}@\\]+[/?#]/i.test(value) || /[\s\\\x00-\x1f\x7f{}]/u.test(value.replace('{query}', ''))) return false;
        try {
            const url = new URL(value.replace('{query}', 'test'));
            return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
        } catch (_) { return false; }
    }
    function searchSettings(value = {}) {
        const custom = [];
        const templates = new Set(SEARCH_ENGINES.map(engine => engine.url));
        for (const engine of Array.isArray(value?.custom) ? value.custom : []) {
            const name = typeof engine?.name === 'string' ? engine.name.trim() : '';
            const url = typeof engine?.url === 'string' ? engine.url.trim() : '';
            if (!name || [...name].length > 80 || !validSearchTemplate(url) || templates.has(url)) continue;
            templates.add(url);
            custom.push({ name, url });
        }
        const valid = new Set([...SEARCH_ENGINES.map(engine => engine.id), ...custom.map(engine => engine.url)]);
        const selected = Array.isArray(value?.selected) ? [...new Set(value.selected.filter(id => valid.has(id)))] : ['google'];
        return { custom, selected };
    }
    function webQuery(term, code) {
        if (!term.trim()) return '';
        const local = { el: 'ελληνικοί υπότιτλοι', en: 'English subtitles', fr: 'sous-titres français',
            de: 'deutsche Untertitel', it: 'sottotitoli italiani', es: 'subtítulos en español',
            pt: 'legendas em português', 'pt-br': 'legendas em português do Brasil' };
        let suffix = local[code];
        if (!suffix) {
            let name = code;
            try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (_) { /* use language code */ }
            suffix = name + ' subtitles';
        }
        return term.trim() + ' ' + suffix;
    }
    function searchUrl(template, query) {
        if (!query || !validSearchTemplate(template)) return '';
        return new URL(template.replace('{query}', () => encodeURIComponent(query))).href;
    }
    const DEFAULTS = Object.freeze({ menuLanguage: 'auto', subtitleLanguages: [], encoding: 'auto', webSearch: searchSettings(),
        backgroundEnabled: true, backgroundColor: '#000000', backgroundOpacity: 0.72,
        shadowEnabled: true, shadowDepth: 2, textColor: '#ffffff', fontSize: 24, verticalPosition: 100, verticalOffset: 0 });
    const ENCODINGS = ['auto', 'utf-8', 'windows-1253', 'utf-16le', 'utf-16be', 'windows-1252',
        'windows-1250', 'windows-1251', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257',
        'windows-1258', 'iso-8859-7', 'iso-8859-2', 'iso-8859-15', 'shift_jis', 'euc-kr', 'gb18030', 'big5'];
    // A local fallback is available before an API key/account is connected.
    const LANGUAGE_CODES = ('af sq am ar hy as az eu be bn bs br bg my ca zh-cn zh-tw zh cs da nl en eo et fi fr gl ka de el gu he hi hu is id it ja kn kk km ko ku lo lv lt lb mk ms ml mt mn ne no nn oc fa pl pt pt-br ro ru sr si sk sl so es es-mx sw sv tl ta te th tr uk ur uz vi cy').split(' ');
    function normalize(input = {}) {
        const result = { ...DEFAULTS, subtitleLanguages: [], webSearch: searchSettings(input.webSearch) };
        for (const [key, allowed] of [['menuLanguage', ['auto', 'en', 'el']], ['encoding', ENCODINGS]]) if (allowed.includes(input[key])) result[key] = input[key];
        for (const key of ['backgroundEnabled', 'shadowEnabled']) if (typeof input[key] === 'boolean') result[key] = input[key];
        for (const key of ['backgroundColor', 'textColor']) if (typeof input[key] === 'string' && /^#[0-9a-f]{6}$/i.test(input[key])) result[key] = input[key].toLowerCase();
        for (const [key, min, max] of [['backgroundOpacity', 0, 1], ['shadowDepth', 0, 10], ['fontSize', 14, 48], ['verticalPosition', 0, 100], ['verticalOffset', -200, 200]]) if (Number.isFinite(input[key])) result[key] = Math.max(min, Math.min(max, input[key]));
        if (Array.isArray(input.subtitleLanguages)) result.subtitleLanguages = [...new Set(input.subtitleLanguages.filter(code => typeof code === 'string' && /^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(code)))].slice(0, 3);
        return result;
    }
    function menuLanguage(preferences, locale) { return preferences.menuLanguage === 'auto' ? (locale.toLowerCase().startsWith('el') ? 'el' : 'en') : preferences.menuLanguage; }
    function preferredLanguages(preferences, locale) { return preferences.subtitleLanguages.length ? preferences.subtitleLanguages : [locale.toLowerCase().startsWith('el') ? 'el' : 'en']; }
    function appearance(preferences) {
        const p = normalize(preferences);
        const rgb = [1, 3, 5].map(at => parseInt(p.backgroundColor.slice(at, at + 2), 16));
        return { background: p.backgroundEnabled ? `rgba(${rgb.join(',')},${p.backgroundOpacity})` : 'transparent',
            shadow: p.shadowEnabled ? `${p.shadowDepth}px ${p.shadowDepth}px ${p.shadowDepth * 1.5}px #000` : 'none',
            color: p.textColor, fontSize: `${p.fontSize}px`, position: `${p.verticalPosition}%`, offset: `${p.verticalOffset}px` };
    }
    // Positive offsets raise captions; negative offsets lower them. Clamp at the
    // actual player edges, allowing captions below the usual control clearance.
    function placementOffset(preferences, { hostHeight, overlayTop, overlayHeight, captionHeight }) {
        const p = normalize(preferences);
        if (![hostHeight, overlayTop, overlayHeight, captionHeight].every(Number.isFinite) || hostHeight <= 0 || captionHeight <= 0) return p.verticalOffset;
        const base = overlayTop + (overlayHeight - captionHeight) * p.verticalPosition / 100;
        const top = Math.max(4, Math.min(Math.max(4, hostHeight - captionHeight - 4), base - p.verticalOffset));
        return base - top;
    }
    function guessMetadata(filename) {
        const base = filename.replace(/\.[^.]+$/, '').replace(/[._]/g, ' ');
        const tv = /\bS(\d{1,2})\s*E(\d{1,3})\b/i.exec(base);
        const year = /\b(19\d{2}|20\d{2})\b/.exec(base);
        const cutoff = tv?.index ?? year?.index ?? base.search(/\b(?:2160p|1080p|720p|480p|bluray|brrip|bdrip|webrip|web-dl|hdtv|dvdrip|x264|x265|hevc)\b/i);
        const query = (cutoff >= 0 ? base.slice(0, cutoff) : base).replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').trim();
        return { query: query || base.trim(), year: year ? +year[1] : 0, season: tv ? +tv[1] : 0, episode: tv ? +tv[2] : 0 };
    }
    function safeStem(filename) {
        const original = filename.replace(/\.[^.]+$/, '').replace(/[\x00-\x1f/\\]/g, '_');
        let stem = '';
        let length = 0;
        for (const character of original) {
            const bytes = new TextEncoder().encode(character).length;
            if (length + bytes > 180) break;
            stem += character; length += bytes;
        }
        return stem;
    }
    function saveName(videoName, language) {
        const code = /^[a-z]{2,3}(?:-[a-z]{2,3})?$/.test(language) ? language : 'und';
        return `${safeStem(videoName)}.${code}.srt`;
    }
    function syncName(filename, format) {
        return `${safeStem(filename) || 'subtitle'}.synced.${format}`;
    }
    return { DEFAULTS, ENCODINGS, LANGUAGE_CODES, SEARCH_ENGINES, validSearchTemplate, webQuery, searchUrl,
        normalize, menuLanguage, preferredLanguages, appearance, placementOffset, guessMetadata, saveName, syncName };
}));
