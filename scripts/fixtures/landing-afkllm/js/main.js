// AFKLLM Landing Page — main.js
(function () {
  'use strict';

  // ── i18n dictionary (all values are strings) ──────────────────────────────
  const i18n = {
    ru: {
      navBrand: 'AFKLLM',
      navDownload: 'Скачать',
      navFeatures: 'Возможности',
      navHowWorks: 'Как это работает',
      navWhyLocal: 'Почему локально',
      navFooter: '© AFKLLM',
      heroTitle: 'Локальная AI IDE для Windows',
      heroSubtitle: 'Agent-first среда разработки с Monaco, llama.cpp и полной приватностью. Пишите код, запускайте модели и исследуйте проекты — всё на вашем компьютере.',
      heroBadge: 'Open Source · MIT',
      heroDownload: 'Скачать для Windows',
      heroGitHub: 'Посмотреть на GitHub',
      featuresTitle: 'Возможности',
      featureAgent: 'Agent-first IDE',
      featureAgentDesc: 'Чат и инструменты слева, редактор / браузер / терминал справа. AI-агент помогает с кодом, отладкой и навигацией по проекту.',
      featureEditor: 'Monaco Editor',
      featureEditorDesc: 'FIM ghost text, Ctrl+K inline edit, подсветка синтаксиса. Профессиональный редактор из VS Code — полностью встроено.',
      featureModels: 'Локальные модели',
      featureModelsDesc: 'GGUF read/write/patch, терминал, поиск, git, web search, MCP. Загружайте модели с Hugging Face и работайте без интернета.',
      featureVision: 'Видение и изображения',
      featureVisionDesc: 'Vision attach — прикрепляйте скриншоты и файлы. Локальная генерация изображений через FLUX / sd-cli.',
      featureGit: 'Git и приватность',
      featureGitDesc: 'Полный git workflow, терминал встроено. Core loop работает на устройстве — ваши данные не покидают компьютер.',
      featureStore: 'HF Store',
      featureStoreDesc: 'Обзор и управление моделями из Hugging Face прямо в IDE.',
      howWorksTitle: 'Как это работает',
      step1Title: 'Установите AFKLLM',
      step1Desc: 'Скачайте установщик Windows x64 с GitHub Releases и установите.',
      step2Title: 'Добавьте модели',
      step2Desc: 'Обзор Hugging Face или добавьте локальные GGUF файлы. Read/write/patch моделей на устройстве.',
      step3Title: 'Начните программировать',
      step3Desc: 'Чат с локальной моделью, используйте инструменты, редактируйте в Monaco — всё локально, без облака.',
      whyLocalTitle: 'Почему локально?',
      why1Title: 'Приватность',
      why1Desc: 'Весь цикл работы происходит на устройстве. Ваши данные, код и модели не покидают компьютер.',
      why2Title: 'Без ограничений',
      why2Desc: 'Нет лимитов на количество запросов, нет цензурных фильтров, нет зависимости от облака.',
      why3Title: 'Скорость',
      why3Desc: 'Мониторинг GPU в реальном времени. Локальная генерация работает быстрее, чем ожидание ответа от сервера.',
      downloadTitle: 'Начните сейчас',
      downloadDesc: 'Установщик Windows x64 — лицензия MIT.',
      footerGitHub: 'GitHub',
      footerReleases: 'Releases',
      footerCopy: '© 2026 AFKLLM. Open Source под лицензией MIT.',
    },
    en: {
      navBrand: 'AFKLLM',
      navDownload: 'Download',
      navFeatures: 'Features',
      navHowWorks: 'How it works',
      navWhyLocal: 'Why local?',
      navFooter: '© AFKLLM',
      heroTitle: 'Local AI IDE for Windows',
      heroSubtitle: 'Agent-first development environment with Monaco, llama.cpp and full privacy. Write code, run models and explore projects — all on your machine.',
      heroBadge: 'Open Source · MIT',
      heroDownload: 'Download for Windows',
      heroGitHub: 'View on GitHub',
      featuresTitle: 'Features',
      featureAgent: 'Agent-first IDE',
      featureAgentDesc: 'Chat and tools on the left, editor / browser / terminal on the right. AI agent helps with code, debugging and project navigation.',
      featureEditor: 'Monaco Editor',
      featureEditorDesc: 'FIM ghost text, Ctrl+K inline edit, syntax highlighting. Professional editor from VS Code — fully embedded.',
      featureModels: 'Local Models',
      featureModelsDesc: 'GGUF read/write/patch, terminal, search, git, web search, MCP. Load models from Hugging Face and work offline.',
      featureVision: 'Vision & Images',
      featureVisionDesc: 'Vision attach — attach screenshots and files. Local image generation via FLUX / sd-cli.',
      featureGit: 'Git & Privacy',
      featureGitDesc: 'Full git workflow, terminal built-in. Core loop runs on-device — your data never leaves your computer.',
      featureStore: 'HF Store',
      featureStoreDesc: 'Browse and manage models from Hugging Face directly in the IDE.',
      howWorksTitle: 'How it works',
      step1Title: 'Install AFKLLM',
      step1Desc: 'Download the Windows x64 installer from GitHub Releases and install.',
      step2Title: 'Add Models',
      step2Desc: 'Browse Hugging Face store or add local GGUF files. Read, write, patch models on-device.',
      step3Title: 'Start Coding',
      step3Desc: 'Chat with your local model, use tools, edit in Monaco — all locally, no cloud.',
      whyLocalTitle: 'Why local?',
      why1Title: 'Privacy',
      why1Desc: 'The entire workflow runs on-device. Your data, code and models never leave your computer.',
      why2Title: 'No limits',
      why2Desc: 'No request limits, no censorship filters, no cloud dependency.',
      why3Title: 'Speed',
      why3Desc: 'Real-time GPU monitoring. Local generation is faster than waiting for a server response.',
      downloadTitle: 'Get started now',
      downloadDesc: 'Windows x64 installer — MIT license.',
      footerGitHub: 'GitHub',
      footerReleases: 'Releases',
      footerCopy: '© 2026 AFKLLM. Open Source under MIT License.',
    },
  };

  // ── language toggle ─────────────────────────────────────────────────────────
  const langToggle = document.getElementById('langToggle');
  if (langToggle) {
    langToggle.addEventListener('click', function () {
      var currentLang = document.documentElement.lang;
      var nextLang = (currentLang === 'ru') ? 'en' : 'ru';
      document.documentElement.lang = nextLang;
      document.body.classList.toggle('lang-' + nextLang);
      updateTexts(nextLang);
    });
  }

  function updateTexts(lang) {
    var dict = i18n[lang];
    if (!dict) return;
    var elements = document.querySelectorAll('[data-i18n]');
    elements.forEach(function (el) {
      var key = el.getAttribute('data-i18n');
      if (dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });
  }

  // ── smooth scroll + reveal on scroll ────────────────────────────────────────
  function revealOnScroll() {
    var reveals = document.querySelectorAll('.reveal');
    reveals.forEach(function (el) {
      var rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight - 80) {
        el.classList.add('visible');
      }
    });
  }

  // ── navbar scroll effect ────────────────────────────────────────────────────
  function handleScroll() {
    var navbar = document.querySelector('.navbar');
    if (navbar) {
      if (window.scrollY > 40) {
        navbar.classList.add('scrolled');
      } else {
        navbar.classList.remove('scrolled');
      }
    }
  }

  // ── init ─────────────────────────────────────────────────────────────────────
  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('load', function () {
    revealOnScroll();
    updateTexts('ru');
  });
})();
