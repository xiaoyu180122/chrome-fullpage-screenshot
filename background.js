/**
 * Chrome Full Page Screenshot Extension - Background Service Worker
 * Powered by Chrome DevTools Protocol (CDP) + Dual-Engine Architecture:
 * 1. Single-Shot Native Engine (for pages <= 16,000px): Lightning-fast 1-shot capture
 * 2. Ultra-Long Multi-Chunk Slicing Engine (for pages > 16,000px, e.g. Comics/Webtoons):
 *    Captures all the way to the bottom without any height limit, stitches on OffscreenCanvas,
 *    and deduplicates sticky/fixed navigation bars.
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

// Convert Blob to Data URL in Service Worker without DOM dependencies
async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const CHUNK_SIZE = 0x8000;
  for (let i = 0; i < len; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
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

// Send Toast ONLY AFTER capture is completely finished to guarantee NO in-page obstruction
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

function clearActionBadge(tabId, delay = 2200) {
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

          // Check for inner scrollable containers (e.g. Manga/Webtoon reader, SPA scroll containers)
          const containers = document.querySelectorAll('div, main, section, article, #app, #root, .reader, .comic-view, .viewer');
          for (let i = 0; i < Math.min(containers.length, 80); i++) {
            const el = containers[i];
            if (el.scrollHeight > docHeight && el.scrollHeight > window.innerHeight) {
              const style = window.getComputedStyle(el);
              if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'visible') {
                docHeight = Math.max(docHeight, el.scrollHeight);
              }
            }
          }

          return {
            width: Math.ceil(docWidth),
            height: Math.ceil(docHeight),
            windowHeight: window.innerHeight,
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
            const scrollStep = Math.max(window.innerHeight, 800);
            const maxScroll = Math.min(document.body.scrollHeight, 100000);
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
      // Ensure page starts at top
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

    const format = settings.format || 'png';
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    const quality = Math.min(100, Math.max(10, settings.quality || 95));

    let finalDataUrl = '';

    // =========================================================================
    // DUAL-ENGINE STRATEGY:
    // Engine A: Single-Shot (height <= 16,000px) - Instant 1-shot capture (~300ms)
    // Engine B: Ultra-Long Multi-Chunk Slicing (height > 16,000px, e.g. Comics) - No length limit!
    // =========================================================================
    const SINGLE_SHOT_THRESHOLD = 16000;

    if (finalHeight <= SINGLE_SHOT_THRESHOLD) {
      // -----------------------------------------------------------------------
      // ENGINE A: Fast Single-Shot Path
      // -----------------------------------------------------------------------
      let captureScale = settings.scale || 1;
      if (finalHeight * captureScale > 16384) {
        captureScale = 1;
      }

      await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
        width: finalWidth,
        height: finalHeight,
        deviceScaleFactor: captureScale,
        mobile: false
      });
      hasOverriddenMetrics = true;
      await new Promise(r => setTimeout(r, 260));

      const screenshotParams = {
        format: format,
        fromSurface: true,
        captureBeyondViewport: false
      };
      if (format === 'jpeg' || format === 'webp') {
        screenshotParams.quality = quality;
      }

      const screenshotResult = await sendCdp(debuggee, "Page.captureScreenshot", screenshotParams);
      if (!screenshotResult || !screenshotResult.data) {
        throw new Error("未能获取到截屏数据");
      }
      finalDataUrl = `data:${mime};base64,${screenshotResult.data}`;

    } else {
      // -----------------------------------------------------------------------
      // ENGINE B: Ultra-Long Multi-Chunk Slicing Engine (NO HEIGHT LIMIT!)
      // Slices the page in blocks of 8,000px, hides fixed elements for chunks > 0,
      // and stitches them seamlessly on high-capacity OffscreenCanvas.
      // -----------------------------------------------------------------------
      const CHUNK_HEIGHT = 8000;
      const chunks = [];
      let currentY = 0;
      let chunkIndex = 0;

      while (currentY < finalHeight) {
        const remaining = finalHeight - currentY;
        const currentChunkHeight = Math.min(CHUNK_HEIGHT, remaining);

        // Update badge to show live progress (e.g. "1/4", "2/4")
        const estTotalChunks = Math.ceil(finalHeight / CHUNK_HEIGHT);
        setActionBadge(tabId, `${chunkIndex + 1}/${estTotalChunks}`, '#2563eb');

        // Scroll to chunk offset & hide sticky/fixed elements after chunk 0
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (y, isFirstChunk) => {
            window.scrollTo(0, y);
            if (!isFirstChunk) {
              document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                if (style.position === 'fixed' || style.position === 'sticky') {
                  if (!el.dataset.fullpageOrigVis) {
                    el.dataset.fullpageOrigVis = el.style.visibility || 'visible';
                  }
                  el.style.visibility = 'hidden';
                }
              });
            }
          },
          args: [currentY, chunkIndex === 0]
        });

        // Set device metrics override for current chunk slice
        await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
          width: finalWidth,
          height: currentChunkHeight,
          deviceScaleFactor: 1,
          mobile: false
        });
        hasOverriddenMetrics = true;

        // Wait 150ms for images and layout in the new slice to render
        await new Promise(r => setTimeout(r, 160));

        // Check if page height dynamically expanded (infinite scroll / lazy loading webtoon)
        try {
          const [heightCheck] = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => Math.max(
              document.documentElement.scrollHeight,
              document.body.scrollHeight,
              document.documentElement.offsetHeight
            )
          });
          if (heightCheck && heightCheck.result > finalHeight) {
            finalHeight = heightCheck.result;
          }
        } catch (e) {}

        const chunkShot = await sendCdp(debuggee, "Page.captureScreenshot", {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        });

        if (chunkShot && chunkShot.data) {
          chunks.push({
            data: chunkShot.data,
            y: currentY,
            width: finalWidth,
            height: currentChunkHeight
          });
        }

        currentY += currentChunkHeight;
        chunkIndex++;
      }

      // Restore hidden fixed and sticky elements
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: () => {
            document.querySelectorAll('[data-fullpage-orig-vis]').forEach(el => {
              el.style.visibility = el.dataset.fullpageOrigVis === 'visible' ? '' : el.dataset.fullpageOrigVis;
              delete el.dataset.fullpageOrigVis;
            });
          }
        });
      } catch (e) {}

      // Stitch chunks onto an OffscreenCanvas
      setActionBadge(tabId, '拼接', '#8b5cf6');
      const canvas = new OffscreenCanvas(finalWidth, finalHeight);
      const ctx = canvas.getContext('2d');

      for (const chunk of chunks) {
        const resp = await fetch(`data:image/png;base64,${chunk.data}`);
        const blob = await resp.blob();
        const bitmap = await createImageBitmap(blob);
        ctx.drawImage(bitmap, 0, chunk.y, chunk.width, chunk.height);
        bitmap.close();
      }

      const finalBlob = await canvas.convertToBlob({
        type: mime,
        quality: (format === 'jpeg' || format === 'webp') ? (quality / 100) : undefined
      });
      finalDataUrl = await blobToDataUrl(finalBlob);
    }

    // 5. Clear Device Metrics Override & Restore User Scroll Position
    if (hasOverriddenMetrics) {
      try {
        await sendCdp(debuggee, "Emulation.clearDeviceMetricsOverride");
        hasOverriddenMetrics = false;
      } catch (e) {}
    }

    if (domMetrics && (domMetrics.origScrollX || domMetrics.origScrollY)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: (x, y) => window.scrollTo(x, y),
          args: [domMetrics.origScrollX, domMetrics.origScrollY]
        });
      } catch (e) {}
    }

    // 6. Build Filename and Trigger Download
    const filename = buildFilename(tab, settings, ext);
    await chrome.downloads.download({
      url: finalDataUrl,
      filename: filename,
      saveAs: false
    });

    // 7. Success Feedback: Badge on Toolbar
    setActionBadge(tabId, '✓', '#10b981');
    clearActionBadge(tabId, 2500);

    // Show toast ONLY AFTER capture and download is complete (never in the screenshot!)
    if (settings.showToast) {
      sendToast(tabId, {
        status: 'success',
        title: '长截屏已保存成功！',
        subtitle: `${finalWidth}×${finalHeight}px · 已无限制截到底`
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
      title: '📸 一键全页长截屏 (无长度限制)',
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
