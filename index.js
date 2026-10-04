// WH Editor — SillyTavern extension.
//   After a reply arrives, a rule pass (editor-core.js) flags suspect lines: stock phrases, "not X, but Y" framing,
//   chopped dialogue, narration fragments, referent hedges, speech that echoes your message, phrases repeated from
//   recent replies, and your own slop list. A model you pick rewrites only those lines; nothing else changes.
//   The original is kept, and ⟲ in the message menu toggles back.
// Works alone or beside the Worldhopper Engine. The Engine runs its Ledger checks on the same reply once this is
// done (WHEditor.whenDone below), and the two share one extra.wh_edit record, so ⟲ covers both.
import { ConnectionManagerRequestService } from '../../shared.js';
import { getPresetManager } from '../../../preset-manager.js';
import { detect, buildEditorMessages, parseEditorResponse, applyEdits, looksLikeRoleplay, collapseHedges, bannedPatterns } from './editor-core.js';

const MODULE = 'wh_editor';
const LOG = '[WH Editor]';
const DEFAULTS = {
    enabled: true,
    profile: '',
    temperature: 0.2,
    maxTokens: 600,
    maxCandidates: 8,
    personal: [],
    checks: { banlist: true, contrast: true, staccato: true, hedges: true, fragments: true, echo: true, repetition: true },
};
const SKIP = ['quiet', 'impersonate', 'first_message', 'command'];

const ctx = () => SillyTavern.getContext();

function settings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) {
        // The Editor used to live inside the Worldhopper Engine: carry those settings over, once.
        const old = all.worldhopper?.editor || {};
        all[MODULE] = Object.fromEntries(Object.keys(DEFAULTS).filter(k => old[k] !== undefined).map(k => [k, structuredClone(old[k])]));
        save();
    }
    const s = all[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) if (s[k] === undefined) s[k] = structuredClone(v);
    s.checks = { ...DEFAULTS.checks, ...s.checks };
    delete s.onlyChatCompletion;   // retired: the heading switch is the on/off now
    return s;
}
const save = () => ctx().saveSettingsDebounced();

// One queue, so two replies' fixes never overlap.
let queue = Promise.resolve();
const enqueue = fn => (queue = queue.then(fn).catch(err => console.warn(LOG, err)));

// Replies being worked on, so the Engine can wait for them before its own checks.
const pending = new Map();   // mesId → promise
globalThis.WHEditor = {
    whenDone: mesId => pending.get(Number(mesId)) || Promise.resolve(),
};

// ------------------------------------------------------------------ model

function profileByName(name) {
    return ctx().extensionSettings.connectionManager?.profiles?.find(p => p.name === name);
}

/** Send messages through a connection profile (Text or Chat Completion). Returns the text, or throws. */
async function askProfile(name, messages, maxTokens, temperature) {
    if (!name) throw new Error('no model picked');
    const profile = profileByName(name);
    if (!profile) throw new Error(`connection profile “${name}” not found`);
    if (profile.mode === 'cc') {
        const custom = { stream: false, extractData: true, includePreset: true, includeInstruct: false };
        const res = await ConnectionManagerRequestService.sendRequest(profile.id, messages, maxTokens, custom, { temperature });
        return typeof res === 'string' ? res : String(res?.content ?? '');
    }
    // A background request ends on the instruct's quiet sequence, which skips the reply-turn prefill some templates
    // need (Gemma's empty thought channel), and the model then returns nothing. End on the normal reply opening.
    const custom = { stream: false, extractData: true, includePreset: true, includeInstruct: true };
    const inst = profile.instruct ? getPresetManager('instruct')?.getCompletionPresetByName(profile.instruct) : null;
    if (inst?.last_output_sequence) custom.instructSettings = { last_system_sequence: inst.last_output_sequence };
    // DRY off: it penalises copying a sentence verbatim, which is exactly what a line fix needs.
    const res = await ConnectionManagerRequestService.sendRequest(profile.id, messages, maxTokens, custom, { temperature, dry_multiplier: 0 });
    return typeof res === 'string' ? res : String(res?.content ?? '');
}

// ------------------------------------------------------------------ editing

function status(text) {
    $('#whe_status').text(text);
    console.log(LOG, text);
}

function lastReplyIndex() {
    const chat = ctx().chat || [];
    for (let i = chat.length - 1; i >= 0; i--) if (!chat[i].is_user && !chat[i].is_system) return i;
    return -1;
}

/** Your last message (for echoes) and the replies before this one (for repeats). */
function editorContext(mesId) {
    const chat = ctx().chat || [];
    let userText = '';
    const previous = [];
    for (let i = mesId - 1; i >= 0 && (previous.length < 3 || !userText); i--) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        if (m.is_user) { if (!userText) userText = m.mes || ''; }
        else if (previous.length < 3) previous.push(m.mes || '');
    }
    return { userText, previous };
}

function writeMessage(msg, text) {
    msg.mes = text;
    if (Array.isArray(msg.swipes) && typeof msg.swipe_id === 'number') msg.swipes[msg.swipe_id] = text;
}

// One record per reply, shared with the Worldhopper Engine: the text before anything changed it, and the text now.
// A second pass on the same reply extends the record, so ⟲ still goes all the way back to the original.
function recordEdit(msg, before, after, applied) {
    const prev = msg.extra?.wh_edit;
    const rec = prev && prev.edited === before
        ? { original: prev.original, edited: after, applied: [...(prev.applied || []), ...applied], at: Date.now() }
        : { original: before, edited: after, applied, at: Date.now() };
    msg.extra ??= {};
    msg.extra.wh_edit = rec;
    const info = msg.swipe_info?.[msg.swipe_id];
    if (info) { info.extra ??= {}; info.extra.wh_edit = rec; }
}

async function runEditor(mesId, { force = false } = {}) {
    const s = settings();
    const msg = ctx().chat?.[mesId];
    if (!msg || msg.is_user || msg.is_system || !msg.mes) return;
    const original = msg.mes;
    if (!looksLikeRoleplay(original)) { status('Last reply looks like notes or out-of-story work; left alone.'); return; }

    const t0 = performance.now();
    let text = original;
    const applied = [];

    // 0. pronoun hedges ("your — her — hand") collapse to the settled referent, no model needed
    if (s.checks.hedges) {
        const h = collapseHedges(text);
        text = h.text;
        applied.push(...h.applied);
    }

    // 1. rule pass, then the model fixes only the flagged lines
    const candidates = detect(text, { ...s.checks, personal: s.personal, max: s.maxCandidates }, editorContext(mesId));
    if (candidates.length) {
        try {
            const out = applyEdits(text, candidates, parseEditorResponse(await askProfile(s.profile, buildEditorMessages(text, candidates), s.maxTokens, s.temperature)), bannedPatterns(s.personal));
            text = out.text;
            applied.push(...out.applied);
            if (out.rejected.length) console.debug(LOG, 'rejected rewrites', out.rejected);
        } catch (err) {
            status(s.profile ? `Couldn't reach “${s.profile}”: ${err.message}` : 'No model picked (WH Editor → Model).');
            return;
        }
    }

    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const now = ctx().chat?.[mesId];
    if (!now || now.mes !== original) { status('The reply changed while it was being checked, so nothing was applied.'); return; }
    if (!applied.length) { status(candidates.length ? `Last reply: ${candidates.length} flagged, all kept (${secs}s).` : 'Last reply: nothing flagged.'); return; }
    writeMessage(now, text);
    recordEdit(now, original, text, applied);
    ctx().updateMessageBlock(mesId, now);
    markEdited(mesId);
    await ctx().saveChat();
    status(`Last reply: ${applied.length} fix${applied.length > 1 ? 'es' : ''} (${secs}s). ⟲ in the message menu restores the original.`);
    console.debug(LOG, 'applied', applied);
}

function editLater(mesId, opts) {
    const job = enqueue(() => runEditor(mesId, opts));
    pending.set(mesId, job);
    job.finally(() => { if (pending.get(mesId) === job) pending.delete(mesId); });
    return job;
}

function onMessageReceived(mesId, type) {
    if (!settings().enabled || SKIP.includes(type)) return;
    editLater(Number(mesId));
}

// ------------------------------------------------------------------ ⟲ (shared with the Engine)

async function toggleEdit(mesId) {
    const msg = ctx().chat?.[mesId];
    const rec = msg?.extra?.wh_edit;
    if (!rec) { toastr.info('No Worldhopper changes on this message.'); return; }
    let target;
    if (msg.mes === rec.edited) target = rec.original;
    else if (msg.mes === rec.original) target = rec.edited;
    else { toastr.warning('This message was changed after it was fixed, so it can’t be toggled.'); return; }
    writeMessage(msg, target);
    ctx().updateMessageBlock(mesId, msg);
    markEdited(mesId);
    await ctx().saveChat();
    toastr.success(target === rec.original ? 'Original reply restored.' : 'Fixes re-applied.');
}

function markEdited(mesId) {
    const msg = ctx().chat?.[mesId];
    $(`#chat .mes[mesid="${mesId}"]`).toggleClass('wh-edited', !!msg?.extra?.wh_edit);
}
function markAll() {
    $('#chat .mes').each((_, el) => markEdited(Number($(el).attr('mesid'))));
}

// The Engine adds the same button: whichever loads first adds it, and only one click handler is bound.
function addMessageButton() {
    if (!$('#message_template .wh-undo').length) {
        $('#message_template .mes_buttons .extraMesButtons').prepend('<div title="Worldhopper: toggle original / fixed" class="mes_button wh-undo fa-solid fa-rotate-left"></div>');
    }
    if (globalThis.whUndoBound) return;
    globalThis.whUndoBound = true;
    $(document).on('click', '.wh-undo', function () { toggleEdit(Number($(this).closest('.mes').attr('mesid'))); });
}

// ------------------------------------------------------------------ settings panel

function renderModelSelect() {
    const s = settings();
    const sel = $('#whe_profile').empty();
    const profiles = ctx().extensionSettings.connectionManager?.profiles || [];
    sel.append($('<option></option>').val('').text('— pick a profile —'));
    for (const p of profiles) sel.append($('<option></option>').val(p.name).text(p.name));
    if (s.profile && !profiles.some(p => p.name === s.profile)) sel.append($('<option></option>').val(s.profile).text(`${s.profile} (missing)`));
    sel.val(s.profile || '');
    $('#whe_no_profiles').toggle(!profiles.length);
}

function renderPanel() {
    const s = settings();
    $('#whe_enabled').prop('checked', s.enabled);
    $('#whe_off_note').toggle(!s.enabled);
    $('#whe_personal').val((s.personal || []).join('\n'));
    for (const k of Object.keys(DEFAULTS.checks)) $(`#whe_chk_${k}`).prop('checked', s.checks[k]);
    renderModelSelect();
}

async function addSettingsPanel() {
    const html = await (await fetch(new URL('./settings.html', import.meta.url))).text();
    $('#extensions_settings2').append(html);
    const root = $('.wh-editor-settings');
    const bind = (id, set) => $(id).on('change', function () { set(this.checked); save(); });
    // The heading's switch: a click on it mustn't also open or close the drawer it sits in.
    root.find('.wh-power').on('click', e => e.stopPropagation());
    bind('#whe_enabled', v => { settings().enabled = v; renderPanel(); });
    for (const k of Object.keys(DEFAULTS.checks)) bind(`#whe_chk_${k}`, v => { settings().checks[k] = v; });
    $('#whe_profile').on('change', function () { settings().profile = String($(this).val() || ''); save(); });
    $('#whe_personal').on('change', function () { settings().personal = String($(this).val() || '').split('\n').map(x => x.trim()).filter(Boolean); save(); });
    $('#whe_run').on('click', () => { const i = lastReplyIndex(); if (i >= 0) editLater(i, { force: true }); });
    // (?) opens a short how-to under its heading; tap again to close. Works the same on phones, unlike tooltips.
    root.on('click keydown', '.wh-help-toggle', function (e) {
        if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        e.stopPropagation();
        const key = $(this).data('help');
        const open = !$(this).hasClass('wh-on');
        $(this).toggleClass('wh-on', open);
        root.find(`.wh-help[data-help="${key}"]`).toggleClass('wh-open', open);
    });
    renderPanel();
}

function addSlashCommand() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'wh-edit',
        callback: async (_args, value) => {
            const id = String(value ?? '').trim() ? Number(value) : lastReplyIndex();
            if (id >= 0) await editLater(id, { force: true });
            return '';
        },
        unnamedArgumentList: [SlashCommandArgument.fromProps({ description: 'message id (default: the last reply)', typeList: [ARGUMENT_TYPE.NUMBER], isRequired: false })],
        helpString: 'Run the WH Editor on a message now, even while it is off.',
    }));
}

jQuery(async () => {
    try {
        settings();
        await addSettingsPanel();
        addMessageButton();
        addSlashCommand();
        const { eventSource, event_types } = ctx();
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, () => setTimeout(markAll, 0));
        for (const ev of [event_types.CHARACTER_MESSAGE_RENDERED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_SWIPED]) {
            if (ev) eventSource.on(ev, id => setTimeout(() => markEdited(Number(id)), 0));
        }
        if (event_types.MORE_MESSAGES_LOADED) eventSource.on(event_types.MORE_MESSAGES_LOADED, () => setTimeout(markAll, 0));
        for (const ev of [event_types.CONNECTION_PROFILE_CREATED, event_types.CONNECTION_PROFILE_DELETED, event_types.CONNECTION_PROFILE_UPDATED]) {
            if (ev) eventSource.on(ev, () => setTimeout(renderModelSelect, 0));
        }
        console.log(LOG, 'loaded');
    } catch (err) {
        console.error(LOG, 'failed to load', err);
    }
});
