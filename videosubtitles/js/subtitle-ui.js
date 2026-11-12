/* SPDX-FileCopyrightText: 2026 Dimitrios Kokkotis
 * SPDX-License-Identifier: AGPL-3.0-or-later */
(function () {
    'use strict';
    const O = window.NCVideoSubtitleOptions;
    const C = window.NCVideoSubtitlesCore;
    if (!O) return;
    const locale = document.documentElement.lang || navigator.language || 'en';
    function readPublicState() {
        const input = document.getElementById('initial-state-videosubtitles-public');
        if (!input) return /\/(?:index\.php\/)?s\/[^/]+(?:\/|$)/.test(location.pathname) ? { enabled: false } : null;
        try {
            const bytes = Uint8Array.from(atob(input.value), character => character.charCodeAt(0));
            const state = JSON.parse(new TextDecoder().decode(bytes));
            return { ...state, enabled: state.enabled === true, webroot: window.OC?.webroot || '' };
        } catch (_) { return { enabled: false }; }
    }
    const publicShare = readPublicState();
    const views = new Set();
    let preferences = O.normalize();
    let connection = { connected: false, apiKeyConfigured: false, username: '' };
    let canConfigureApplicationKey = false;
    let publicLinksEnabled = false;
    let catalog = O.LANGUAGE_CODES.map(code => ({ code, name: code }));
    let initialized;
    let saveTimer;
    let pendingSave = null;
    let saving = false;
    let preferenceRevision = 0;

    const language = () => O.menuLanguage(preferences, locale);
    const t = (en, el) => language() === 'el' ? el : en;
    const currentLanguages = () => O.preferredLanguages(preferences, locale);
    function headers() {
        const out = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
        const token = window.OC?.requestToken || document.head?.dataset.requesttoken;
        if (token) out.requesttoken = token;
        return out;
    }
    function endpoint(route) {
        const path = '/apps/videosubtitles/api/' + route;
        if (typeof window.OC?.generateUrl === 'function') return window.OC.generateUrl(path);
        return (window.OC?.webroot || '') + '/index.php' + path;
    }
    async function api(route, method = 'GET', body, signal) {
        if (publicShare) throw new Error('public_read_only');
        const options = { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: headers(), signal };
        if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
        const response = await fetch(endpoint(route), options);
        if (response.status === 429) throw new Error('quota_or_rate_limit');
        let value;
        try { value = await response.json(); }
        catch (_) { throw new Error('invalid_api_response'); }
        if (!response.ok || !value.ok) throw new Error(value.error || 'internal_error');
        return value;
    }
    async function writeBesideVideo(context, name, bytes, contentType, signal) {
        if (publicShare || !context?.folder || context.public) throw new Error('public_read_only');
        const url = new URL(encodeURIComponent(name), context.folder).href;
        if (!C.childUrl(url, context.folder)) throw new Error('invalid_video_path');
        return fetch(url, { method: 'PUT', credentials: 'same-origin', redirect: 'error', signal,
            headers: { ...headers(), 'Content-Type': contentType, 'If-None-Match': '*' }, body: bytes });
    }
    function saveMessage(response, name) {
        if (response.status === 412) return t('A subtitle with this name already exists. It was not overwritten.', 'Υπάρχει ήδη υπότιτλος με αυτό το όνομα. Δεν αντικαταστάθηκε.');
        if (!response.ok) return t('Could not save the subtitle. Check folder write permissions.', 'Δεν αποθηκεύτηκε ο υπότιτλος. Έλεγξε τα δικαιώματα εγγραφής του φακέλου.');
        return t('Saved beside the video: ', 'Αποθηκεύτηκε στον φάκελο του βίντεο: ') + name;
    }
    function message(error) {
        const code = error?.message || '';
        if (code === 'login_required') {
            connection = { ...connection, connected: false };
            for (const view of views) view.updateConnection();
        }
        const messages = {
            login_required: ['Sign in again to OpenSubtitles.com. Check your credentials if login failed.', 'Συνδέσου ξανά στο OpenSubtitles.com. Έλεγξε τα στοιχεία σου αν απέτυχε η σύνδεση.'],
            invalid_credentials: ['Enter your OpenSubtitles username and password.', 'Συμπλήρωσε όνομα χρήστη και κωδικό OpenSubtitles.'],
            api_key_required: ['Online search has not been configured for this Nextcloud. Ask the administrator to set up the application key, or enter your own optional key. A free OpenSubtitles account is supported.', 'Η online αναζήτηση δεν έχει ρυθμιστεί σε αυτό το Nextcloud. Ζήτησε από τον διαχειριστή να ορίσει το key της εφαρμογής ή βάλε προαιρετικά δικό σου. Υποστηρίζεται δωρεάν λογαριασμός OpenSubtitles.'],
            invalid_api_key: ['Enter a valid application key before saving.', 'Συμπλήρωσε έγκυρο key εφαρμογής πριν την αποθήκευση.'],
            administrator_required: ['Only a Nextcloud administrator can change the shared application key.', 'Μόνο ο διαχειριστής Nextcloud μπορεί να αλλάξει το κοινό key της εφαρμογής.'],
            opensubtitles_forbidden: ['OpenSubtitles rejected the API key or account access. Check the key and your account.', 'Το OpenSubtitles απέρριψε το API key ή την πρόσβαση του λογαριασμού. Έλεγξε το key και τον λογαριασμό.'],
            quota_or_rate_limit: ['The download allowance or request limit was reached. Try later; downloads are never retried automatically.', 'Έφτασες το όριο λήψεων ή αιτημάτων. Δοκίμασε αργότερα· οι λήψεις δεν επαναλαμβάνονται αυτόματα.'],
            hash_unavailable: ['Hash search needs a seekable video of at least 128 KiB. Try searching by title.', 'Το hash απαιτεί βίντεο τουλάχιστον 128 KiB με δυνατότητα ανάγνωσης συγκεκριμένων σημείων. Δοκίμασε τίτλο.'],
            invalid_video_path: ['This video URL cannot be used for hash search. Try searching by title.', 'Αυτή η διεύθυνση βίντεο δεν υποστηρίζει αναζήτηση hash. Δοκίμασε τίτλο.'],
            video_not_found: ['The video is unavailable or you do not have read permission.', 'Το βίντεο δεν είναι διαθέσιμο ή δεν έχεις δικαίωμα ανάγνωσης.'],
            invalid_query: ['Enter a movie or episode title.', 'Συμπλήρωσε τίτλο ταινίας ή επεισοδίου.'],
            response_too_large: ['The subtitle or response exceeds the size limit.', 'Ο υπότιτλος ή η απάντηση ξεπερνά το όριο μεγέθους.'],
            invalid_subtitle: ['The downloaded subtitle is not a supported UTF-8 SRT file.', 'Ο υπότιτλος που λήφθηκε δεν είναι υποστηριζόμενο αρχείο SRT UTF-8.'],
            download_failed: ['The subtitle download failed. The API may already have counted this download; retry only when ready.', 'Η λήψη υποτίτλου απέτυχε. Το API ενδέχεται να την έχει ήδη χρεώσει στο όριό σου· επανάλαβε μόνο αν θέλεις.'],
        };
        return messages[code] ? t(...messages[code]) : t('The request failed. Check the connection and try again.', 'Το αίτημα απέτυχε. Έλεγξε τη σύνδεση και δοκίμασε ξανά.');
    }

    async function flushPreferences() {
        if (saving || !pendingSave) return;
        saving = true;
        while (pendingSave) {
            const snapshot = pendingSave;
            pendingSave = null;
            try {
                await api('preferences', 'PUT', { preferences: snapshot });
                for (const view of views) view.preferenceStatus.textContent = t('Preferences saved.', 'Οι προτιμήσεις αποθηκεύτηκαν.');
            } catch (_) {
                for (const view of views) view.preferenceStatus.textContent = t('Could not save preferences. Current playback settings still apply.', 'Δεν αποθηκεύτηκαν οι προτιμήσεις. Οι ρυθμίσεις ισχύουν στην τρέχουσα αναπαραγωγή.');
            }
        }
        saving = false;
    }
    function persist(patch) {
        const oldLanguages = JSON.stringify(preferences.subtitleLanguages);
        preferences = O.normalize({ ...preferences, ...patch });
        preferenceRevision++;
        for (const view of views) {
            view.refresh();
            if (oldLanguages !== JSON.stringify(preferences.subtitleLanguages)) view.player.applyPreferredLanguage?.();
        }
        if (publicShare) {
            for (const view of views) view.preferenceStatus.textContent = t('Settings apply to this playback only.', 'Οι ρυθμίσεις ισχύουν μόνο σε αυτή την αναπαραγωγή.');
            return;
        }
        pendingSave = { ...preferences, subtitleLanguages: [...preferences.subtitleLanguages] };
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushPreferences, 400);
    }
    function initialize() {
        if (publicShare) return Promise.resolve();
        if (!initialized) initialized = (async () => {
            const revision = preferenceRevision;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 5000);
            try {
                const data = await api('settings', 'GET', undefined, controller.signal);
                if (revision === preferenceRevision) preferences = O.normalize(data.preferences);
                connection = data.connection || connection;
                canConfigureApplicationKey = data.canConfigureApplicationKey === true;
                publicLinksEnabled = data.publicLinksEnabled === true;
            } catch (_) { /* Local playback remains usable when the new backend is unavailable. */ }
            finally { clearTimeout(timeout); }
        })();
        return initialized;
    }
    function node(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    }
    function languageName(code) {
        const special = { 'pt-br': ['Portuguese (Brazil)', 'Πορτογαλικά (Βραζιλία)'], 'es-mx': ['Spanish (Latin America)', 'Ισπανικά (Λατινική Αμερική)'], 'zh-cn': ['Chinese (Simplified)', 'Κινεζικά (απλοποιημένα)'], 'zh-tw': ['Chinese (Traditional)', 'Κινεζικά (παραδοσιακά)'] };
        if (special[code]) return t(...special[code]);
        try { return new Intl.DisplayNames([language()], { type: 'language' }).of(code) || code; }
        catch (_) { return catalog.find(item => item.code === code)?.name || code; }
    }

    class OptionsView {
        constructor(player) {
            this.player = player;
            this.bindings = [];
            this.events = new AbortController();
            this.resultEvents = new AbortController();
            this.operation = null;
            this.results = [];
            this.page = 1;
            this.totalPages = 1;
            this.busy = false;
            this.dead = false;
            this.connected = false;
            this.controls = {};
            const panel = player.panel;
            const sourceFields = [...panel.querySelectorAll('.ncvs-field')];
            this.sourceSection = this.section('Subtitles', 'Υπότιτλοι', true);
            for (const field of sourceFields) this.sourceSection.append(field);
            panel.insertBefore(this.sourceSection, player.status);
            const appearance = this.section('Appearance', 'Εμφάνιση');
            const languages = this.section('Languages and encoding', 'Γλώσσες και κωδικοποίηση');
            panel.insertBefore(appearance, player.status);
            panel.insertBefore(languages, player.status);

            this.preferenceStatus = node('p', 'ncvs-pref-status');
            this.preferenceStatus.setAttribute('role', 'status');
            panel.insertBefore(this.preferenceStatus, player.status);
            this.prefControl(appearance, 'backgroundEnabled', 'checkbox', 'Subtitle background', 'Φόντο υποτίτλων');
            this.prefControl(appearance, 'backgroundColor', 'color', 'Background color', 'Χρώμα φόντου');
            this.prefControl(appearance, 'backgroundOpacity', 'range', 'Background opacity', 'Αδιαφάνεια φόντου', { min: 0, max: 1, step: 0.01 });
            this.prefControl(appearance, 'textColor', 'color', 'Text color', 'Χρώμα γραμμάτων');
            this.prefControl(appearance, 'fontSize', 'range', 'Text size (px)', 'Μέγεθος γραμμάτων (px)', { min: 14, max: 48, step: 1 });
            this.prefControl(appearance, 'verticalPosition', 'range', 'Vertical position (0 = top, 100 = bottom)', 'Θέση υποτίτλων (0 = πάνω, 100 = κάτω)', { min: 0, max: 100, step: 1 });
            this.prefControl(appearance, 'verticalOffset', 'number', 'Vertical offset (px, − = down, + = up)', 'Μετατόπιση θέσης (px, − = κάτω, + = πάνω)', { min: -200, max: 200, step: 1 });
            const offsetNote = node('p', 'ncvs-note');
            this.bind(offsetNote, 'Use a negative value to lower captions, including below position 100. The adjustment stops at the frame edges to keep captions visible. Zero restores the selected base position.', 'Βάλε αρνητική τιμή για πιο κάτω, ακόμη και χαμηλότερα από τη θέση 100. Η μετατόπιση περιορίζεται στα άκρα του βίντεο ώστε οι υπότιτλοι να μένουν ορατοί. Το 0 επαναφέρει την επιλεγμένη βασική θέση.');
            appearance.append(offsetNote);
            this.prefControl(appearance, 'shadowEnabled', 'checkbox', 'Text shadow', 'Σκιά γραμμάτων');
            this.prefControl(appearance, 'shadowDepth', 'range', 'Shadow depth (px)', 'Βάθος σκιάς (px)', { min: 0, max: 10, step: 0.5 });
            this.preview = node('div', 'ncvs-preview', 'Αα · Subtitle preview');
            appearance.append(this.preview);

            this.menu = node('select');
            this.menu.append(new Option('', 'auto'), new Option('English', 'en'), new Option('Ελληνικά', 'el'));
            this.bind(this.menu.options[0], 'Follow Nextcloud', 'Γλώσσα Nextcloud');
            this.field(languages, this.menu, 'CC+ menu language', 'Γλώσσα μενού CC+');
            this.on(this.menu, 'change', () => persist({ menuLanguage: this.menu.value }));
            this.languageSelectors = [1, 2, 3].map(priority => {
                const select = node('select');
                this.field(languages, select, `Subtitle language ${priority}`, `Γλώσσα υποτίτλων ${priority}`);
                this.on(select, 'change', () => persist({ subtitleLanguages: this.languageSelectors.map(item => item.value).filter(Boolean) }));
                return select;
            });
            // Keep the existing decoder control, including its change handler.
            languages.append(player.encoding.closest('.ncvs-field'));
            this.languageNote = node('p', 'ncvs-note');
            this.bind(this.languageNote, 'The first language is preferred for local matching; all selected languages are included in OpenSubtitles searches.', 'Η πρώτη γλώσσα προτιμάται στα τοπικά αρχεία· όλες οι επιλεγμένες γλώσσες χρησιμοποιούνται στην αναζήτηση OpenSubtitles.');
            languages.append(this.languageNote);
            this.buildSync();

            if (publicShare) {
                this.bind(this.languageNote, 'The first language is preferred for subtitles in the shared folder.', 'Η πρώτη γλώσσα προτιμάται για τους υπότιτλους στον κοινόχρηστο φάκελο.');
                const note = node('p', 'ncvs-note');
                this.bind(note, 'Read-only public link. Local subtitles stay in this browser and are never uploaded. Folder discovery reads only files already included in this share.', 'Δημόσιος σύνδεσμος μόνο για ανάγνωση. Οι τοπικοί υπότιτλοι μένουν στον browser και δεν μεταφορτώνονται. Η αυτόματη εύρεση διαβάζει μόνο αρχεία που περιλαμβάνονται ήδη σε αυτή την κοινή χρήση.');
                this.sourceSection.append(note);
                views.add(this); this.refresh(); return;
            }

            this.publicSetup = this.section('Public links (administrator)', 'Δημόσιοι σύνδεσμοι (διαχειριστής)');
            this.publicSetup.hidden = !canConfigureApplicationKey;
            this.publicEnabled = node('input'); this.publicEnabled.type = 'checkbox'; this.publicEnabled.checked = publicLinksEnabled;
            this.field(this.publicSetup, this.publicEnabled, 'Enable CC+ on read-only public links', 'Ενεργοποίηση CC+ σε δημόσιους συνδέσμους μόνο για ανάγνωση').parentElement.classList.add('ncvs-field--checkbox');
            const publicNote = node('p', 'ncvs-note');
            this.bind(publicNote, 'Off by default. Links with upload, edit or delete permissions are excluded. Guests can read shared subtitles or load a local file in browser memory; saving to Nextcloud and account access are unavailable.', 'Αρχικά ανενεργό. Εξαιρούνται σύνδεσμοι με δικαιώματα μεταφόρτωσης, επεξεργασίας ή διαγραφής. Οι επισκέπτες διαβάζουν κοινόχρηστους υπότιτλους ή φορτώνουν τοπικό αρχείο στη μνήμη του browser· η αποθήκευση στο Nextcloud και η πρόσβαση σε λογαριασμούς δεν διατίθενται.');
            this.publicSetup.append(publicNote);
            this.savePublicLinks = this.button(this.publicSetup, 'Save public link setting', 'Αποθήκευση ρύθμισης δημόσιων συνδέσμων', () => this.configurePublicLinks());
            this.publicStatus = node('p', 'ncvs-pref-status'); this.publicStatus.setAttribute('role', 'status'); this.publicSetup.append(this.publicStatus);
            panel.insertBefore(this.publicSetup, player.status);
            const online = this.section('OpenSubtitles.com', 'OpenSubtitles.com');
            panel.insertBefore(online, player.status);
            this.connectionStatus = node('p', 'ncvs-connection-status');
            this.connectionStatus.setAttribute('role', 'status');
            online.append(this.connectionStatus);
            const freeAccountNote = node('p', 'ncvs-note');
            this.bind(freeAccountNote, 'Use your free OpenSubtitles.com account within its download allowance. With the application configured by your administrator, your username and password are enough.', 'Χρησιμοποίησε τον δωρεάν λογαριασμό σου στο OpenSubtitles.com, μέσα στα όρια λήψεών του. Όταν ο διαχειριστής έχει ρυθμίσει την εφαρμογή, αρκούν το όνομα χρήστη και ο κωδικός σου.');
            online.append(freeAccountNote);
            this.applicationStatus = node('p', 'ncvs-note'); this.applicationStatus.setAttribute('role', 'status'); online.append(this.applicationStatus);
            // Do not autofill the host site's saved Nextcloud password into this third-party login.
            this.loginForm = node('form', 'ncvs-login'); this.loginForm.autocomplete = 'off';
            this.username = node('input'); this.username.type = 'text'; this.username.maxLength = 200; this.username.autocomplete = 'off'; this.username.name = 'opensubtitles_username'; this.username.required = true;
            this.password = node('input'); this.password.type = 'password'; this.password.maxLength = 1024; this.password.autocomplete = 'new-password'; this.password.name = 'opensubtitles_password'; this.password.required = true;
            this.key = node('input'); this.key.type = 'password'; this.key.maxLength = 512; this.key.autocomplete = 'new-password'; this.key.name = 'opensubtitles_application_key';
            this.field(this.loginForm, this.username, 'OpenSubtitles username', 'Όνομα χρήστη OpenSubtitles');
            this.field(this.loginForm, this.password, 'OpenSubtitles password', 'Κωδικός OpenSubtitles');
            this.keyLabel = this.field(this.loginForm, this.key, 'Personal API key (optional)', 'Προσωπικό API key (προαιρετικό)');
            const keyNote = node('p', 'ncvs-note');
            this.bind(keyNote, 'Leave the API key blank to use the application key configured by the administrator, or your previously saved personal key. An optional personal key overrides the shared one. Your password is not stored.', 'Άφησε κενό το API key για να χρησιμοποιηθεί το κοινό key του διαχειριστή ή το προσωπικό key που έχεις ήδη αποθηκεύσει. Προαιρετικά μπορείς να βάλεις δικό σου key. Ο κωδικός σου δεν αποθηκεύεται.');
            this.loginForm.append(keyNote);
            const keyLink = node('a', 'ncvs-resource-link', 'OpenSubtitles API consumers');
            keyLink.href = 'https://www.opensubtitles.com/en/consumers'; keyLink.target = '_blank'; keyLink.rel = 'noopener noreferrer';
            this.loginForm.append(keyLink);
            this.connectButton = this.button(this.loginForm, 'Connect account', 'Σύνδεση λογαριασμού'); this.connectButton.type = 'submit'; this.connectButton.classList.add('ncvs-action--primary');
            this.on(this.loginForm, 'submit', event => { event.preventDefault(); this.connect(); });
            online.append(this.loginForm);
            const accountActions = this.actions(online);
            this.disconnectButton = this.button(accountActions, 'Disconnect account', 'Αποσύνδεση λογαριασμού', () => this.disconnect());
            this.refreshLanguages = this.button(accountActions, 'Refresh available languages', 'Ανανέωση διαθέσιμων γλωσσών', () => this.getLanguages());

            this.applicationSetup = this.section('Administrator setup', 'Ρύθμιση διαχειριστή');
            this.applicationSetup.hidden = !canConfigureApplicationKey;
            const setupNote = node('p', 'ncvs-note');
            this.bind(setupNote, 'Configure one application key for this Nextcloud so users can sign in with a free account and leave their personal API key blank. The key is encrypted on the server and is never shown again.', 'Όρισε ένα key εφαρμογής για αυτό το Nextcloud, ώστε οι χρήστες να συνδέονται με δωρεάν λογαριασμό και να αφήνουν κενό το προσωπικό API key. Το κοινό key αποθηκεύεται κρυπτογραφημένο στον server και δεν εμφανίζεται ξανά.');
            this.applicationSetup.append(setupNote);
            this.applicationForm = node('form', 'ncvs-admin-form'); this.applicationForm.autocomplete = 'off';
            this.applicationKey = node('input'); this.applicationKey.type = 'password'; this.applicationKey.maxLength = 512; this.applicationKey.autocomplete = 'new-password'; this.applicationKey.name = 'opensubtitles_server_key'; this.applicationKey.required = true;
            this.field(this.applicationForm, this.applicationKey, 'Shared application API key', 'Κοινό API key εφαρμογής');
            this.saveApplicationKey = this.button(this.applicationForm, 'Save application key', 'Αποθήκευση key εφαρμογής'); this.saveApplicationKey.type = 'submit'; this.saveApplicationKey.classList.add('ncvs-action--primary');
            this.on(this.applicationForm, 'submit', event => { event.preventDefault(); this.configureApplication(); });
            this.applicationSetup.append(this.applicationForm);
            this.removeApplicationKey = this.button(this.applicationSetup, 'Remove shared application key', 'Αφαίρεση κοινού key εφαρμογής', () => this.configureApplication(true));
            const consumerLink = node('a', 'ncvs-resource-link', 'OpenSubtitles API consumers'); consumerLink.href = keyLink.href; consumerLink.target = '_blank'; consumerLink.rel = 'noopener noreferrer'; this.applicationSetup.append(consumerLink);
            online.append(this.applicationSetup);

            const websiteSection = this.section('Use the OpenSubtitles website', 'Χρήση του site OpenSubtitles');
            const websiteLink = this.bind(node('a'), 'Open OpenSubtitles.com', 'Άνοιγμα OpenSubtitles.com'); websiteLink.href = 'https://www.opensubtitles.com/en'; websiteLink.target = '_blank'; websiteLink.rel = 'noopener noreferrer'; websiteSection.append(websiteLink);
            const websiteNote = node('p', 'ncvs-note');
            this.bind(websiteNote, 'Without an application key, use the website to find and download a subtitle, then choose Load from computer in CC+. This manual route uses no API key; the website handles your own account and download limits.', 'Αν δεν έχει ρυθμιστεί key εφαρμογής, βρες και κατέβασε τον υπότιτλο από το site και μετά επίλεξε Φόρτωση από υπολογιστή στο CC+. Αυτή η χειροκίνητη επιλογή δεν χρησιμοποιεί API key· το site διαχειρίζεται τον λογαριασμό και τα όρια λήψεών σου.');
            websiteSection.append(websiteNote); online.append(websiteSection);

            this.query = node('input'); this.query.type = 'text'; this.query.maxLength = 250;
            this.field(online, this.query, 'Movie or episode title', 'Τίτλος ταινίας ή επεισοδίου');
            const metadata = node('div', 'ncvs-metadata');
            this.year = this.numberField(metadata, 'Year', 'Έτος', 1888, 2100);
            this.season = this.numberField(metadata, 'Season', 'Σεζόν', 1, 200);
            this.episode = this.numberField(metadata, 'Episode', 'Επεισόδιο', 1, 2000);
            online.append(metadata);
            const searchActions = this.actions(online);
            this.searchName = this.button(searchActions, 'Search by title', 'Αναζήτηση με τίτλο', () => this.search('name', 1)); this.searchName.classList.add('ncvs-action--primary');
            this.searchHash = this.button(searchActions, 'Search by video hash', 'Αναζήτηση με hash βίντεο', () => this.search('hash', 1));
            const privacy = node('p', 'ncvs-note');
            this.bind(privacy, 'Searching sends the title or a small file fingerprint to OpenSubtitles. The video itself is not uploaded. Downloads count against your account allowance.', 'Η αναζήτηση στέλνει τον τίτλο ή το αποτύπωμα του αρχείου στο OpenSubtitles. Το βίντεο δεν ανεβαίνει. Οι λήψεις μετρούν στο όριο του λογαριασμού σου.');
            online.append(privacy);
            this.onlineStatus = node('p', 'ncvs-online-status'); this.onlineStatus.setAttribute('role', 'status'); online.append(this.onlineStatus);
            this.resultList = node('div', 'ncvs-results'); online.append(this.resultList);
            const pages = node('div', 'ncvs-paging');
            this.previous = this.button(pages, 'Previous page', 'Προηγούμενη σελίδα', () => this.search(this.lastMode || 'name', this.page - 1));
            this.pageLabel = node('span', 'ncvs-page-label'); pages.append(this.pageLabel);
            this.next = this.button(pages, 'Next page', 'Επόμενη σελίδα', () => this.search(this.lastMode || 'name', this.page + 1));
            online.append(pages);
            this.saveButton = this.button(online, 'Save downloaded SRT beside video', 'Αποθήκευση SRT στον φάκελο του βίντεο', () => this.saveSubtitle());
            this.on(online, 'toggle', () => { if (online.open) this.updateConnection(); });
            this.addSubtitleWebsites();
            views.add(this);
            this.refresh();
        }

        bind(el, en, elText, property = 'textContent') { this.bindings.push({ el, en, elText, property }); el[property] = t(en, elText); return el; }
        on(el, event, callback) { el.addEventListener(event, callback, { signal: this.events.signal }); }
        section(en, el) {
            const details = node('details', 'ncvs-section');
            if (arguments[2]) details.open = true;
            details.append(this.bind(node('summary'), en, el));
            return details;
        }
        field(parent, control, en, el) {
            const label = node('label', 'ncvs-field');
            const title = this.bind(node('span'), en, el);
            label.append(title, control); parent.append(label); return title;
        }
        actions(parent) { const row = node('div', 'ncvs-actions'); parent.append(row); return row; }
        button(parent, en, el, callback) {
            const button = this.bind(node('button', 'ncvs-action'), en, el);
            button.type = 'button'; parent.append(button);
            if (callback) this.on(button, 'click', callback);
            return button;
        }
        numberField(parent, en, el, min, max) {
            const input = node('input'); input.type = 'number'; input.min = String(min); input.max = String(max); input.step = '1';
            this.field(parent, input, en, el); return input;
        }
        addSubtitleWebsites() {
            const section = this.section('Subtitle websites', 'Ιστότοποι υποτίτλων');
            const note = this.bind(node('p', 'ncvs-note'),
                'Find and download an SRT or VTT on a subtitle website, then choose Load from computer. If you receive a ZIP, extract the subtitle first.',
                'Βρες και κατέβασε SRT ή VTT από έναν ιστότοπο υποτίτλων και επίλεξε Φόρτωση από υπολογιστή. Αν κατέβει ZIP, αποσυμπίεσε πρώτα τον υπότιτλο.');
            const list = node('ul');
            for (const [label, url] of [
                ['OpenSubtitles.org', 'https://www.opensubtitles.org/'],
                ['SubtitleCat (Ελληνικά)', 'https://www.subtitlecat.com/subs/12/Greek.html'],
                ['Kodi subtitle add-ons', 'https://kodi.tv/addons/omega/category/subtitles/'],
            ]) {
                const item = node('li');
                const link = node('a', 'ncvs-resource-link', label);
                link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
                item.append(link); list.append(item);
            }
            section.append(note, list);
            this.player.panel.insertBefore(section, this.player.status);
        }
        buildSync() {
            this.syncSection = this.section('Sync and export', 'Συγχρονισμός και εξαγωγή');
            this.syncSection.append(this.bind(node('p', 'ncvs-note'),
                'Match a subtitle line to the moment it should start in the video. Use a second, later point if the timing drifts.',
                'Αντιστοίχισε μια γραμμή υποτίτλων στη στιγμή που πρέπει να εμφανιστεί στο βίντεο. Βάλε δεύτερο σημείο αργότερα αν ο συγχρονισμός χάνεται σταδιακά.'));
            this.syncPoints = [
                this.syncPoint('First point', 'Πρώτο σημείο'),
                this.syncPoint('Second point (optional)', 'Δεύτερο σημείο (προαιρετικό)'),
            ];
            this.syncPreview = node('input');
            this.syncPreview.type = 'checkbox';
            this.field(this.syncSection, this.syncPreview, 'Preview corrected timing', 'Προεπισκόπηση διορθωμένου συγχρονισμού')
                .parentElement.classList.add('ncvs-field--checkbox');
            this.on(this.syncPreview, 'change', () => this.applySyncPreview());
            this.syncFormat = node('select');
            this.syncFormat.append(new Option('SRT', 'srt'), new Option('WebVTT', 'vtt'));
            this.field(this.syncSection, this.syncFormat, 'Export format', 'Μορφή εξαγωγής');
            const actions = this.actions(this.syncSection);
            this.syncDownload = this.button(actions, 'Download corrected copy', 'Λήψη διορθωμένου αντιγράφου', () => this.downloadSync());
            if (!publicShare) this.syncSave = this.button(actions, 'Save beside video', 'Αποθήκευση δίπλα στο βίντεο', () => this.saveSync());
            this.button(actions, 'Clear points', 'Καθαρισμός σημείων', () => this.resetSync());
            this.syncStatus = node('p', 'ncvs-status');
            this.syncStatus.setAttribute('role', 'status');
            this.syncSection.append(this.syncStatus);
            this.player.panel.insertBefore(this.syncSection, this.player.status);
            this.on(this.player.video, 'durationchange', () => this.refreshSync());
            this.resetSync();
        }
        syncPoint(en, el) {
            const point = node('div');
            point.append(this.bind(node('strong'), en, el));
            const subtitle = this.numberField(point, 'Original subtitle start (seconds)', 'Αρχή αρχικού υποτίτλου (δευτερόλεπτα)', 0, Number.MAX_SAFE_INTEGER / 1000);
            const video = this.numberField(point, 'Correct video time (seconds)', 'Σωστός χρόνος βίντεο (δευτερόλεπτα)', 0, Number.MAX_SAFE_INTEGER / 1000);
            for (const input of [subtitle, video]) {
                input.step = '0.001';
                this.on(input, 'input', () => this.refreshSync());
            }
            const actions = this.actions(point);
            this.button(actions, 'Use displayed line', 'Χρήση τρέχουσας γραμμής', () => {
                const player = this.player;
                const cue = player.previewCues ? C.activeCueAt(player.previewCues, player.video.currentTime)
                    : C.activeCueAt(player.cues, player.video.currentTime - player.offset);
                if (!cue || player.video.ended) {
                    this.syncStatus.textContent = t('Seek to a visible subtitle line first.', 'Πήγαινε πρώτα σε σημείο όπου εμφανίζεται υπότιτλος.');
                    return;
                }
                subtitle.value = (cue.sourceStart ?? cue.start).toFixed(3);
                this.refreshSync();
            });
            this.button(actions, 'Use video time', 'Χρήση χρόνου βίντεο', () => {
                if (Number.isFinite(this.player.video.currentTime)) video.value = this.player.video.currentTime.toFixed(3);
                this.refreshSync();
            });
            this.syncSection.append(point);
            return { subtitle, video };
        }
        resetSync() {
            this.syncWrite?.abort();
            this.syncWrite = null;
            for (const { subtitle, video } of this.syncPoints) { subtitle.value = ''; video.value = ''; }
            this.syncFormat.value = /\.vtt$/i.test(this.player.loadedName || '') ? 'vtt' : 'srt';
            this.syncSection.hidden = !this.player.cues.length;
            if (this.syncSection.hidden) this.syncSection.open = false;
            this.syncPreview.checked = false;
            this.refreshSync();
        }
        refreshSync() {
            this.correctedCues = [];
            this.syncStatus.textContent = '';
            const [first, second] = this.syncPoints;
            const present = input => input.value !== '' || input.validity.badInput;
            const hasSecond = present(second.subtitle) || present(second.video);
            if (!this.syncSection.hidden && (present(first.subtitle) || present(first.video) || hasSecond)) {
                const read = ({ subtitle, video }) => ({ subtitle: subtitle.valueAsNumber, video: video.valueAsNumber });
                try {
                    this.correctedCues = C.retime(this.player.cues, read(first), hasSecond ? read(second) : null, this.player.video.duration);
                    this.syncStatus.textContent = this.correctedCues.length
                        ? this.correctedCues.length + t(' cues ready to preview or export.', ' εγγραφές έτοιμες για προεπισκόπηση ή εξαγωγή.')
                        : t('All corrected cues fall outside the video.', 'Όλες οι διορθωμένες εγγραφές πέφτουν εκτός βίντεο.');
                } catch (error) {
                    this.syncStatus.textContent = error.message === 'sync-order'
                        ? t('Both times in the second point must be later than the first.', 'Οι δύο χρόνοι του δεύτερου σημείου πρέπει να είναι μεταγενέστεροι του πρώτου.')
                        : t('Enter both times for each point using seconds from zero.', 'Συμπλήρωσε και τους δύο χρόνους κάθε σημείου σε δευτερόλεπτα από το μηδέν.');
                }
            }
            this.syncPreview.disabled = this.syncDownload.disabled = !this.correctedCues.length;
            if (this.syncPreview.disabled) this.syncPreview.checked = false;
            this.updateSyncSave();
            this.applySyncPreview();
        }
        applySyncPreview() {
            this.player.previewCues = this.syncPreview.checked ? this.correctedCues : null;
            this.player.delay.disabled = !!this.player.previewCues;
            this.player.render();
        }
        updateSyncSave() {
            if (!this.syncSave) return;
            this.syncSave.disabled = !!this.syncWrite || !this.correctedCues.length || !this.player.context?.folder || !!this.player.context.public;
        }
        correctedCopy() {
            const format = this.syncFormat.value;
            const name = O.syncName(this.player.context?.name || this.player.loadedName, format);
            const bytes = new TextEncoder().encode(C.serialize(this.correctedCues, format));
            if (bytes.length > C.MAX_BYTES) throw new Error('size');
            return { name, bytes, type: format === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8' };
        }
        syncExportError(error) {
            this.syncStatus.textContent = error.message === 'size'
                ? t('The corrected copy exceeds 2 MiB.', 'Το διορθωμένο αντίγραφο ξεπερνά τα 2 MiB.')
                : t('Could not export the corrected subtitle.', 'Δεν έγινε εξαγωγή του διορθωμένου υποτίτλου.');
        }
        downloadSync() {
            if (this.syncDownload.disabled) return;
            try {
                const { name, bytes, type } = this.correctedCopy();
                const url = URL.createObjectURL(new Blob([bytes], { type }));
                const link = node('a');
                link.href = url; link.download = name;
                this.syncSection.append(link);
                link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) { this.syncExportError(error); }
        }
        async saveSync() {
            if (publicShare || this.syncSave.disabled) return;
            const controller = new AbortController();
            this.syncWrite = controller;
            this.updateSyncSave();
            try {
                const { name, bytes, type } = this.correctedCopy();
                const response = await writeBesideVideo(this.player.context, name, bytes, type, controller.signal);
                if (!controller.signal.aborted) this.syncStatus.textContent = saveMessage(response, name);
            } catch (error) { if (!controller.signal.aborted) this.syncExportError(error); }
            finally { if (this.syncWrite === controller) { this.syncWrite = null; this.updateSyncSave(); } }
        }
        prefControl(parent, key, type, en, el, attrs = {}) {
            const input = node('input'); input.type = type;
            for (const [name, value] of Object.entries(attrs)) input[name] = String(value);
            this.field(parent, input, en, el); this.controls[key] = input;
            input.parentElement.classList.add('ncvs-field--' + type);
            const output = node('output', 'ncvs-value');
            if (type === 'range') input.parentElement.append(output);
            this.on(input, type === 'checkbox' ? 'change' : 'input', () => {
                // Let a user type the leading minus sign or replace the number.
                if (type === 'number' && (input.value === '' || !Number.isFinite(input.valueAsNumber))) return;
                persist({ [key]: type === 'checkbox' ? input.checked : type === 'color' ? input.value : Number(input.value) });
            });
            if (type === 'number') this.on(input, 'blur', () => { input.value = String(preferences[key]); });
            input.ncvsOutput = output;
        }

        refresh() {
            if (this.dead) return;
            const menuChanged = this.lastMenuLanguage !== language();
            this.lastMenuLanguage = language();
            for (const item of this.bindings) item.el[item.property] = t(item.en, item.elText);
            this.player.refreshLabels?.();
            const css = O.appearance(preferences);
            this.player.host.style.setProperty('--ncvs-background', css.background);
            this.player.host.style.setProperty('--ncvs-shadow', css.shadow);
            this.player.host.style.setProperty('--ncvs-color', css.color);
            this.player.host.style.setProperty('--ncvs-font-size', css.fontSize);
            this.player.host.style.setProperty('--ncvs-position', css.position);
            this.player.host.style.setProperty('--ncvs-offset', css.offset);
            this.player.updatePlacement?.();
            this.preview.style.color = css.color; this.preview.style.background = css.background;
            this.preview.style.textShadow = css.shadow; this.preview.style.fontSize = css.fontSize;
            for (const [key, input] of Object.entries(this.controls)) {
                if (input.type === 'checkbox') input.checked = preferences[key]; else input.value = String(preferences[key]);
                if (input.type === 'range') input.ncvsOutput.textContent = key === 'backgroundOpacity' ? Math.round(preferences[key] * 100) + '%' : String(preferences[key]);
            }
            this.controls.backgroundColor.disabled = !preferences.backgroundEnabled;
            this.controls.backgroundOpacity.disabled = !preferences.backgroundEnabled;
            this.controls.shadowDepth.disabled = !preferences.shadowEnabled;
            this.menu.value = preferences.menuLanguage;
            const languageSignature = JSON.stringify([language(), preferences.subtitleLanguages, catalog.map(entry => entry.code)]);
            if (this.languageSignature !== languageSignature) { this.populateLanguages(); this.languageSignature = languageSignature; }
            if (this.player.encoding.value !== preferences.encoding && this.player.select.value !== 'online') {
                this.player.encoding.value = preferences.encoding;
                if (this.player.bytes) this.player.applyBytes(this.player.bytes, this.player.loadedName);
            }
            if (!publicShare) { this.updateConnection(); if (menuChanged) this.renderResults(); this.updateDownloadActions(); }
        }

        populateLanguages() {
            const entries = [...catalog];
            for (const code of preferences.subtitleLanguages) if (!entries.some(item => item.code === code)) entries.push({ code, name: code });
            entries.sort((a, b) => languageName(a.code).localeCompare(languageName(b.code), language()));
            this.languageSelectors.forEach((select, at) => {
                const selected = preferences.subtitleLanguages[at] || '';
                select.replaceChildren(new Option(at === 0 ? t('Follow Nextcloud', 'Γλώσσα Nextcloud') : t('None', 'Καμία'), ''));
                select.append(...entries.map(entry => new Option(languageName(entry.code) + ' [' + entry.code + ']', entry.code)));
                select.value = selected;
            });
        }
        updateConnection() {
            if (publicShare) return;
            const active = !!connection.connected && (!connection.expiresAt || connection.expiresAt > Date.now() / 1000);
            this.connected = active;
            this.loginForm.hidden = active;
            this.disconnectButton.hidden = !active;
            this.connectionStatus.textContent = active ? t('Connected: ', 'Συνδεδεμένος: ') + connection.username : t('Not connected to OpenSubtitles.com.', 'Δεν υπάρχει σύνδεση στο OpenSubtitles.com.');
            if (!active && !this.username.value) this.username.value = connection.username || '';
            this.keyLabel.textContent = t('Personal API key (optional)', 'Προσωπικό API key (προαιρετικό)');
            this.key.required = false;
            this.applicationSetup.hidden = !canConfigureApplicationKey;
            this.publicSetup.hidden = !canConfigureApplicationKey;
            this.removeApplicationKey.hidden = !connection.applicationKeyConfigured;
            this.applicationStatus.textContent = connection.applicationKeyConfigured
                ? t('The application is configured. Sign in with your account and leave the personal API key blank.', 'Η εφαρμογή έχει ρυθμιστεί. Συνδέσου με τον λογαριασμό σου και άφησε κενό το προσωπικό API key.')
                : connection.apiKeyConfigured
                    ? t('Your saved personal API key is available; you can leave the key field blank.', 'Το αποθηκευμένο προσωπικό API key είναι διαθέσιμο· μπορείς να αφήσεις κενό το πεδίο key.')
                    : t('Online search needs the administrator to configure the application, or an optional personal API key. You can also use the website below.', 'Για online αναζήτηση χρειάζεται ρύθμιση της εφαρμογής από τον διαχειριστή ή προαιρετικό προσωπικό API key. Μπορείς επίσης να χρησιμοποιήσεις το site παρακάτω.');
            this.updateBusy();
        }
        updateBusy() {
            if (publicShare) return;
            for (const button of [this.connectButton, this.disconnectButton, this.refreshLanguages, this.searchName, this.searchHash, this.saveApplicationKey, this.removeApplicationKey, this.savePublicLinks]) button.disabled = this.busy;
            this.searchName.disabled ||= !this.connected;
            this.searchHash.disabled ||= !this.connected || !this.player.context?.path;
            this.refreshLanguages.disabled ||= !connection.apiKeyConfigured;
            this.previous.disabled = this.busy || this.page <= 1;
            this.next.disabled = this.busy || this.page >= this.totalPages;
            for (const button of this.resultList.querySelectorAll('button')) button.disabled = this.busy;
            this.updateDownloadActions();
        }
        async connect() {
            if (this.busy) return;
            this.busy = true; this.updateBusy();
            this.onlineStatus.textContent = t('Connecting…', 'Σύνδεση…');
            try {
                const data = await api('opensubtitles/connect', 'POST', { username: this.username.value, password: this.password.value, apiKey: this.key.value });
                connection = data.connection;
                for (const view of views) view.updateConnection();
                this.onlineStatus.textContent = t('Account connected. You can search for subtitles.', 'Ο λογαριασμός συνδέθηκε. Μπορείς να αναζητήσεις υπότιτλους.');
                await this.getLanguages(true);
            } catch (error) { if (!this.dead) this.onlineStatus.textContent = message(error); }
            finally { this.password.value = ''; this.key.value = ''; this.busy = false; if (!this.dead) this.updateBusy(); }
        }
        async disconnect() {
            if (this.busy) return;
            this.busy = true; this.updateBusy();
            try { const data = await api('opensubtitles/disconnect', 'POST', {}); connection = data.connection; for (const view of views) { view.results = []; view.updateConnection(); view.renderResults(); } }
            catch (error) { this.onlineStatus.textContent = message(error); }
            finally { this.busy = false; if (!this.dead) this.updateBusy(); }
        }
        async configureApplication(clear = false) {
            if (this.busy || !canConfigureApplicationKey) return;
            this.busy = true; this.updateBusy();
            try {
                const data = await api('opensubtitles/application', 'PUT', { apiKey: clear ? '' : this.applicationKey.value, clear });
                connection = data.connection;
                for (const view of views) view.updateConnection();
                this.onlineStatus.textContent = clear
                    ? t('The shared key was removed. Users can use a personal key or the website.', 'Το κοινό key αφαιρέθηκε. Οι χρήστες μπορούν να χρησιμοποιήσουν προσωπικό key ή το site.')
                    : t('Application key saved. Users can now sign in using their own free accounts without a personal API key.', 'Το key εφαρμογής αποθηκεύτηκε. Οι χρήστες μπορούν να συνδεθούν με τον δωρεάν λογαριασμό τους χωρίς προσωπικό API key.');
            } catch (error) { if (!this.dead) this.onlineStatus.textContent = message(error); }
            finally { this.applicationKey.value = ''; this.busy = false; if (!this.dead) this.updateBusy(); }
        }
        async configurePublicLinks() {
            if (this.busy || !canConfigureApplicationKey || publicShare) return;
            this.busy = true; this.updateBusy();
            try {
                const data = await api('public-links', 'PUT', { enabled: this.publicEnabled.checked });
                publicLinksEnabled = data.publicLinksEnabled === true;
                for (const view of views) view.publicEnabled.checked = publicLinksEnabled;
                this.publicStatus.textContent = t('Public link setting saved. Reopen public pages to apply it.', 'Η ρύθμιση αποθηκεύτηκε. Άνοιξε ξανά τις δημόσιες σελίδες για να εφαρμοστεί.');
            } catch (error) { if (!this.dead) this.publicStatus.textContent = message(error); }
            finally { this.busy = false; if (!this.dead) this.updateBusy(); }
        }
        async getLanguages(internal = false) {
            if (this.busy && !internal) return;
            try {
                const data = await api('opensubtitles/languages');
                if (Array.isArray(data.languages) && data.languages.length) catalog = data.languages;
                for (const view of views) view.populateLanguages();
            } catch (error) { if (!this.dead) this.onlineStatus.textContent = message(error); }
        }
        onSourceChange() {
            if (publicShare) return;
            this.operation?.abort(); this.busy = false; this.results = []; this.page = 1; this.totalPages = 1;
            this.downloaded = null; this.onlineStatus.textContent = '';
            const metadata = O.guessMetadata(this.player.context?.name || '');
            this.query.value = metadata.query;
            for (const key of ['year', 'season', 'episode']) this[key].value = metadata[key] ? String(metadata[key]) : '';
            this.renderResults(); this.updateBusy(); this.updateDownloadActions();
        }
        async search(mode, page) {
            if (this.busy || !this.connected) return;
            const player = this.player;
            const generation = player.generation;
            this.busy = true; this.operation?.abort();
            const controller = new AbortController(); this.operation = controller;
            this.results = []; this.renderResults();
            this.updateBusy(); this.onlineStatus.textContent = t('Searching…', 'Αναζήτηση…');
            try {
                const data = await api('opensubtitles/search', 'POST', { mode, query: this.query.value, videoPath: player.context?.path || '',
                    languages: currentLanguages(), page, year: Number(this.year.value), season: Number(this.season.value), episode: Number(this.episode.value) }, controller.signal);
                if (this.dead || generation !== player.generation || controller.signal.aborted) return;
                this.results = data.results || []; this.page = data.page || 1; this.totalPages = data.totalPages || 1; this.lastMode = mode;
                this.onlineStatus.textContent = this.results.length ? String(data.totalCount) + t(' subtitles found.', ' υπότιτλοι βρέθηκαν.') : t('No subtitles found. Try another title or language.', 'Δεν βρέθηκαν υπότιτλοι. Δοκίμασε διαφορετικό τίτλο ή γλώσσα.');
                if (data.moviehash) this.onlineStatus.textContent += ' · hash: ' + data.moviehash;
                this.renderResults();
            } catch (error) { if (error.name !== 'AbortError' && !this.dead && generation === player.generation) this.onlineStatus.textContent = message(error); }
            finally { if (this.operation === controller) { this.busy = false; if (!this.dead) this.updateBusy(); } }
        }
        renderResults() {
            this.resultEvents.abort(); this.resultEvents = new AbortController();
            this.resultList.replaceChildren();
            for (const result of this.results) {
                const card = node('article', 'ncvs-result');
                card.append(node('strong', '', languageName(result.language) + ' · ' + (result.release || result.title || result.fileName)));
                const badges = [];
                if (result.hashMatch) badges.push(t('Hash match', 'Ταύτιση hash'));
                if (result.trusted) badges.push(t('Trusted uploader', 'Έμπιστος αποστολέας'));
                if (result.hearingImpaired) badges.push('SDH');
                if (result.aiTranslated) badges.push(t('AI translated', 'Μετάφραση AI'));
                if (result.machineTranslated) badges.push(t('Machine translated', 'Αυτόματη μετάφραση'));
                badges.push(String(result.downloads) + t(' downloads', ' λήψεις'));
                card.append(node('p', 'ncvs-note', badges.join(' · ')));
                const button = node('button', 'ncvs-action ncvs-action--primary', t('Download & load', 'Λήψη και φόρτωση')); button.type = 'button';
                button.disabled = this.busy;
                button.addEventListener('click', () => this.download(result), { signal: this.resultEvents.signal });
                card.append(button); this.resultList.append(card);
            }
            this.pageLabel.textContent = `${this.page} / ${this.totalPages}`;
            this.updateBusy();
        }
        async download(result) {
            if (this.busy) return;
            const player = this.player;
            const generation = player.generation;
            player.manual++; player.fetchController?.abort();
            const manual = player.manual;
            this.busy = true; this.operation?.abort();
            const controller = new AbortController(); this.operation = controller;
            this.updateBusy(); this.onlineStatus.textContent = t('Downloading once using your account allowance…', 'Λήψη με χρήση του ορίου του λογαριασμού σου…');
            try {
                const data = await api('opensubtitles/download', 'POST', { fileId: result.fileId }, controller.signal);
                if (this.dead || generation !== player.generation || manual !== player.manual || controller.signal.aborted) return;
                const bytes = new TextEncoder().encode(data.text);
                window.NCVideoSubtitlesCore.parse(window.NCVideoSubtitlesCore.decode(bytes, 'utf-8'));
                player.onlineBytes = bytes; player.onlineName = data.fileName || result.fileName || 'subtitle.srt';
                player.select.querySelector('option[value="online"]')?.remove();
                player.select.append(new Option('OpenSubtitles: ' + player.onlineName, 'online'));
                player.select.value = 'online'; player.encoding.value = 'utf-8'; player.applyBytes(bytes, player.onlineName);
                this.downloaded = { bytes, language: result.language, generation };
                this.onlineStatus.textContent = t('Subtitle loaded.', 'Ο υπότιτλος φορτώθηκε.') + (data.remaining === null ? '' : t(' Downloads remaining: ', ' Διαθέσιμες λήψεις: ') + data.remaining);
                this.updateDownloadActions();
            } catch (error) { if (error.name !== 'AbortError' && !this.dead && generation === player.generation) this.onlineStatus.textContent = ['format', 'size'].includes(error.message) ? t('The downloaded subtitle could not be read.', 'Ο υπότιτλος που λήφθηκε δεν διαβάστηκε.') : message(error); }
            finally { if (this.operation === controller) { this.busy = false; if (!this.dead) this.updateBusy(); } }
        }
        updateDownloadActions() {
            if (publicShare) return;
            this.saveButton.disabled = this.busy || !this.downloaded || this.downloaded.generation !== this.player.generation || !this.player.context || this.player.context.public || this.player.select.value !== 'online';
        }
        async saveSubtitle() {
            if (publicShare || this.player.context?.public) return;
            this.updateDownloadActions();
            if (this.saveButton.disabled) return;
            const generation = this.player.generation;
            const context = this.player.context;
            const name = O.saveName(context.name, this.downloaded.language);
            this.busy = true; this.updateBusy(); this.updateDownloadActions();
            try {
                const response = await writeBesideVideo(context, name, this.downloaded.bytes, 'application/x-subrip; charset=utf-8');
                if (this.dead || generation !== this.player.generation) return;
                this.onlineStatus.textContent = saveMessage(response, name);
            } catch (_) { if (!this.dead && generation === this.player.generation) this.onlineStatus.textContent = t('Could not save the subtitle.', 'Δεν αποθηκεύτηκε ο υπότιτλος.'); }
            finally { this.busy = false; if (!this.dead) { this.updateBusy(); this.updateDownloadActions(); } }
        }
        destroy() { this.dead = true; this.operation?.abort(); this.syncWrite?.abort(); this.events.abort(); this.resultEvents.abort(); views.delete(this); if (this.password) this.password.value = ''; if (this.key) this.key.value = ''; }
    }

    window.NCVideoSubtitlesUI = { initialize, attach: player => new OptionsView(player), t, persist, publicShare,
        placementOffset: metrics => O.placementOffset(preferences, metrics),
        preferredLanguages: currentLanguages, get preferences() { return preferences; }, encodings: O.ENCODINGS };
}());
