/* SPDX-FileCopyrightText: 2026 Dimitrios Kokkotis
 * SPDX-License-Identifier: AGPL-3.0-or-later */
(function () {
    'use strict';
    if (window.NCVideoSubtitlesLoaded) return;
    const C = window.NCVideoSubtitlesCore;
    if (!C) { console.error('[Video Subtitles] Subtitle parser was not loaded.'); return; }
    window.NCVideoSubtitlesLoaded = true;
    const locale = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
    const UI = window.NCVideoSubtitlesUI;
    const tr = (en, el) => UI ? UI.t(en, el) : (locale.startsWith('el') ? el : en);
    const appName = 'NextCC+';
    const states = new Map();
    const subtitleExt = /\.(srt|vtt)$/i;
    const videoExt = /\.(mp4|mkv|webm|mov|m4v|ogv|ogg|avi|mpeg|mpg|m2ts|ts)$/i;
    const DAV = 'DAV:';

    function readBranding() {
        const input = document.getElementById('initial-state-videosubtitles-branding');
        if (!input) return {};
        try {
            const bytes = Uint8Array.from(atob(input.value), character => character.charCodeAt(0));
            return JSON.parse(new TextDecoder().decode(bytes)) ?? {};
        } catch (_) { return {}; }
    }

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function errorMessage(error) {
        if (error.message === 'size') return tr('Subtitle file exceeds 2 MiB.', 'Το αρχείο υποτίτλων ξεπερνά τα 2 MiB.');
        if (error.message === 'cues') return tr('Too many subtitle cues.', 'Υπερβολικά πολλές εγγραφές υποτίτλων.');
        if (error.message === 'format') return tr('No valid SRT or VTT subtitles found.', 'Δεν βρέθηκαν έγκυροι υπότιτλοι SRT ή VTT.');
        return tr('Could not load subtitles. Check access or try a local file.', 'Δεν φορτώθηκαν οι υπότιτλοι. Έλεγξε την πρόσβαση ή διάλεξε τοπικό αρχείο.');
    }

    function headers() {
        const value = { 'X-Requested-With': 'XMLHttpRequest' };
        const token = window.OC?.requestToken || document.head?.dataset.requesttoken;
        if (token) value.requesttoken = token;
        return value;
    }

    async function readLimited(response, maxBytes) {
        if (!response.ok) throw new Error('http-' + response.status);
        if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('size');
        if (!response.body) {
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length > maxBytes) throw new Error('size');
            return bytes;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                length += value.length;
                if (length > maxBytes) { await reader.cancel(); throw new Error('size'); }
                chunks.push(value);
            }
        } finally { reader.releaseLock(); }
        const bytes = new Uint8Array(length);
        let at = 0;
        for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }
        return bytes;
    }

    function parseListing(xml, folder) {
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'multistatus'
            || doc.documentElement.namespaceURI !== DAV) throw new Error('listing');
        const entries = [];
        const seen = new Set();
        const responses = doc.getElementsByTagNameNS(DAV, 'response');
        if (responses.length > 10000) throw new Error('listing-size');
        for (const row of responses) {
            const href = row.getElementsByTagNameNS(DAV, 'href')[0]?.textContent;
            if (!href) continue;
            const child = C.childUrl(href, folder);
            if (!child || seen.has(child.name)) continue;
            const propstats = [...row.getElementsByTagNameNS(DAV, 'propstat')];
            const valid = propstats.filter(prop => /\s200(?:\s|$)/.test(prop.getElementsByTagNameNS(DAV, 'status')[0]?.textContent || ''));
            if (!valid.length || valid.some(prop => prop.getElementsByTagNameNS(DAV, 'collection').length)) continue;
            const rawSize = valid.map(prop => prop.getElementsByTagNameNS(DAV, 'getcontentlength')[0]?.textContent).find(Boolean);
            const size = rawSize === undefined ? null : Number(rawSize);
            seen.add(child.name);
            entries.push({ ...child, size });
        }
        return entries;
    }

    function labelControl(panel, en, el, control) {
        const label = element('label', 'ncvs-field');
        const caption = element('span', '', tr(en, el));
        caption.dataset.ncvsEnglish = en; caption.dataset.ncvsGreek = el;
        label.append(caption, control);
        panel.append(label);
    }

    class Player {
        constructor(video, host, controls) {
            this.video = video;
            this.host = host;
            this.cues = [];
            this.previewCues = null;
            this.bytes = null;
            this.offset = 0;
            this.context = null;
            this.source = '';
            this.generation = 0;
            this.manual = 0;
            this.dead = false;
            this.frame = 0;
            this.fetchController = null;
            this.listController = null;
            this.events = new AbortController();
            const signal = this.events.signal;
            const branding = readBranding();

            this.button = element('button', 'plyr__control ncvs-button', appName);
            this.button.type = 'button';
            this.button.title = appName + ' · ' + tr('Subtitles', 'Υπότιτλοι');
            this.button.setAttribute('aria-expanded', 'false');
            this.panel = element('section', 'ncvs-panel');
            this.panel.hidden = true;
            this.panel.setAttribute('role', 'dialog');
            this.panel.setAttribute('aria-label', appName);
            this.header = element('div', 'ncvs-header');
            const brand = element('div', 'ncvs-brand');
            const heading = element('h2', 'ncvs-heading', appName);
            if (typeof branding.logoUrl === 'string' && branding.logoUrl) {
                const logo = element('img', 'ncvs-logo');
                logo.alt = appName;
                logo.width = 504;
                logo.height = 103;
                logo.addEventListener('error', () => { heading.textContent = appName; }, { once: true, signal });
                logo.src = branding.logoUrl;
                heading.replaceChildren(logo);
            }
            brand.append(heading);
            if (typeof branding.version === 'string' && branding.version) {
                brand.append(element('p', 'ncvs-version', 'v' + branding.version));
            }
            this.header.append(brand);
            this.panel.append(this.header);
            this.select = element('select');
            this.select.append(new Option(tr('Off', 'Ανενεργοί'), ''));
            labelControl(this.panel, 'In this folder', 'Στον φάκελο του βίντεο', this.select);

            this.file = element('input');
            this.file.type = 'file';
            this.file.accept = '.srt,.vtt';
            labelControl(this.panel, 'Load from computer (SRT / VTT)', 'Φόρτωση από υπολογιστή (SRT / VTT)', this.file);

            this.encoding = element('select');
            for (const value of (UI?.encodings || ['auto', 'utf-8', 'windows-1253', 'utf-16le', 'utf-16be', 'windows-1252'])) this.encoding.append(new Option(value === 'auto' ? tr('Automatic', 'Αυτόματη') : value.toUpperCase(), value));
            this.encoding.value = UI?.preferences.encoding || 'auto';
            labelControl(this.panel, 'Character encoding', 'Κωδικοποίηση χαρακτήρων', this.encoding);

            this.delay = element('input');
            this.delay.type = 'number'; this.delay.step = '0.1';
            this.delay.min = '-600'; this.delay.max = '600'; this.delay.value = '0';
            labelControl(this.panel, 'Delay in seconds (+ = later)', 'Μετατόπιση σε δευτερόλεπτα (+ = αργότερα)', this.delay);
            this.status = element('p', 'ncvs-status');
            this.status.setAttribute('role', 'status');
            this.panel.append(this.status);
            this.close = element('button', 'ncvs-close', tr('Close', 'Κλείσιμο'));
            this.close.type = 'button';
            this.header.append(this.close);

            this.overlay = element('div', 'ncvs-overlay');
            this.overlay.setAttribute('aria-hidden', 'true');
            this.caption = element('span');
            this.captionBox = element('div', 'ncvs-caption-box');
            this.captionBox.append(this.caption);
            this.overlay.append(this.captionBox);
            this.overlay.hidden = true;
            this.host.append(this.overlay, this.panel);
            const fullscreen = controls.querySelector('[data-plyr="fullscreen"]');
            controls.insertBefore(this.button, fullscreen?.parentNode === controls ? fullscreen : null);
            this.button.addEventListener('click', event => {
                event.stopPropagation();
                if (this.panel.hidden) this.show(); else this.hide();
            }, { signal });
            this.close.addEventListener('click', () => this.hide(), { signal });
            this.panel.addEventListener('click', event => event.stopPropagation(), { signal });
            this.panel.addEventListener('pointerdown', event => event.stopPropagation(), { signal });
            this.panel.addEventListener('keydown', event => {
                event.stopPropagation();
                if (event.key === 'Escape') { event.preventDefault(); this.hide(); }
            }, { signal });
            document.addEventListener('pointerdown', event => {
                if (!this.panel.hidden && !this.panel.contains(event.target) && !this.button.contains(event.target)) this.hide(false);
            }, { signal });
            this.select.addEventListener('change', () => this.choose(), { signal });
            this.file.addEventListener('change', () => this.localFile(), { signal });
            this.encoding.addEventListener('change', () => {
                if (this.bytes) this.applyBytes(this.bytes, this.loadedName);
                UI?.persist({ encoding: this.encoding.value });
            }, { signal });
            this.delay.addEventListener('input', () => {
                const value = Number(this.delay.value);
                this.offset = Number.isFinite(value) ? Math.max(-600, Math.min(600, value)) : 0;
                this.render();
            }, { signal });
            for (const event of ['timeupdate', 'seeked', 'seeking', 'loadedmetadata']) video.addEventListener(event, () => { this.checkSource(); this.render(); }, { signal });
            video.addEventListener('play', () => { this.checkSource(); this.tick(); }, { signal });
            for (const event of ['pause', 'ended', 'emptied']) video.addEventListener(event, () => { cancelAnimationFrame(this.frame); this.frame = 0; this.render(); }, { signal });
            this.enhancements = UI?.attach(this);
            this.placementObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => this.updatePlacement()) : null;
            this.placementObserver?.observe(this.host);
            this.placementObserver?.observe(this.captionBox);
            window.addEventListener('resize', () => this.updatePlacement(), { signal });
            this.checkSource();
            if (!video.paused) this.tick();
        }

        refreshLabels() {
            this.button.title = appName + ' · ' + tr('Subtitles', 'Υπότιτλοι');
            this.close.textContent = tr('Close', 'Κλείσιμο');
            for (const label of this.panel.querySelectorAll('[data-ncvs-english]')) label.textContent = tr(label.dataset.ncvsEnglish, label.dataset.ncvsGreek);
            this.select.options[0].textContent = tr('Off', 'Ανενεργοί');
            this.encoding.options[0].textContent = tr('Automatic', 'Αυτόματη');
        }

        show() {
            this.panel.hidden = false;
            this.button.setAttribute('aria-expanded', 'true');
            this.host.classList.add('ncvs-open');
            this.select.focus();
        }

        hide(focus = true) {
            this.panel.hidden = true;
            this.button.setAttribute('aria-expanded', 'false');
            this.host.classList.remove('ncvs-open');
            if (focus) this.button.focus();
        }

        checkSource() {
            const source = this.video.getAttribute('src') || this.video.currentSrc || this.video.querySelector('source')?.src || '';
            if (!source || source === this.source) return;
            const context = UI?.publicShare
                ? C.publicContext(source, location.origin, UI.publicShare)
                : C.context(source, location.origin);
            // The stock player may swap the same video to a blob after a failed network load.
            if (source.startsWith('blob:') && this.context) { this.source = source; return; }
            this.source = source;
            this.generation++; this.manual++;
            this.fetchController?.abort(); this.listController?.abort();
            this.context = context;
            this.bytes = null; this.offset = 0; this.delay.value = '0';
            this.loadedName = ''; this.file.value = ''; this.localBytes = null; this.localName = ''; this.onlineBytes = null; this.onlineName = '';
            this.select.replaceChildren(new Option(tr('Off', 'Ανενεργοί'), ''));
            this.setCues([]);
            this.enhancements?.onSourceChange();
            if (context?.public && !context.folder) this.status.textContent = tr('This link shares one video. Load a local subtitle; automatic discovery requires a read-only folder share.', 'Αυτός ο σύνδεσμος κοινοποιεί μόνο το βίντεο. Φόρτωσε τοπικό υπότιτλο· η αυτόματη εύρεση απαιτεί κοινή χρήση φακέλου μόνο για ανάγνωση.');
            else if (context) this.discover();
            else this.status.textContent = tr('Automatic folder detection is unavailable for this video URL. Load a local subtitle.', 'Δεν εντοπίστηκε φάκελος για αυτή τη διεύθυνση βίντεο. Διάλεξε τοπικό υπότιτλο.');
        }

        async discover() {
            const generation = this.generation;
            const manual = this.manual;
            const context = this.context;
            this.status.textContent = tr('Looking for subtitles…', 'Αναζήτηση υποτίτλων…');
            this.listController = new AbortController();
            try {
                const response = await fetch(context.folder, {
                    method: 'PROPFIND', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
                    headers: { ...headers(), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
                    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>',
                    signal: this.listController.signal,
                });
                const xml = new TextDecoder().decode(await readLimited(response, 8 * 1024 * 1024));
                const entries = parseListing(xml, context.folder);
                if (this.dead || generation !== this.generation) return;
                const tracks = entries.filter(entry => subtitleExt.test(entry.name) && (entry.size === null || (Number.isFinite(entry.size) && entry.size <= C.MAX_BYTES)));
                tracks.sort((a, b) => C.score(b.name, context.name, UI?.preferredLanguages() || locale) - C.score(a.name, context.name, UI?.preferredLanguages() || locale) || a.name.localeCompare(b.name));
                this.select.append(...tracks.map(entry => new Option(entry.name, entry.url)));
                if (manual !== this.manual) return;
                const matching = tracks.find(entry => C.score(entry.name, context.name, UI?.preferredLanguages() || locale) > 0);
                const videos = entries.filter(entry => videoExt.test(entry.name));
                const unambiguous = tracks.length === 1 && videos.length === 1 && videos[0].name === context.name ? tracks[0] : null;
                const auto = matching || unambiguous;
                if (auto) { this.select.value = auto.url; await this.loadRemote(auto.url, auto.name); }
                else this.status.textContent = tracks.length
                    ? tr('Select a subtitle from this folder.', 'Διάλεξε υπότιτλο από τον φάκελο.')
                    : tr('No SRT or VTT found. You can load a local file.', 'Δεν βρέθηκε SRT ή VTT. Μπορείς να φορτώσεις τοπικό αρχείο.');
            } catch (error) {
                if (error.name !== 'AbortError' && !this.dead && generation === this.generation && manual === this.manual) this.status.textContent = errorMessage(error);
            }
        }

        async loadRemote(url, name) {
            const generation = this.generation;
            const manual = this.manual;
            if (!this.context || !C.childUrl(url, this.context.folder) || !subtitleExt.test(name)) return;
            this.fetchController?.abort();
            const controller = new AbortController();
            this.fetchController = controller;
            this.status.textContent = tr('Loading subtitles…', 'Φόρτωση υποτίτλων…');
            try {
                const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: headers(), signal: controller.signal });
                const bytes = await readLimited(response, C.MAX_BYTES);
                if (!this.dead && generation === this.generation && manual === this.manual && !controller.signal.aborted) this.applyBytes(bytes, name);
            } catch (error) {
                if (error.name !== 'AbortError' && !this.dead && generation === this.generation && manual === this.manual) {
                    this.bytes = null; this.setCues([]); this.status.textContent = errorMessage(error);
                }
            }
        }

        applyPreferredLanguage() {
            if (!this.context) return;
            const matches = [...this.select.options].filter(option => option.value && C.childUrl(option.value, this.context.folder))
                .map(option => ({ option, score: C.score(option.textContent, this.context.name, UI?.preferredLanguages() || locale) }))
                .filter(item => item.score > 100).sort((a, b) => b.score - a.score);
            if (matches.length && matches[0].option.value !== this.select.value) {
                this.select.value = matches[0].option.value;
                this.choose();
            }
        }

        choose() {
            this.manual++; this.fetchController?.abort();
            this.bytes = null; this.setCues([]);
            if (!this.select.value) {
                this.status.textContent = tr('Subtitles off.', 'Οι υπότιτλοι απενεργοποιήθηκαν.');
            } else if (this.select.value === 'online') {
                if (this.onlineBytes) { this.encoding.value = 'utf-8'; this.applyBytes(this.onlineBytes, this.onlineName); }
            } else if (this.select.value === 'local') {
                if (this.localBytes) this.applyBytes(this.localBytes, this.localName);
            } else {
                this.loadRemote(this.select.value, this.select.selectedOptions[0].textContent);
            }
            this.enhancements?.updateDownloadActions();
        }

        async localFile() {
            const file = this.file.files[0];
            if (!file) return;
            this.manual++; this.fetchController?.abort();
            const manual = this.manual;
            const generation = this.generation;
            this.bytes = null; this.setCues([]);
            try {
                if (!subtitleExt.test(file.name)) throw new Error('format');
                if (file.size > C.MAX_BYTES) throw new Error('size');
                const bytes = new Uint8Array(await file.arrayBuffer());
                if (this.dead || manual !== this.manual || generation !== this.generation) return;
                this.localBytes = bytes; this.localName = file.name;
                this.select.querySelector('option[value="local"]')?.remove();
                this.select.append(new Option(tr('Local: ', 'Τοπικό: ') + file.name, 'local'));
                this.select.value = 'local';
                this.applyBytes(bytes, file.name);
                this.enhancements?.updateDownloadActions();
            } catch (error) {
                if (!this.dead && manual === this.manual && generation === this.generation) this.status.textContent = errorMessage(error);
            }
        }

        applyBytes(bytes, name) {
            this.bytes = bytes; this.loadedName = name;
            let cues = [];
            try {
                const result = C.parse(C.decode(bytes, this.encoding.value));
                cues = result.cues;
                this.status.textContent = name + ' · ' + result.cues.length + tr(' cues', ' εγγραφές')
                    + (result.skipped ? tr(' · skipped invalid blocks: ', ' · παραλείφθηκαν μη έγκυρες εγγραφές: ') + result.skipped : '');
            } catch (error) { this.status.textContent = errorMessage(error); }
            this.setCues(cues);
        }

        setCues(cues) {
            this.cues = cues;
            this.enhancements?.resetSync();
            this.render();
        }

        updatePlacement() {
            if (this.dead || this.overlay.hidden || !UI?.placementOffset) return;
            const offset = UI.placementOffset({ hostHeight: this.host.clientHeight, overlayTop: this.overlay.offsetTop,
                overlayHeight: this.overlay.offsetHeight, captionHeight: this.captionBox.offsetHeight });
            this.host.style.setProperty('--ncvs-offset', offset + 'px');
        }

        render() {
            const time = this.video.currentTime - (this.previewCues ? 0 : this.offset);
            const text = this.video.ended ? '' : C.textAt(this.previewCues ?? this.cues, time);
            const changed = this.caption.textContent !== text || this.overlay.hidden !== !text;
            if (this.caption.textContent !== text) this.caption.textContent = text;
            this.overlay.hidden = !text;
            if (changed) this.updatePlacement();
        }

        tick() {
            if (this.frame || this.dead || this.video.paused) return;
            const run = () => {
                this.frame = 0;
                if (this.dead || this.video.paused || this.video.ended) return;
                this.render(); this.frame = requestAnimationFrame(run);
            };
            this.frame = requestAnimationFrame(run);
        }

        destroy() {
            this.dead = true;
            this.placementObserver?.disconnect();
            this.enhancements?.destroy();
            this.events.abort(); this.fetchController?.abort(); this.listController?.abort();
            cancelAnimationFrame(this.frame);
            this.button.remove(); this.panel.remove(); this.overlay.remove();
            this.host.classList.remove('ncvs-open');
            this.cues = []; this.bytes = null; this.localBytes = null;
        }
    }

    let scheduled = false;
    function scan() {
        scheduled = false;
        for (const [video, state] of states) {
            if (!video.isConnected || !state.button.isConnected || video.closest('.plyr') !== state.host) {
                state.destroy(); states.delete(video);
            } else state.checkSource();
        }
        for (const video of document.querySelectorAll('.plyr video')) {
            if (states.has(video)) continue;
            const host = video.closest('.plyr');
            const controls = host.querySelector('.plyr__controls');
            if (!controls) continue;
            try { states.set(video, new Player(video, host, controls)); }
            catch (error) { console.error('[Video Subtitles] Could not attach controls.', error); }
        }
    }

    function schedule() {
        if (!scheduled) { scheduled = true; queueMicrotask(scan); }
    }

    async function start() {
        if (UI?.publicShare && !UI.publicShare.enabled) return;
        await UI?.initialize();
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
        scan();
        window.addEventListener('pagehide', () => {
            observer.disconnect();
            for (const state of states.values()) state.destroy();
            states.clear();
        }, { once: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
}());
