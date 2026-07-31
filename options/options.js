// Settings page. Provider setup is the same component the side panel uses, so
// there is exactly one implementation of reading and writing provider config.

import { createSetupForm, loadConfig, saveConfig } from '../ui/setup.js';
import { t, applyLanguage, LANGUAGES, getLanguage } from '../ui/i18n.js';
import { applyIcons } from '../ui/icons.js';
import { createVoice } from '../sidepanel/voice.js';

const voice = createVoice();

const $ = (id) => document.getElementById(id);

const setupForm = createSetupForm($('setup-form'));

function fillLanguageSelect() {
  const select = $('language');
  select.innerHTML = '';
  for (const lang of LANGUAGES) {
    select.add(new Option(lang.label || t(lang.labelKey), lang.id));
  }
}

function fillVoiceSelect(selected) {
  const select = $('voiceUri');
  select.innerHTML = '';
  select.add(new Option(t('options.voiceAuto'), ''));
  for (const v of voice.listVoices()) select.add(new Option(`${v.name} (${v.lang})`, v.uri));
  select.value = selected || '';
  select.disabled = !voice.supported;
}

async function loadBehavior() {
  const config = await loadConfig();
  fillLanguageSelect();
  $('speakAnswers').value = config.speakAnswers ? 'on' : 'off';
  $('voiceRate').value = config.voiceRate || 1;
  fillVoiceSelect(config.voiceUri);
  // Chrome loads the voice list asynchronously, so refill when it arrives.
  voice.onVoices(() => fillVoiceSelect($('voiceUri').value || config.voiceUri));
  $('language').value = config.language || 'auto';
  $('planMode').value = config.planMode || 'auto';
  $('cdpMode').value = config.cdpMode || 'auto';
  $('streaming').value = config.streaming === false ? 'off' : 'on';
  $('currency').value = config.currency || 'USD';
  $('budgetUsd').value = config.budgetUsd || '';
  $('customInstructions').value = config.customInstructions || '';
  $('maxSteps').value = config.maxSteps;
  $('keepScreenshots').value = config.keepScreenshots;
  $('approvalMode').value = config.approvalMode;
}

$('save-behavior').addEventListener('click', async () => {
  // Re-read from storage so a provider change made in this session isn't
  // clobbered by a stale copy held in this page.
  const config = await loadConfig();
  config.language = $('language').value;
  config.resolvedLanguage = applyLanguage(config.language);
  config.planMode = $('planMode').value;
  config.cdpMode = $('cdpMode').value;
  config.streaming = $('streaming').value === 'on';
  config.currency = $('currency').value;
  config.budgetUsd = Math.max(0, Number($('budgetUsd').value) || 0);
  config.speakAnswers = $('speakAnswers').value === 'on';
  config.voiceUri = $('voiceUri').value;
  config.voiceRate = Number($('voiceRate').value) || 1;
  config.customInstructions = $('customInstructions').value.trim();
  config.maxSteps = Math.min(Math.max(Number($('maxSteps').value) || 30, 5), 100);
  config.keepScreenshots = Math.min(Math.max(Number($('keepScreenshots').value) || 0, 0), 6);
  config.approvalMode = $('approvalMode').value;
  await saveConfig(config);

  fillLanguageSelect();
  $('language').value = config.language;
  $('behavior-status').textContent = t('setup.saved');
  $('behavior-status').className = 'setup-status ok';
  setTimeout(() => ($('behavior-status').textContent = ''), 2500);
});

$('voice-preview').addEventListener('click', () => {
  const sample = getLanguage() === 'ar'
    ? 'مرحبًا، أنا أوبن إيجنت. هذه هي سرعة القراءة الحالية.'
    : 'Hello, this is OpenAgent reading an answer at the current speed.';
  voice.speak(sample, {
    lang: getLanguage(),
    voiceUri: $('voiceUri').value,
    rate: Number($('voiceRate').value) || 1,
  });
});

$('export-all').addEventListener('click', async () => {
  const { sessionHistory = [] } = await chrome.storage.local.get('sessionHistory');
  const blob = new Blob([JSON.stringify(sessionHistory, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openagent_history_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('clear-all').addEventListener('click', async () => {
  if (!confirm(t('options.eraseConfirm'))) return;
  await chrome.storage.local.clear();
  await chrome.alarms.clearAll();
  $('clear-status').textContent = t('options.erased');
  $('clear-status').className = 'setup-status ok';
  await setupForm.load();
  await loadBehavior();
});

(async () => {
  const config = await loadConfig();
  applyLanguage(config.language || 'auto');
  applyIcons();
  await setupForm.load();
  await loadBehavior();
  switchTab('setup-section'); // Initialize default tab
})();

// ----------------------------------------------------- Web Canvas / Themes

let currentThemeDomains = [];

async function loadThemes() {
  const data = await chrome.storage.local.get(null);
  const themeList = $('theme-list');
  themeList.innerHTML = '';
  
  const themes = Object.entries(data)
    .filter(([key]) => key.startsWith('customizer_'))
    .map(([key, value]) => ({ domain: key.replace('customizer_', ''), config: value }));

  if (themes.length === 0) {
    themeList.innerHTML = '<p class="hint">No themes or custom styles found. Use OpenAgent on a website to generate one!</p>';
    return;
  }

  themes.forEach(({ domain, config }) => {
    const card = document.createElement('div');
    card.style.cssText = 'padding:10px; background:var(--bg-elevated); border:1px solid var(--border); border-radius:6px; display:flex; justify-content:space-between; align-items:center; cursor:pointer;';
    card.innerHTML = `<div><strong>${domain}</strong><div class="hint" style="font-size:0.9em; margin-top:4px;">${config.theme?.bg ? 'Custom Colors ' : ''}${config.custom_css ? 'Custom CSS ' : ''}${config.hide_selectors?.length ? 'Hidden Elements' : ''}</div></div> <button class="ghost small">Edit</button>`;
    
    card.addEventListener('click', () => openThemeEditor([domain], config));
    themeList.appendChild(card);
  });
}

function openThemeEditor(domains, config) {
  $('theme-editor').classList.remove('hidden');
  $('theme-domains').value = domains.join(', ');
  currentThemeDomains = [...domains];
  
  $('theme-bg').value = config.theme?.bg || '#ffffff';
  $('theme-color').value = config.theme?.color || '#000000';
  $('theme-font').value = config.theme?.font || '';
  $('theme-hidden').value = (config.hide_selectors || []).join(', ');
  $('theme-css').value = config.custom_css || '';
  $('theme-status').textContent = '';
  
  // Track manual clears
  $('theme-bg').dataset.cleared = config.theme?.bg ? "false" : "true";
  $('theme-color').dataset.cleared = config.theme?.color ? "false" : "true";
}

$('clear-theme-bg').addEventListener('click', () => { $('theme-bg').dataset.cleared = "true"; $('theme-bg').value = "#ffffff"; });
$('clear-theme-color').addEventListener('click', () => { $('theme-color').dataset.cleared = "true"; $('theme-color').value = "#000000"; });

$('save-theme').addEventListener('click', async () => {
  const domains = $('theme-domains').value.split(',').map(d => d.trim()).filter(Boolean);
  if (!domains.length) return;
  
  const config = {
    theme: {
      bg: $('theme-bg').dataset.cleared === "true" ? "" : $('theme-bg').value,
      color: $('theme-color').dataset.cleared === "true" ? "" : $('theme-color').value,
      font: $('theme-font').value.trim()
    },
    hide_selectors: $('theme-hidden').value.split(',').map(s => s.trim()).filter(Boolean),
    custom_css: $('theme-css').value.trim()
  };
  
  const updates = {};
  
  // If the domain was changed/renamed, delete old domains that are no longer in the list
  const removedDomains = currentThemeDomains.filter(d => !domains.includes(d));
  for (const d of removedDomains) {
    await chrome.storage.local.remove(`customizer_${d}`);
  }
  
  for (const domain of domains) {
    updates[`customizer_${domain}`] = config;
  }
  
  await chrome.storage.local.set(updates);
  $('theme-status').textContent = 'Saved!';
  $('theme-status').className = 'setup-status ok';
  setTimeout(() => ($('theme-status').textContent = ''), 2500);
  
  currentThemeDomains = domains;
  loadThemes();
});

$('delete-theme').addEventListener('click', async () => {
  if (!confirm('Are you sure you want to delete this theme?')) return;
  const domains = $('theme-domains').value.split(',').map(d => d.trim()).filter(Boolean);
  for (const domain of domains) {
    await chrome.storage.local.remove(`customizer_${domain}`);
  }
  $('theme-editor').classList.add('hidden');
  loadThemes();
});

$('export-theme').addEventListener('click', () => {
  const domains = $('theme-domains').value.split(',').map(d => d.trim()).filter(Boolean);
  const config = {
    theme: {
      bg: $('theme-bg').dataset.cleared === "true" ? "" : $('theme-bg').value,
      color: $('theme-color').dataset.cleared === "true" ? "" : $('theme-color').value,
      font: $('theme-font').value.trim()
    },
    hide_selectors: $('theme-hidden').value.split(',').map(s => s.trim()).filter(Boolean),
    custom_css: $('theme-css').value.trim(),
    domains
  };
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `openagent_theme_${domains[0] || 'custom'}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('theme-import').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const config = JSON.parse(event.target.result);
      if (!config.domains || !config.domains.length) {
        alert("Invalid theme file: missing domains.");
        return;
      }
      openThemeEditor(config.domains, config);
      $('theme-status').textContent = 'Theme loaded! Click Save to apply.';
      $('theme-status').className = 'setup-status ok';
    } catch (err) {
      alert("Failed to parse JSON file.");
    }
  };
  reader.readAsText(file);
});

// Call loadThemes on start
loadThemes();

// ----------------------------------------------------- Dashboard Nav & Search

const navButtons = document.querySelectorAll('#dash-nav button');
const sections = document.querySelectorAll('.dash-content section');
const searchInput = $('dash-search');

function switchTab(targetId) {
  navButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.target === targetId);
  });
  sections.forEach(sec => {
    sec.classList.toggle('hidden', sec.id !== targetId);
    // Ensure all fields are unhidden from previous searches
    Array.from(sec.children).forEach(child => child.classList.remove('hidden'));
  });
}

navButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    if (searchInput.value) {
      searchInput.value = '';
    }
    switchTab(btn.dataset.target);
  });
});

searchInput.addEventListener('input', () => {
  const query = searchInput.value.toLowerCase().trim();
  
  if (!query) {
    const activeTarget = document.querySelector('#dash-nav button.active')?.dataset.target || 'setup-section';
    switchTab(activeTarget);
    return;
  }
  
  sections.forEach(sec => {
    let hasMatch = false;
    const h2 = sec.querySelector('h2');
    const titleMatch = h2 ? h2.textContent.toLowerCase().includes(query) : false;
    
    Array.from(sec.children).forEach(child => {
      if (child.tagName === 'H2') return;
      const text = child.textContent.toLowerCase();
      
      // If the section title matches, show everything in the section
      if (titleMatch || text.includes(query)) {
        child.classList.remove('hidden');
        hasMatch = true;
      } else {
        child.classList.add('hidden');
      }
    });
    
    if (h2) {
      h2.classList.toggle('hidden', !hasMatch && !titleMatch);
    }
    
    sec.classList.toggle('hidden', !hasMatch && !titleMatch);
  });
});

// ----------------------------------------------------- Global Usage Tracking

const usageTbody = $('usage-tbody');
const clearUsageBtn = $('clear-usage-btn');

async function loadUsage() {
  const { global_usage = {} } = await chrome.storage.local.get('global_usage');
  renderUsage(global_usage);
}

function renderUsage(usageData) {
  if (!usageTbody) return;
  usageTbody.innerHTML = '';
  const models = Object.keys(usageData);
  if (models.length === 0) {
    usageTbody.innerHTML = '<tr><td colspan="5" style="padding:20px; text-align:center; color:var(--text-muted);">No model usage recorded yet. Start using OpenAgent!</td></tr>';
    return;
  }
  
  let totalCost = 0;
  
  models.forEach(modelId => {
    const data = usageData[modelId];
    totalCost += data.costUsd || 0;
    
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid var(--border)';
    tr.innerHTML = `
      <td style="padding: 10px;"><strong>${modelId}</strong></td>
      <td style="padding: 10px;">${data.calls.toLocaleString()}</td>
      <td style="padding: 10px;">${data.input.toLocaleString()}</td>
      <td style="padding: 10px;">${data.output.toLocaleString()}</td>
      <td style="padding: 10px; color:var(--accent);">$${(data.costUsd || 0).toFixed(4)}</td>
    `;
    usageTbody.appendChild(tr);
  });
  
  // Total row
  const tr = document.createElement('tr');
  tr.style.background = 'rgba(0,0,0,0.2)';
  tr.innerHTML = `
    <td style="padding: 10px;" colspan="4"><strong>Total Estimated Cost</strong></td>
    <td style="padding: 10px; color:var(--accent);"><strong>$${totalCost.toFixed(4)}</strong></td>
  `;
  usageTbody.appendChild(tr);
}

if (clearUsageBtn) {
  clearUsageBtn.addEventListener('click', async () => {
    if (confirm('Are you sure you want to erase all global usage data?')) {
      await chrome.storage.local.remove('global_usage');
      renderUsage({});
    }
  });
}

loadUsage();
