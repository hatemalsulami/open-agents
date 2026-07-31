// Provider setup UI, shared by the side panel's inline setup card.
// Single source of truth for reading/writing config, so there is no
// capture-on-the-wrong-event class of bug: every field writes straight to
// `state` on input, and `state` is what gets saved.

import { PROVIDER_INFO, DEFAULT_CONFIG, configProblem, createProvider } from '../providers/index.js';
import { MODEL_CATALOG, listModels, recommendedModel, isLikelyTextOnly } from '../providers/models.js';
import { pageLocalBridge, onLocalProgress } from './local-bridge.js';
import { t } from './i18n.js';

export async function loadConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}), providers: { ...(config?.providers || {}) } };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

/**
 * Wires up a setup form inside `root`.
 * @param {HTMLElement} root
 * @param {{ onSaved?: (config) => void }} options
 */
export function createSetupForm(root, { onSaved } = {}) {
  let state = { ...DEFAULT_CONFIG };
  let modelOptions = [];
  let autoRefreshTimer = null;
  const liveModelCache = new Map();

  root.innerHTML = '';
  const el = {};

  const field = (labelText, control, hintText) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const label = document.createElement('label');
    label.textContent = labelText;
    wrap.append(label, control);
    if (hintText) {
      const hint = document.createElement('p');
      hint.className = 'hint';
      hint.textContent = hintText;
      wrap.appendChild(hint);
    }
    root.appendChild(wrap);
    return { wrap, label };
  };

  // --- provider ---
  el.provider = document.createElement('select');
  const onDevice = document.createElement('optgroup');
  onDevice.label = t('setup.groupLocal');
  const cloud = document.createElement('optgroup');
  cloud.label = t('setup.groupCloud');
  for (const [id, info] of Object.entries(PROVIDER_INFO)) {
    (info.isLocal ? onDevice : cloud).appendChild(new Option(info.label, id));
  }
  el.provider.append(onDevice, cloud);
  field(t('setup.provider'), el.provider);

  el.providerBlurb = document.createElement('p');
  el.providerBlurb.className = 'hint';
  root.appendChild(el.providerBlurb);

  // --- api key ---
  el.apiKey = document.createElement('input');
  el.apiKey.type = 'password';
  el.apiKey.autocomplete = 'off';
  el.apiKey.spellcheck = false;
  const keyField = field(t('setup.apiKey'), el.apiKey);
  el.keyLink = document.createElement('a');
  el.keyLink.target = '_blank';
  el.keyLink.rel = 'noreferrer noopener';
  el.keyLink.className = 'key-link';
  el.keyLink.textContent = t('setup.getKey');
  keyField.label.appendChild(el.keyLink);

  // --- base url (custom only) ---
  el.baseUrl = document.createElement('input');
  el.baseUrl.type = 'text';
  el.baseUrl.placeholder = 'http://localhost:11434/v1';
  const baseUrlField = field(t('setup.baseUrl'), el.baseUrl, t('setup.baseUrlHint'));

  // --- model ---
  const modelRow = document.createElement('div');
  modelRow.className = 'model-row';
  el.model = document.createElement('select');
  el.refresh = document.createElement('button');
  el.refresh.className = 'ghost';
  el.refresh.type = 'button';
  el.refresh.title = t('setup.refresh');
  el.refresh.textContent = '⟳';
  modelRow.append(el.model, el.refresh);
  const modelField = field(t('setup.model'), modelRow);

  el.customModel = document.createElement('input');
  el.customModel.type = 'text';
  el.customModel.placeholder = t('setup.customModel');
  el.customModel.className = 'hidden';
  root.appendChild(el.customModel);

  el.modelNote = document.createElement('p');
  el.modelNote.className = 'hint';
  root.appendChild(el.modelNote);

  // --- actions ---
  const actions = document.createElement('div');
  actions.className = 'setup-actions';
  el.save = document.createElement('button');
  el.save.className = 'primary';
  el.save.type = 'button';
  el.save.textContent = t('setup.save');
  el.test = document.createElement('button');
  el.test.className = 'ghost';
  el.test.type = 'button';
  el.test.textContent = t('setup.test');
  el.status = document.createElement('span');
  el.status.className = 'setup-status';
  actions.append(el.save, el.test, el.status);
  root.appendChild(actions);

  // ---------------------------------------------------------------- helpers

  const currentSettings = () => state.providers[state.provider] || {};

  function setStatus(text, kind = '') {
    el.status.textContent = text;
    el.status.className = `setup-status ${kind}`;
  }

  function updateSetting(patch) {
    state.providers[state.provider] = { ...currentSettings(), ...patch };
  }

  function fillModelSelect(list, selected) {
    el.model.innerHTML = '';
    const seen = new Set();
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      el.model.add(new Option(m.label || m.id, m.id));
    }
    if (selected && !seen.has(selected)) {
      el.model.add(new Option(`${selected} (saved)`, selected), 0);
    }
    el.model.add(new Option(t('setup.customModelOption'), '__custom__'));
    el.model.value = selected || list[0]?.id || '__custom__';
    syncCustomModelVisibility();
  }

  function syncCustomModelVisibility() {
    const isCustom = el.model.value === '__custom__';
    el.customModel.classList.toggle('hidden', !isCustom);
    if (isCustom) el.customModel.focus();
    const chosen = isCustom ? el.customModel.value.trim() : el.model.value;
    el.modelNote.textContent = chosen && isLikelyTextOnly(chosen) ? t('setup.visionWarning') : '';
    return chosen;
  }

  function renderProviderFields() {
    const info = PROVIDER_INFO[state.provider];
    const settings = currentSettings();

    el.provider.value = state.provider;
    el.apiKey.value = settings.apiKey || '';
    el.apiKey.placeholder = info.keyPrefix ? `${info.keyPrefix}…` : 'optional';
    el.baseUrl.value = settings.baseUrl || '';
    el.providerBlurb.textContent = info.blurb || '';

    baseUrlField.wrap.classList.toggle('hidden', !info.needsBaseUrl);
    // Local engines have no key and, for built-in AI, no model choice either.
    keyField.wrap.classList.toggle('hidden', info.isLocal);
    keyField.wrap.classList.toggle('optional', !info.needsKey);
    modelField.wrap.classList.toggle('hidden', !!info.fixedModel);
    el.keyLink.classList.toggle('hidden', !info.keyUrl);
    if (info.keyUrl) el.keyLink.href = info.keyUrl;

    modelOptions = MODEL_CATALOG[state.provider] || [];
    const selected = info.fixedModel || settings.model || (info.needsBaseUrl ? '' : recommendedModel(state.provider));
    fillModelSelect(modelOptions, selected);
    // A provider with no saved model gets the recommended one immediately, so
    // "pick a provider and go" works without touching the model field.
    updateSetting({ model: selected });

    if (info.isLocal) checkLocalAvailability();
    else scheduleAutoRefresh();
  }

  // Hardcoded model lists go stale and differ per key and billing tier, which
  // shows up as a confusing 404 or a "limit: 0" quota error at run time. So
  // whenever a key is present, the real list is fetched and cached.
  function scheduleAutoRefresh() {
    clearTimeout(autoRefreshTimer);
    const info = PROVIDER_INFO[state.provider];
    if (info.isLocal) return;
    const settings = currentSettings();
    if (info.needsKey && (settings.apiKey || '').length < 12) return;
    if (info.needsBaseUrl && !settings.baseUrl) return;

    autoRefreshTimer = setTimeout(() => loadLiveModels({ silent: true }), 700);
  }

  async function loadLiveModels({ silent = false } = {}) {
    const provider = state.provider;
    if (liveModelCache.has(provider) && silent) {
      applyModelList(liveModelCache.get(provider));
      return;
    }
    if (!silent) setStatus(t('setup.loadingModels'));
    try {
      const list = await listModels(provider, currentSettings(), { localBridge: pageLocalBridge });
      if (provider !== state.provider) return; // user switched while loading
      if (!list.length) throw new Error(t('setup.noModelsReturned'));
      liveModelCache.set(provider, list);
      applyModelList(list);
      setStatus(t('setup.modelsLoaded', list.length), 'ok');
    } catch (err) {
      if (provider !== state.provider) return;
      // A silent probe must not shout: the curated list still works.
      if (!silent) setStatus(err.message, 'err');
    }
  }

  function applyModelList(list) {
    modelOptions = list;
    const saved = currentSettings().model;
    // If the saved model is not in the live list it would 404 at run time, so
    // fall back to the first model the key can actually use.
    const stillValid = list.some((m) => m.id === saved);
    const selected = stillValid ? saved : list[0]?.id;
    fillModelSelect(list, selected);
    if (!stillValid && selected) {
      updateSetting({ model: selected });
      setStatus(t('setup.modelSwitched', saved, selected), 'ok');
    }
  }

  // Local engines have real preconditions (Chrome version, WebGPU, a vendored
  // library), so the state is surfaced before the user tries to run a task.
  async function checkLocalAvailability() {
    const engine = state.provider;
    setStatus(t('setup.checkingDevice'));
    try {
      const { state: availability, detail } = await pageLocalBridge.request({ type: 'availability', engine });
      if (engine !== state.provider) return; // user moved on
      setStatus(detail, availability === 'unavailable' ? 'err' : availability === 'ready' ? 'ok' : '');
    } catch (err) {
      if (engine === state.provider) setStatus(err.message, 'err');
    }
  }

  // ----------------------------------------------------------------- events

  el.provider.addEventListener('change', () => {
    state.provider = el.provider.value;
    renderProviderFields();
    setStatus('');
  });

  el.apiKey.addEventListener('input', () => {
    updateSetting({ apiKey: el.apiKey.value.trim() });
    scheduleAutoRefresh();
  });
  el.baseUrl.addEventListener('input', () => updateSetting({ baseUrl: el.baseUrl.value.trim() }));

  el.model.addEventListener('change', () => {
    const chosen = syncCustomModelVisibility();
    if (el.model.value !== '__custom__') updateSetting({ model: chosen });
  });

  el.customModel.addEventListener('input', () => {
    updateSetting({ model: el.customModel.value.trim() });
    syncCustomModelVisibility();
  });

  el.refresh.addEventListener('click', async () => {
    liveModelCache.delete(state.provider); // explicit refresh always refetches
    el.refresh.disabled = true;
    try {
      await loadLiveModels({ silent: false });
    } finally {
      el.refresh.disabled = false;
    }
  });

  el.save.addEventListener('click', async () => {
    const problem = configProblem(state);
    if (problem) return setStatus(problem, 'err');
    await saveConfig(state);
    setStatus(t('setup.saved'), 'ok');
    onSaved?.(state);
  });

  el.test.addEventListener('click', async () => {
    const problem = configProblem(state);
    if (problem) return setStatus(problem, 'err');

    const isLocal = PROVIDER_INFO[state.provider].isLocal;
    setStatus(t(isLocal ? 'setup.startingLocal' : 'setup.testing'));
    el.test.disabled = true;

    // Weight downloads take minutes; show progress rather than looking hung.
    const stopProgress = isLocal
      ? onLocalProgress((p) => {
          const percent = p.total ? Math.round((p.loaded / p.total) * 100) : null;
          setStatus(`${p.text}${percent !== null ? ` ${percent}%` : ''}`);
        })
      : () => {};

    try {
      const provider = createProvider(state, { localBridge: pageLocalBridge });
      const response = await provider.chat({
        system: 'Connection test. Reply with the single word: ok',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: [],
      });
      await saveConfig(state);
      setStatus(t('setup.connected', (response.text || 'ok').trim().slice(0, 30)), 'ok');
      onSaved?.(state);
    } catch (err) {
      setStatus(err.message, 'err');
    } finally {
      stopProgress();
      el.test.disabled = false;
    }
  });

  return {
    async load() {
      state = await loadConfig();
      renderProviderFields();
    },
    getState: () => state,
  };
}
