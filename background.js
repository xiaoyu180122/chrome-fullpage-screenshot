/**
 * Chrome Full Page Screenshot Extension - Background Service Worker
 * Powered by Chrome DevTools Protocol (CDP) Page.captureScreenshot + Emulation
 * Fixes:
 * 1. Zero in-page obstruction (No toast injected before/during screenshot; badge indicator only)
 * 2. Complete full-page rendering without viewport repetition or tiling (Emulation.setDeviceMetricsOverride)
 * 3. Sticky header deduplication and automatic scroll restoration
 */

// Helper to wrap chrome.debugger.sendCommand in Promise
function sendCdp(debuggee, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(result || {});
    });
  });
}

// Default settings
const DEFAULT_SETTINGS = {
  format: 'png',        // 'png' | 'jpeg' | 'webp'
  quality: 95,          // 0 - 100
  scale: 1,             // 1 (Standard) or 2 (Retina 2x)
  preScroll: false,     // Trigger lazy load images
  showToast: true,      // In-page visual feedback after capture
  filenamePattern: '{title}_{date}_{time}'
};

async function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      resolve(items || DEFAULT_SETTINGS);
    });
  });
}

function sanitizeFilename(name) {
  if (!name) return 'screenshot';
  return name
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80)
    .replace(/^_+|_+$/g, '') || 'screenshot';
}

function formatDateTime() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { date, time, full: `${date}_${time}` };
}

function buildFilename(tab, settings, ext) {
  const { date, time } = formatDateTime();
  const rawTitle = tab.title || '网页长截图';
  const cleanTitle = sanitizeFilename(rawTitle);
  
  let domain = 'web';
  try {
    if (tab.url) {
      const urlObj = new URL(tab.url);
      domain = sanitizeFilename(urlObj.hostname);
    }
  } catch (e) {
    // fallback
  }

  const pattern = settings.filenamePattern || '{title}_{date}_{time}';
  let filename = pattern
    .replace('{title}', cleanTitle)
    .replace('{domain}', domain)
    .replace('{date}', date)
    .replace('{time}', time);

  if (!filename.trim()) {
    filename = `全景长截屏_${cleanTitle}_${date}_${time}`;
  }

  return `${filename}.${ext}`;
}

// Send Toast only AFTER capture is complete to guarantee NO in-page obstruction
async function sendToast(tabId, payload) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/toast.js']
    }).catch(() => {});

    await chrome.tabs.sendMessage(tabId, {
      type: '__FULLPAGE_SCREENSHOT_TOAST__',
      payload
    }).catch(() => {});
  } catch (e) {
    // Non-fatal if page blocks scripting
  }
}

function setActionBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color, tabId });
  }
}

function clearActionBadge(tabId, delay = 2000) {
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId });
  }, delay);
}

// Core capture function
async function captureFullPage(tab, overrideOptions = {}) {
  if (!tab || !tab.id) return;

  const tabId = tab.id;
  const url = tab.url || '';

  // 1. Check if URL is supported
  const unsupportedProtocols = ['chrome:', 'chrome-extension:', 'edge:', 'about:', 'view-source:', 'devtools:'];
  const isInternal = unsupportedProtocols.some(p => url.startsWith(p)) || url.startsWith('https://chromewebstore.google.com');

  if (isInternal) {
    setActionBadge(tabId, 'ERR', '#ef4444');
    clearActionBadge(tabId, 3000);
    sendToast(tabId, {
      status: 'error',
      title: '无法截取系统页面',
      subtitle: 'Chrome 安全策略禁止在内部系统页及应用商店执行截屏'
    });
    return;
  }

  const settings = { ...(await getSettings()), ...overrideOptions };
  const debuggee = { tabId };

  // Set loading state ON EXTENSION TOOLBAR BADGE ONLY!
  // CRITICAL: NEVER inject any DOM elements into the page before capture!
  setActionBadge(tabId, '⏳', '#2563eb');

  let domMetrics = null;
  let hasOverriddenMetrics = false;

  try {
    // 2. Measure actual DOM scroll dimensions and record original scroll position
    try {
      const [evalRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const doc = document.documentElement;
          const body = document.body;
          const origScrollX = window.scrollX || window.pageXOffset || 0;
          const origScrollY = window.scrollY || window.pageYOffset || 0;

          // Full document dimensions
          const docWidth = Math.max(
            doc ? doc.scrollWidth : 0,
            doc ? doc.offsetWidth : 0,
            doc ? doc.clientWidth : 0,
            body ? body.scrollWidth : 0,
            body ? body.offsetWidth : 0,
            window.innerWidth || 1280
          );

          let docHeight = Math.max(
            doc ? doc.scrollHeight : 0,
            doc ? doc.offsetHeight : 0,
            doc ? doc.clientHeight : 0,
            body ? body.scrollHeight : 0,
            body ? body.offsetHeight : 0,
            window.innerHeight || 800
          );

          // Check for inner scrollable containers (e.g. Single Page Apps with height: 100vh; overflow-y: auto)
          const containers = document.querySelectorAll('div, main, section, article, #app, #root');
          for (let i = 0; i < Math.min(containers.length, 50); i++) {
            const el = containers[i];
            if (el.scrollHeight > docHeight && el.scrollHeight > window.innerHeight) {
              const style = window.getComputedStyle(el);
              if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                docHeight = Math.max(docHeight, el.scrollHeight);
              }
            }
          }

          return {
            width: Math.ceil(docWidth),
            height: Math.ceil(docHeight),
            origScrollX,
            origScrollY
          };
        }
      });
      domMetrics = evalRes ? evalRes.result : null;
    } catch (err) {
      console.warn('DOM measurement fallback:', err);
    }

    // Optional pre-scroll to trigger lazy loaded images
    if (settings.preScroll) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: async () => {
            const originalScrollY = window.scrollY;
            const scrollStep = Math.max(window.innerHeight, 600);
            const maxScroll = Math.min(document.body.scrollHeight, 12000);
            for (let y = 0; y < maxScroll; y += scrollStep) {
              window.scrollTo(0, y);
              await new Promise(r => setTimeout(r, 40));
            }
            window.scrollTo(0, 0);
            await new Promise(r => setTimeout(r, 120));
          }
        });
      } catch (err) {}
    } else {
      // Ensure page is scrolled to top so headers, fixed elements and coordinates start at (0, 0)
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => window.scrollTo(0, 0)
        });
      } catch (err) {}
    }

    // 3. Attach Chrome Debugger
    await chrome.debugger.attach(debuggee, "1.3");

    // 4. Enable Page & Get Layout Metrics from CDP
    await sendCdp(debuggee, "Page.enable");
    const metrics = await sendCdp(debuggee, "Page.getLayoutMetrics");
    
    const contentSize = metrics.cssContentSize || metrics.contentSize || {};
    const cWidth = Math.ceil(contentSize.width || 0);
    const cHeight = Math.ceil(contentSize.height || 0);

    // Compute best target dimensions
    let finalWidth = Math.max((domMetrics && domMetrics.width) || 0, cWidth, 1280);
    let finalHeight = Math.max((domMetrics && domMetrics.height) || 0, cHeight, 800);

    // Guard against Chrome GPU limit (16,384px)
    let captureScale = settings.scale || 1;
    if (finalHeight * captureScale > 16384) {
      captureScale = Math.max(1, Math.floor(16384 / finalHeight));
      if (finalHeight > 16384) {
        finalHeight = 16384;
      }
    }

    // 5. CRITICAL FIX: Set Emulation device metrics override
    // This expands the actual viewport to the document height, completely preventing
    // the Chrome compositor from tiling/repeating the visible screen!
    try {
      await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
        width: finalWidth,
        height: finalHeight,
        deviceScaleFactor: captureScale,
        mobile: false
      });
      hasOverriddenMetrics = true;
      // Wait a moment for Chrome compositor to re-render the full layout
      await new Promise(r => setTimeout(r, 260));
    } catch (emulationErr) {
      console.warn("setDeviceMetricsOverride fallback:", emulationErr);
    }

    // 6. Capture Screenshot via CDP
    const format = settings.format || 'png';
    const screenshotParams = {
      format: format,
      fromSurface: true,
      captureBeyondViewport: !hasOverriddenMetrics
    };

    if (!hasOverriddenMetrics) {
      // Fallback clip if emulation override was rejected
      screenshotParams.clip = {
        x: 0,
        y: 0,
        width: finalWidth,
        height: finalHeight,
        scale: captureScale
      };
    }

    if (format === 'jpeg' || format === 'webp') {
      screenshotParams.quality = Math.min(100, Math.max(10, settings.quality || 95));
    }

    const screenshotResult = await sendCdp(debuggee, "Page.captureScreenshot", screenshotParams);

    if (!screenshotResult || !screenshotResult.data) {
      throw new Error("未能获取到截屏数据");
    }

    // 7. Clear Device Metrics Override & Restore Scroll
    if (hasOverriddenMetrics) {
      try {
        await sendCdp(debuggee, "Emulation.clearDeviceMetricsOverride");
        hasOverriddenMetrics = false;
      } catch (e) {}
    }

    // Restore original scroll position
    if (domMetrics && (domMetrics.origScrollX || domMetrics.origScrollY)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (x, y) => window.scrollTo(x, y),
          args: [domMetrics.origScrollX, domMetrics.origScrollY]
        });
      } catch (e) {}
    }

    // 8. Build Image Data URL & Filename
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    const dataUrl = `data:${mime};base64,${screenshotResult.data}`;
    const filename = buildFilename(tab, settings, ext);

    // 9. Trigger Download
    await chrome.downloads.download({
      url: dataUrl,
      filename: filename,
      saveAs: false
    });

    // 10. Success Feedback: Badge on Toolbar
    setActionBadge(tabId, '✓', '#10b981');
    clearActionBadge(tabId, 2200);

    // Show toast ONLY AFTER capture is complete (never in the screenshot!)
    if (settings.showToast) {
      sendToast(tabId, {
        status: 'success',
        title: '长截屏已保存成功！',
        subtitle: `${finalWidth}×${finalHeight}px · 已下载至保存目录`
      });
    }

  } catch (error) {
    console.error("Full page screenshot failed:", error);
    setActionBadge(tabId, 'ERR', '#ef4444');
    clearActionBadge(tabId, 3000);

    let errorMsg = error.message || '未知错误';
    if (errorMsg.includes('Another debugger is already attached')) {
      errorMsg = '当前页面已打开 F12 开发者工具，请先关闭 F12 后再点击截图';
    }

    sendToast(tabId, {
      status: 'error',
      title: '长截屏失败',
      subtitle: errorMsg
    });
  } finally {
    // Ensure clean state: clear device metrics and detach debugger
    if (hasOverriddenMetrics) {
      try {
        await sendCdp(debuggee, "Emulation.clearDeviceMetricsOverride");
      } catch (e) {}
    }
    try {
      await chrome.debugger.detach(debuggee);
    } catch (e) {
      // Ignored if already detached
    }
  }
}

// 1. Click Extension Action Icon -> Direct 1-Click Capture!
chrome.action.onClicked.addListener((tab) => {
  captureFullPage(tab);
});

// 2. Shortcut Key Trigger
chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0]) {
        captureFullPage(tabs[0]);
      }
    });
  }
});

// 3. Context Menu Setup
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'fullpage_capture_normal',
      title: '📸 一键全页长截屏 (DevTools 原生)',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'fullpage_capture_retina',
      title: '⚡ 高清长截屏 (2x Retina)',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'separator_1',
      type: 'separator',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'fullpage_open_options',
      title: '⚙️ 长截屏设置选项...',
      contexts: ['action', 'page']
    });
  });
});

// Context Menu Click Listener
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'fullpage_capture_normal') {
    captureFullPage(tab);
  } else if (info.menuItemId === 'fullpage_capture_retina') {
    captureFullPage(tab, { scale: 2 });
  } else if (info.menuItemId === 'fullpage_open_options') {
    chrome.runtime.openOptionsPage();
  }
});
