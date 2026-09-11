/**
 * Options Page Controller
 * Manages user settings with chrome.storage.sync auto-save
 */

const DEFAULT_SETTINGS = {
  format: 'png',
  quality: 100,
  scale: 'native',
  preScroll: true,
  showToast: true,
  filenamePattern: '{title}_{date}_{time}'
};

document.addEventListener('DOMContentLoaded', () => {
  const formatGroup = document.getElementById('formatGroup');
  const qualityGroup = document.getElementById('qualityGroup');
  const qualitySlider = document.getElementById('qualitySlider');
  const qualityValue = document.getElementById('qualityValue');
  const scaleControl = document.getElementById('scaleControl');
  const preScrollToggle = document.getElementById('preScrollToggle');
  const showToastToggle = document.getElementById('showToastToggle');
  const filenamePattern = document.getElementById('filenamePattern');
  const saveStatusText = document.getElementById('saveStatusText');

  let currentSettings = { ...DEFAULT_SETTINGS };

  // 1. Load saved settings
  chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
    currentSettings = items || DEFAULT_SETTINGS;
    applySettingsToUI(currentSettings);
  });

  function applySettingsToUI(s) {
    // Format
    const radioItems = formatGroup.querySelectorAll('.radio-item');
    radioItems.forEach(item => {
      const radio = item.querySelector('input');
      if (radio.value === s.format) {
        radio.checked = true;
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    updateQualityVisibility(s.format);

    // Quality
    qualitySlider.value = s.quality;
    qualityValue.textContent = `${s.quality}%`;

    // Scale
    const scaleBtns = scaleControl.querySelectorAll('.segment-btn');
    scaleBtns.forEach(btn => {
      const btnScale = btn.dataset.scale;
      if (String(btnScale) === String(s.scale)) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    // Switches
    preScrollToggle.checked = Boolean(s.preScroll);
    showToastToggle.checked = Boolean(s.showToast);

    // Filename
    filenamePattern.value = s.filenamePattern || '{title}_{date}_{time}';
  }

  function updateQualityVisibility(format) {
    if (format === 'png') {
      qualityGroup.style.opacity = '0.4';
      qualityGroup.style.pointerEvents = 'none';
    } else {
      qualityGroup.style.opacity = '1';
      qualityGroup.style.pointerEvents = 'auto';
    }
  }

  function notifySaved() {
    saveStatusText.textContent = '修改已保存生效';
    setTimeout(() => {
      saveStatusText.textContent = '配置已即时同步';
    }, 1500);
  }

  function saveSettings() {
    chrome.storage.sync.set(currentSettings, () => {
      notifySaved();
    });
  }

  // Format change
  formatGroup.addEventListener('change', (e) => {
    if (e.target.name === 'format') {
      currentSettings.format = e.target.value;
      const radioItems = formatGroup.querySelectorAll('.radio-item');
      radioItems.forEach(item => {
        if (item.querySelector('input').checked) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
      updateQualityVisibility(currentSettings.format);
      saveSettings();
    }
  });

  // Quality slider
  qualitySlider.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    qualityValue.textContent = `${val}%`;
    currentSettings.quality = val;
  });

  qualitySlider.addEventListener('change', () => {
    saveSettings();
  });

  // Scale buttons
  scaleControl.addEventListener('click', (e) => {
    const btn = e.target.closest('.segment-btn');
    if (!btn) return;
    scaleControl.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const scaleVal = btn.dataset.scale;
    currentSettings.scale = scaleVal === 'native' ? 'native' : Number(scaleVal);
    saveSettings();
  });

  // Pre-scroll toggle
  preScrollToggle.addEventListener('change', () => {
    currentSettings.preScroll = preScrollToggle.checked;
    saveSettings();
  });

  // Toast toggle
  showToastToggle.addEventListener('change', () => {
    currentSettings.showToast = showToastToggle.checked;
    saveSettings();
  });

  // Filename pattern
  filenamePattern.addEventListener('input', () => {
    currentSettings.filenamePattern = filenamePattern.value.trim() || '{title}_{date}_{time}';
    saveSettings();
  });

  // Tag chips click to insert
  document.querySelectorAll('.tag-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const tag = chip.dataset.tag;
      const cur = filenamePattern.value;
      if (!cur.includes(tag)) {
        filenamePattern.value = cur ? `${cur}_${tag}` : tag;
        currentSettings.filenamePattern = filenamePattern.value;
        saveSettings();
      }
    });
  });
});
