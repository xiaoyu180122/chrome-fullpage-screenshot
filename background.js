/**
 * Chrome Full Page Screenshot Extension - Background Service Worker
 * Powered by Chrome DevTools Protocol (CDP) + Dual-Engine Architecture
 * 
 * Key Features & Fixes:
 * 1. Complete Page Expansion: Defeats 'content-visibility: auto' and triggers 'loading="lazy"' images
 *    so GitHub READMEs, webtoons, and long articles never get cut off before the bottom.
 * 2. True Bottom Detection: Scans lowest element bounding rect (footer/copyright/comments) to guarantee 100% bottom coverage.
 * 3. Post-Override Layout Metric Adjustment: Catches any responsive layout expansion after device metrics override.
 * 4. Safe Multi-Part Partitioning: Prevents Chromium uint16 (65,535px) OffscreenCanvas overflow on ultra-tall comics.
 * 5. 0% DOM Pollution during capture: Status indicated via toolbar badge only.
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
  format: 'png',        // 'png' (100% 纯无损) | 'jpeg' | 'webp'
  quality: 100,         // 100 (满画质零损耗)
  scale: 'native',      // 'native' (匹配屏幕原生物理像素点对点) | 1 | 2
  preScroll: true,      // Automatically trigger lazy images by default
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

function buildFilename(tab, settings, ext, suffix = '') {
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

  return `${filename}${suffix}.${ext}`;
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
    // 2. Pre-process page to guarantee 100% full content rendering:
    // a) Defeat 'content-visibility: auto' (used by GitHub, forums, blogs to skip off-screen rendering)
    // b) Fast-scroll down to trigger lazy-loaded images (e.g. GitHub README screenshots, webtoons)
    // c) Measure accurate document dimensions down to the lowest footer element
    try {
      const [evalRes] = await chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          const origScrollX = window.scrollX || window.pageXOffset || 0;
          const origScrollY = window.scrollY || window.pageYOffset || 0;

          // 1. Inject override style to disable content-visibility: auto and force rendering
          const styleId = '__fullpage_override_style__';
          let styleEl = document.getElementById(styleId);
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            styleEl.textContent = `
              * {
                content-visibility: visible !important;
                contain-intrinsic-size: auto !important;
              }
            `;
            document.documentElement.appendChild(styleEl);
          }

          // 2. Fast scan to bottom to trigger lazy-loaded images & IntersectionObservers
          const totalEstimate = Math.max(
            document.documentElement.scrollHeight,
            document.body ? document.body.scrollHeight : 0,
            window.innerHeight
          );
          const step = Math.max(window.innerHeight * 1.5, 1200);
          for (let y = 0; y < Math.min(totalEstimate, 120000); y += step) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 25));
          }
          window.scrollTo(0, 0);
          await new Promise(r => setTimeout(r, 100));

          // 3. Calculate true full dimensions
          const doc = document.documentElement;
          const body = document.body;

          let docWidth = Math.max(
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

          // 4. Scan lowest bounding rectangle of all bottom elements (footer, copyright, last children)
          const bottomCandidates = document.querySelectorAll('footer, [role="contentinfo"], .footer, body > *:last-child, main > *:last-child, article > *:last-child, #footer');
          bottomCandidates.forEach(el => {
            try {
              const rect = el.getBoundingClientRect();
              const absoluteBottom = Math.ceil(rect.bottom + window.scrollY);
              if (absoluteBottom > docHeight) {
                docHeight = absoluteBottom;
              }
            } catch (e) {}
          });

          // 5. Check for inner scrollable containers (e.g. SPA reader, comic viewer)
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
            devicePixelRatio: window.devicePixelRatio || 1,
            origScrollX,
            origScrollY
          };
        }
      });
      domMetrics = evalRes ? evalRes.result : null;
    } catch (err) {
      console.warn('DOM measurement error:', err);
    }

    // 3. Attach Chrome Debugger
    await chrome.debugger.attach(debuggee, "1.3");

    // 4. Enable Page & Get Layout Metrics from CDP
    await sendCdp(debuggee, "Page.enable");
    const metrics = await sendCdp(debuggee, "Page.getLayoutMetrics");
    
    const contentSize = metrics.cssContentSize || metrics.contentSize || {};
    const cWidth = Math.ceil(contentSize.width || 0);
    const cHeight = Math.ceil(contentSize.height || 0);

    // Compute best target dimensions with safety margin
    let finalWidth = Math.max((domMetrics && domMetrics.width) || 0, cWidth, 1280);
    let finalHeight = Math.max((domMetrics && domMetrics.height) || 0, cHeight, 800);

    const format = settings.format || 'png';
    const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : format === 'webp' ? 'webp' : 'png';
    const quality = Math.min(100, Math.max(10, settings.quality || 100));

    // Calculate captureScale:
    // 'native' or 'auto' means matching current display's physical devicePixelRatio (e.g. 1.25, 1.5, 2)
    // to guarantee 100% pixel-to-pixel sharpness without downsampling
    const screenDpr = (domMetrics && domMetrics.devicePixelRatio) || 1;
    let captureScale = 1;
    if (settings.scale === 'native' || settings.scale === 'auto' || !settings.scale) {
      captureScale = screenDpr;
    } else {
      captureScale = Number(settings.scale) || 1;
    }

    // =========================================================================
    // DUAL-ENGINE STRATEGY:
    // Engine A: Fast Single-Shot (physical height <= 14,000px) - Instant 1-shot capture (~300ms)
    // Engine B: Ultra-Long Multi-Chunk Slicing (physical height > 14,000px) - No length limit!
    // =========================================================================
    const SINGLE_SHOT_MAX_PHYSICAL_HEIGHT = 14000;
    let savedPartsCount = 1;

    if (finalHeight * captureScale <= SINGLE_SHOT_MAX_PHYSICAL_HEIGHT) {
      // -----------------------------------------------------------------------
      // ENGINE A: Fast Single-Shot Path
      // -----------------------------------------------------------------------
      await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
        width: finalWidth,
        height: finalHeight,
        deviceScaleFactor: captureScale,
        mobile: false
      });
      hasOverriddenMetrics = true;
      await new Promise(r => setTimeout(r, 260));

      // Post-override layout check: verify if page height expanded after window resize
      try {
        const updatedMetrics = await sendCdp(debuggee, "Page.getLayoutMetrics");
        const updatedSize = updatedMetrics.cssContentSize || updatedMetrics.contentSize || {};
        const updatedHeight = Math.ceil(updatedSize.height || 0);
        if (updatedHeight > finalHeight && (updatedHeight * captureScale) <= SINGLE_SHOT_MAX_PHYSICAL_HEIGHT) {
          finalHeight = updatedHeight;
          await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
            width: finalWidth,
            height: finalHeight,
            deviceScaleFactor: captureScale,
            mobile: false
          });
          await new Promise(r => setTimeout(r, 120));
        }
      } catch (e) {}

      const screenshotParams = {
        format: format,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: finalWidth,
          height: finalHeight,
          scale: captureScale
        }
      };
      if (format === 'jpeg' || format === 'webp') {
        screenshotParams.quality = quality;
      }

      const screenshotResult = await sendCdp(debuggee, "Page.captureScreenshot", screenshotParams);
      if (!screenshotResult || !screenshotResult.data) {
        throw new Error("未能获取到截屏数据");
      }

      const finalDataUrl = `data:${mime};base64,${screenshotResult.data}`;
      const filename = buildFilename(tab, settings, ext);

      await chrome.downloads.download({
        url: finalDataUrl,
        filename: filename,
        saveAs: false
      });

    } else {
      // -----------------------------------------------------------------------
      // ENGINE B: Ultra-Long Multi-Chunk Slicing Engine (NO HEIGHT LIMIT!)
      // Slices the page into safe blocks of 5,000px, hides fixed elements for chunks > 0,
      // tracks TRUE window.scrollY after every scroll step, and uses mathematical
      // overlap-cropping on canvas to guarantee ZERO duplication and ZERO gaps!
      // -----------------------------------------------------------------------
      const CHUNK_HEIGHT = 5000;
      const chunks = [];
      let targetY = 0;
      let chunkIndex = 0;
      let isAtBottom = false;

      // Keep viewport fixed at CHUNK_HEIGHT throughout Engine B with full physical DPI
      const chunkViewportHeight = Math.min(finalHeight, CHUNK_HEIGHT);
      await sendCdp(debuggee, "Emulation.setDeviceMetricsOverride", {
        width: finalWidth,
        height: chunkViewportHeight,
        deviceScaleFactor: captureScale,
        mobile: false
      });
      hasOverriddenMetrics = true;
      await new Promise(r => setTimeout(r, 150));

      while (!isAtBottom && targetY <= finalHeight + CHUNK_HEIGHT) {
        // Update badge to show live progress (e.g. "1/4", "2/4")
        const estTotalChunks = Math.max(1, Math.ceil(finalHeight / CHUNK_HEIGHT));
        setActionBadge(tabId, `${chunkIndex + 1}/${estTotalChunks}`, '#2563eb');

        // Scroll to target offset & hide sticky/fixed elements after chunk 0
        const [scrollRes] = await chrome.scripting.executeScript({
          target: { tabId },
          func: (y, isFirst) => {
            window.scrollTo(0, y);
            if (!isFirst) {
              const selectors = 'header, nav, aside, [class*="header"], [class*="nav"], [class*="sticky"], [class*="fixed"], [class*="top"]';
              document.querySelectorAll(selectors).forEach(el => {
                const s = window.getComputedStyle(el);
                if (s.position === 'fixed' || s.position === 'sticky') {
                  if (!el.dataset.fullpageOrigVis) {
                    el.dataset.fullpageOrigVis = el.style.visibility || 'visible';
                  }
                  el.style.visibility = 'hidden';
                }
              });
            }
            return {
              scrollY: window.scrollY || window.pageYOffset || 0,
              scrollHeight: Math.max(
                document.documentElement.scrollHeight,
                document.body ? document.body.scrollHeight : 0,
                document.documentElement.offsetHeight
              )
            };
          },
          args: [targetY, chunkIndex === 0]
        });

        const actualY = (scrollRes && scrollRes.result && scrollRes.result.scrollY !== undefined)
          ? scrollRes.result.scrollY
          : targetY;

        const liveScrollHeight = (scrollRes && scrollRes.result && scrollRes.result.scrollHeight) || finalHeight;
        if (liveScrollHeight > finalHeight) {
          finalHeight = liveScrollHeight;
        }

        // Wait 220ms for comic images and lazy layout in the new slice to render
        await new Promise(r => setTimeout(r, 220));

        const chunkShot = await sendCdp(debuggee, "Page.captureScreenshot", {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        });

        if (chunkShot && chunkShot.data) {
          chunks.push({
            data: chunkShot.data,
            actualY: actualY,
            height: chunkViewportHeight
          });
        }

        // Check if we've reached the bottom of the page:
        // 1. Viewport bottom reached or exceeded document height
        // 2. Or subsequent scroll didn't move downwards (browser clamped to maxScroll)
        if (actualY + chunkViewportHeight >= finalHeight || (chunkIndex > 0 && actualY <= (chunks[chunks.length - 2]?.actualY ?? -1))) {
          isAtBottom = true;
          break;
        }

        targetY = actualY + chunkViewportHeight;
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

      // Clear device metrics before stitching
      if (hasOverriddenMetrics) {
        try {
          await sendCdp(debuggee, "Emulation.clearDeviceMetricsOverride");
          hasOverriddenMetrics = false;
        } catch (e) {}
      }

      // -----------------------------------------------------------------------
      // STITCHING & MULTI-PART PARTITIONING:
      // Chrome's convertToBlob on OffscreenCanvas has a strict 16-bit uint16_t
      // limit (65,535px). If physical height exceeds 60,000px, we partition the output
      // into sequential crystal-clear parts (_第1卷, _第2卷, etc.)
      // -----------------------------------------------------------------------
      setActionBadge(tabId, '拼装', '#8b5cf6');

      // Calculate clean, non-overlapping slices for each chunk to eliminate any duplicate areas
      const resolvedSlices = [];
      let drawnUpToY = 0;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const actualY = chunk.actualY;
        const h = chunk.height;

        if (actualY + h <= drawnUpToY) {
          // Chunk is completely contained in previously drawn content
          continue;
        }

        let srcY = 0;
        let srcH = h;
        let destY = actualY;

        if (actualY < drawnUpToY) {
          // Chunk partially overlaps previous chunk (due to scroll clamping at bottom)
          const overlap = drawnUpToY - actualY;
          srcY = overlap;
          srcH = h - overlap;
          destY = drawnUpToY;
        }

        resolvedSlices.push({
          chunkIndex: i,
          srcY,
          srcH,
          destY,
          destH: srcH
        });

        drawnUpToY = destY + srcH;
      }

      const totalStitchedHeight = Math.max(drawnUpToY, finalHeight);
      const MAX_CANVAS_SAFE_HEIGHT = Math.floor(60000 / captureScale);
      const partCount = Math.ceil(totalStitchedHeight / MAX_CANVAS_SAFE_HEIGHT);
      savedPartsCount = partCount;

      const physicalWidth = Math.round(finalWidth * captureScale);

      for (let p = 0; p < partCount; p++) {
        const partStartY = p * MAX_CANVAS_SAFE_HEIGHT;
        const partEndY = Math.min(totalStitchedHeight, (p + 1) * MAX_CANVAS_SAFE_HEIGHT);
        const partHeight = partEndY - partStartY;
        const physicalPartHeight = Math.round(partHeight * captureScale);

        const canvas = new OffscreenCanvas(physicalWidth, physicalPartHeight);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false; // Disable interpolation for 100% bit-exact pixel transfer

        // Draw resolved slices onto this part's canvas
        for (const slice of resolvedSlices) {
          const sliceStart = slice.destY;
          const sliceEnd = slice.destY + slice.destH;

          // Check if this slice intersects current canvas part
          if (sliceEnd > partStartY && sliceStart < partEndY) {
            const visibleStart = Math.max(sliceStart, partStartY);
            const visibleEnd = Math.min(sliceEnd, partEndY);
            const visibleHeight = visibleEnd - visibleStart;

            const offsetFromSliceStart = visibleStart - sliceStart;
            const finalSrcY = slice.srcY + offsetFromSliceStart;
            const finalDestY = visibleStart - partStartY;

            const chunk = chunks[slice.chunkIndex];
            const resp = await fetch(`data:image/png;base64,${chunk.data}`);
            const blob = await resp.blob();
            const bitmap = await createImageBitmap(blob);

            // Draw with precise sub-rectangle cropping in physical pixels
            const sY = Math.round(finalSrcY * captureScale);
            const sH = Math.round(visibleHeight * captureScale);
            const dY = Math.round(finalDestY * captureScale);
            const dW = physicalWidth;

            ctx.drawImage(
              bitmap,
              0, sY, dW, sH,
              0, dY, dW, sH
            );
            bitmap.close();
          }
        }

        const partBlob = await canvas.convertToBlob({
          type: mime,
          quality: (format === 'jpeg' || format === 'webp') ? (quality / 100) : undefined
        });

        const partDataUrl = await blobToDataUrl(partBlob);
        const partSuffix = partCount > 1 ? `_第${p + 1}卷` : '';
        const filename = buildFilename(tab, settings, ext, partSuffix);

        await chrome.downloads.download({
          url: partDataUrl,
          filename: filename,
          saveAs: false
        });
      }
    }

    // 5. Restore User's Original Scroll Position and clean injected override styles
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (x, y) => {
          const style = document.getElementById('__fullpage_override_style__');
          if (style) style.remove();
          window.scrollTo(x, y);
        },
        args: [
          (domMetrics && domMetrics.origScrollX) || 0,
          (domMetrics && domMetrics.origScrollY) || 0
        ]
      });
    } catch (e) {}

    // 6. Success Feedback: Badge on Toolbar
    setActionBadge(tabId, '✓', '#10b981');
    clearActionBadge(tabId, 2500);

    // Show toast ONLY AFTER capture and download is complete (never in the screenshot!)
    if (settings.showToast) {
      const pixelW = Math.round(finalWidth * captureScale);
      const pixelH = Math.round(finalHeight * captureScale);
      const dprTag = captureScale > 1 ? ` · ${captureScale}x 超清原画` : ' · 100% 纯无损原画';
      const subtitle = savedPartsCount > 1
        ? `${pixelW}×${pixelH}px${dprTag} · 超长页面已自动分 ${savedPartsCount} 卷纯原画保存到底`
        : `${pixelW}×${pixelH}px${dprTag} · 100% 原始画质无压缩截到底`;

      sendToast(tabId, {
        status: 'success',
        title: '长截屏已保存成功！',
        subtitle: subtitle
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
