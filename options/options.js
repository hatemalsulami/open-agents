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
})();
