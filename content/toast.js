/**
 * Full Page Screenshot In-Page Toast Feedback
 * Implements Emil Kowalski craft: smooth spring animation, dark glassmorphism,
 * non-destructive host isolation using Shadow DOM.
 */

(function () {
  const HOST_ID = '__fullpage_screenshot_toast_host__';

  function getOrCreateShadowRoot() {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      host.style.position = 'fixed';
      host.style.top = '20px';
      host.style.right = '24px';
      host.style.zIndex = '2147483647';
      host.style.pointerEvents = 'none';
      document.documentElement.appendChild(host);
    }
    if (!host.shadowRoot) {
      host.attachShadow({ mode: 'open' });
    }
    return host.shadowRoot;
  }

  function renderToast(options) {
    const shadow = getOrCreateShadowRoot();
    
    // Clear existing timer if any
    if (window.__fullpage_toast_timer__) {
      clearTimeout(window.__fullpage_toast_timer__);
    }

    const {
      status = 'capturing', // 'capturing' | 'success' | 'error'
      title = '正在生成全网页长截屏...',
      subtitle = '基于 DevTools 原生引擎渲染全页内容',
      autoDismiss = status !== 'capturing'
    } = options;

    const styles = `
      :host {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      .toast-container {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: 14px;
        padding: 12px 18px;
        min-width: 280px;
        max-width: 420px;
        background: rgba(15, 23, 42, 0.92);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.05);
        color: #f8fafc;
        transform-origin: top right;
        animation: toast-in 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
      }
      .toast-container.dismissing {
        animation: toast-out 220ms cubic-bezier(0.4, 0, 1, 1) forwards;
      }
      @keyframes toast-in {
        0% {
          opacity: 0;
          transform: translateY(-16px) scale(0.96);
        }
        100% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      @keyframes toast-out {
        0% {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        100% {
          opacity: 0;
          transform: translateY(-12px) scale(0.96);
        }
      }
      .icon-box {
        flex-shrink: 0;
        width: 36px;
        height: 36px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .icon-box.capturing {
        background: rgba(59, 130, 246, 0.16);
        border: 1px solid rgba(96, 165, 250, 0.3);
        color: #60a5fa;
      }
      .icon-box.success {
        background: rgba(16, 185, 129, 0.16);
        border: 1px solid rgba(52, 211, 153, 0.3);
        color: #34d399;
      }
      .icon-box.error {
        background: rgba(239, 68, 68, 0.16);
        border: 1px solid rgba(248, 113, 113, 0.3);
        color: #f87171;
      }
      .spinner {
        width: 18px;
        height: 18px;
        border: 2.5px solid rgba(96, 165, 250, 0.3);
        border-top-color: #60a5fa;
        border-radius: 50%;
        animation: spin 700ms linear infinite;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      .text-content {
        display: flex;
        flex-direction: column;
        gap: 3px;
        overflow: hidden;
      }
      .title {
        font-size: 13.5px;
        font-weight: 600;
        color: #f8fafc;
        line-height: 1.3;
      }
      .subtitle {
        font-size: 12px;
        color: #94a3b8;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;

    let iconHtml = '';
    if (status === 'capturing') {
      iconHtml = `<div class="spinner"></div>`;
    } else if (status === 'success') {
      iconHtml = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
    } else {
      iconHtml = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
    }

    shadow.innerHTML = `
      <style>${styles}</style>
      <div class="toast-container" id="toast-el">
        <div class="icon-box ${status}">
          ${iconHtml}
        </div>
        <div class="text-content">
          <div class="title">${title}</div>
          <div class="subtitle">${subtitle}</div>
        </div>
      </div>
    `;

    const toastEl = shadow.getElementById('toast-el');

    if (autoDismiss) {
      window.__fullpage_toast_timer__ = setTimeout(() => {
        if (toastEl) {
          toastEl.classList.add('dismissing');
          setTimeout(() => {
            const host = document.getElementById(HOST_ID);
            if (host) host.remove();
          }, 240);
        }
      }, 2600);
    }
  }

  // Listen for message from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === '__FULLPAGE_SCREENSHOT_TOAST__') {
      renderToast(message.payload || {});
    }
  });
})();
