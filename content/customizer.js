// Customizer: Applies AI-generated styles and hidden elements to the page.
// Runs at document_start on all pages.

(function() {
  const hostname = location.hostname;
  if (!hostname) return;

  const storageKey = `customizer_${hostname}`;

  function applyCustomizations(config) {
    if (!config) return;

    let css = '';

    // Theme (bg, color, font)
    if (config.theme) {
      if (config.theme.bg) {
        css += `html, body { background: ${config.theme.bg} !important; background-color: ${config.theme.bg} !important; }\n`;
      }
      if (config.theme.color) {
        css += `body, p, h1, h2, h3, h4, h5, h6, span, a, li, td, div { color: ${config.theme.color} !important; }\n`;
      }
      if (config.theme.font) {
        const fontName = config.theme.font;
        const fontUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;600&display=swap`;
        if (!document.querySelector(`link[href="${fontUrl}"]`)) {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = fontUrl;
          document.head?.appendChild(link);
        }
        css += `body, body * { font-family: "${fontName}", sans-serif !important; }\n`;
      }
    }

    // Hide selectors
    if (Array.isArray(config.hide_selectors) && config.hide_selectors.length > 0) {
      css += config.hide_selectors.map(sel => `${sel} { display: none !important; }`).join('\n') + '\n';
    }

    // Custom CSS
    if (config.custom_css) {
      css += config.custom_css + '\n';
    }

    if (css) {
      let styleEl = document.getElementById('openagent-customizer-style');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'openagent-customizer-style';
        if (document.head) {
          document.head.appendChild(styleEl);
        } else {
          document.documentElement.appendChild(styleEl);
        }
      }
      styleEl.textContent = css;
    } else {
      const styleEl = document.getElementById('openagent-customizer-style');
      if (styleEl) styleEl.remove();
    }
  }

  // Load immediately
  chrome.storage.local.get([storageKey]).then((data) => {
    applyCustomizations(data[storageKey]);
  });

  // Listen for live updates from the AI agent
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[storageKey]) {
      applyCustomizations(changes[storageKey].newValue);
    }
  });

  // Listen for isolation commands from the Canvas dashboard (if we are in an iframe)
  window.addEventListener('message', (event) => {
    if (event.data && event.data.__openagent && event.data.type === 'ISOLATE_ELEMENT') {
      const selector = event.data.selector;
      
      const isolateCss = `
        /* Hide everything by default */
        body > *:not(.openagent-isolated-path) { display: none !important; }
        
        /* Show the specific isolated element */
        ${selector} { 
          display: block !important; 
          visibility: visible !important; 
          opacity: 1 !important; 
        }
        
        /* Override body styles for seamless iframe embedding */
        html, body {
          background: transparent !important;
          margin: 0 !important;
          padding: 0 !important;
          overflow: hidden !important; /* The canvas widget will handle scrolling if needed */
        }
      `;
      
      let isolateStyle = document.getElementById('openagent-isolate-style');
      if (!isolateStyle) {
        isolateStyle = document.createElement('style');
        isolateStyle.id = 'openagent-isolate-style';
        if (document.head) document.head.appendChild(isolateStyle);
        else document.documentElement.appendChild(isolateStyle);
      }
      isolateStyle.textContent = isolateCss;
      
      // To ensure the element is actually visible, we need to make sure all its parents are visible too, 
      // but without showing their other children. A simple way is to tag all parents.
      const el = document.querySelector(selector);
      if (el) {
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          parent.classList.add('openagent-isolated-path');
          parent = parent.parentElement;
        }
        
        // Try to scroll it to top-left so it looks like it fits in the widget
        const rect = el.getBoundingClientRect();
        window.scrollTo({
          top: window.scrollY + rect.top,
          left: window.scrollX + rect.left,
          behavior: 'instant'
        });
      }
      
      // Phase 4: Smart Link Interception
      // Force all links inside the isolated widget to open in a new tab
      // instead of navigating the tiny iframe and breaking the dashboard.
      document.addEventListener('click', (e) => {
        const link = e.target.closest('a');
        if (link && link.href) {
          e.preventDefault();
          e.stopPropagation();
          window.open(link.href, '_blank');
        }
      }, true);
    }
  });
})();
