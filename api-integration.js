const PHASE_LABELS = {
  extracting: 'Extracting slides...',
  translating: 'Translating text...',
  rtl: 'Applying RTL transforms...',
  quality: 'Running quality checks...',
  done: 'Done!'
};

class SlideArabiAPI {
  constructor(baseUrl = 'https://slidearabi-production.up.railway.app') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async uploadFile(file) {
    this.#validateFile(file);
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(`${this.baseUrl}/convert`, {
      method: 'POST',
      body: formData
    });

    const payload = await this.#parseJson(response);
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || 'Upload failed. Please try again.');
    }

    return {
      job_id: payload.job_id,
      status: payload.status || 'queued',
      slide_count: Number(payload.slide_count || payload.total_slides || 0)
    };
  }

  async getStatus(jobId) {
    const response = await fetch(`${this.baseUrl}/status/${encodeURIComponent(jobId)}`);
    const payload = await this.#parseJson(response);
    if (!response.ok) {
      throw new Error(payload?.detail || 'Could not get conversion status.');
    }

    return {
      status: payload.status,
      progress_pct: Number(payload.progress_pct ?? 0),
      current_phase: payload.current_phase || this.#derivePhaseFromStatus(payload.status),
      preview_url: payload.preview_url || null
    };
  }

  async getPreview(jobId) {
    const response = await fetch(`${this.baseUrl}/preview/${encodeURIComponent(jobId)}`);
    const payload = await this.#parseJson(response);
    if (!response.ok) {
      throw new Error(payload?.detail || 'Could not fetch preview.');
    }

    return {
      preview_slides: Array.isArray(payload.preview_slides) ? payload.preview_slides : [],
      total_slides: Number(payload.total_slides || 0)
    };
  }

  async getDownload(jobId) {
    const response = await fetch(`${this.baseUrl}/download/${encodeURIComponent(jobId)}`);
    if (!response.ok) {
      let detail = 'Download failed.';
      try {
        const payload = await response.json();
        detail = payload?.detail || detail;
      } catch {
        /* noop */
      }
      throw new Error(detail);
    }
    return response.blob();
  }

  async createCheckoutSession(jobId, slideCount) {
    const response = await fetch(`${this.baseUrl}/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, slide_count: Number(slideCount || 0) })
    });

    const payload = await this.#parseJson(response);
    if (!response.ok) {
      throw new Error(payload?.detail || payload?.error || 'Could not start checkout.');
    }

    return { checkout_url: payload.checkout_url, session_id: payload.session_id || null };
  }

  async verifyPayment(sessionId, jobId) {
    const response = await fetch(`${this.baseUrl}/verify-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, job_id: jobId })
    });

    const payload = await this.#parseJson(response);
    if (!response.ok) {
      throw new Error(payload?.detail || 'Payment verification failed.');
    }

    return {
      verified: Boolean(payload.verified),
      status: payload.status || (payload.verified ? 'paid' : 'pending')
    };
  }

  #validateFile(file) {
    if (!file) throw new Error('Please choose a file first.');
    if (!/\.pptx$/i.test(file.name)) {
      throw new Error('Only .pptx files are supported.');
    }
    const maxBytes = 50 * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new Error('File is too large. Maximum size is 50MB.');
    }
  }

  async #parseJson(response) {
    try {
      return await response.json();
    } catch {
      return {};
    }
  }

  #derivePhaseFromStatus(status) {
    if (status === 'queued') return 'extracting';
    if (status === 'processing') return 'translating';
    if (status === 'completed') return 'done';
    return 'extracting';
  }
}

class GeoPricing {
  static PRICING = {
    SA: { currency: 'SAR', perSlide: 5, symbol: 'ر.س', name: 'Saudi Arabia' },
    AE: { currency: 'AED', perSlide: 5, symbol: 'د.إ', name: 'UAE' },
    EG: { currency: 'EGP', perSlide: 50, symbol: 'ج.م', name: 'Egypt' },
    BH: { currency: 'AED', perSlide: 5, symbol: 'د.إ', name: 'Bahrain' },
    KW: { currency: 'AED', perSlide: 5, symbol: 'د.إ', name: 'Kuwait' },
    OM: { currency: 'AED', perSlide: 5, symbol: 'د.إ', name: 'Oman' },
    QA: { currency: 'AED', perSlide: 5, symbol: 'د.إ', name: 'Qatar' },
    DEFAULT: { currency: 'USD', perSlide: 1, symbol: '$', name: 'International' }
  };

  static detect() {
    const locale = navigator.language || 'en-US';
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const localeRegion = locale.split('-')[1]?.toUpperCase();

    let countryCode = 'DEFAULT';
    if (localeRegion && this.PRICING[localeRegion]) {
      countryCode = localeRegion;
    } else {
      if (/Riyadh/i.test(tz)) countryCode = 'SA';
      else if (/Dubai/i.test(tz)) countryCode = 'AE';
      else if (/Cairo/i.test(tz)) countryCode = 'EG';
    }

    return { countryCode, ...this.PRICING[countryCode] };
  }

  static calculate(slideCount, countryCode = 'DEFAULT') {
    const pricing = this.PRICING[countryCode] || this.PRICING.DEFAULT;
    const total = Math.max(0, Number(slideCount || 0)) * pricing.perSlide;
    return {
      total,
      perSlide: pricing.perSlide,
      currency: pricing.currency,
      symbol: pricing.symbol,
      countryCode,
      name: pricing.name
    };
  }

  static formatPrice(amount, currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        maximumFractionDigits: currency === 'USD' ? 2 : 0
      }).format(amount);
    } catch {
      return `${amount} ${currency}`;
    }
  }
}

class UploadManager {
  constructor(dropZoneId, onUploadStart, onProgress, onComplete, onError) {
    this.dropZone = document.getElementById(dropZoneId);
    this.onUploadStart = onUploadStart;
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this.fileInput = null;

    if (!this.dropZone) throw new Error(`Upload zone #${dropZoneId} not found.`);
    this.#init();
  }

  #init() {
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation';
    this.fileInput.style.display = 'none';
    document.body.appendChild(this.fileInput);

    this.dropZone.addEventListener('click', () => this.fileInput.click());
    this.fileInput.addEventListener('change', (event) => {
      const file = event.target.files?.[0];
      if (file) this.#handleFile(file);
    });

    ['dragenter', 'dragover'].forEach((eventName) => {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.dropZone.classList.add('drag-over');
      });
    });

    ['dragleave', 'drop'].forEach((eventName) => {
      this.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.dropZone.classList.remove('drag-over');
      });
    });

    this.dropZone.addEventListener('drop', (event) => {
      const file = event.dataTransfer?.files?.[0];
      if (file) this.#handleFile(file);
    });
  }

  #handleFile(file) {
    try {
      if (!/\.pptx$/i.test(file.name)) {
        throw new Error('Please upload a .pptx file.');
      }
      if (file.size > 50 * 1024 * 1024) {
        throw new Error('Maximum file size is 50MB.');
      }

      this.onUploadStart?.(file);
      this.onProgress?.({ value: 15, message: 'Uploading file...' });
      setTimeout(() => this.onProgress?.({ value: 35, message: 'Starting conversion job...' }), 450);
      this.onComplete?.(file);
    } catch (error) {
      this.onError?.(error);
    }
  }
}

class ConversionTracker {
  constructor(api, onStatusUpdate, onPreviewReady, onComplete, onError) {
    this.api = api;
    this.onStatusUpdate = onStatusUpdate;
    this.onPreviewReady = onPreviewReady;
    this.onComplete = onComplete;
    this.onError = onError;
    this.pollTimer = null;
    this.jobId = null;
    this.previewDelivered = false;
  }

  startTracking(jobId) {
    this.stopTracking();
    this.jobId = jobId;
    this.previewDelivered = false;
    this.#poll();
    this.pollTimer = setInterval(() => this.#poll(), 3000);
  }

  stopTracking() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async #poll() {
    if (!this.jobId) return;
    try {
      const status = await this.api.getStatus(this.jobId);
      const phase = this.#normalizePhase(status.current_phase, status.progress_pct, status.status);
      this.onStatusUpdate?.({
        ...status,
        current_phase: phase,
        phase_label: PHASE_LABELS[phase] || PHASE_LABELS.extracting
      });

      if (!this.previewDelivered && (status.preview_url || status.progress_pct >= 20 || status.status === 'processing' || status.status === 'completed')) {
        this.previewDelivered = true;
        try {
          const preview = await this.api.getPreview(this.jobId);
          this.onPreviewReady?.(preview);
        } catch (previewError) {
          console.warn('Preview not ready yet:', previewError.message);
        }
      }

      if (status.status === 'completed') {
        this.stopTracking();
        this.onComplete?.(status);
      } else if (status.status === 'failed') {
        this.stopTracking();
        this.onError?.(new Error('Conversion failed. Please try again.'));
      }
    } catch (error) {
      this.stopTracking();
      this.onError?.(error);
    }
  }

  #normalizePhase(rawPhase, progress, status) {
    if (status === 'completed') return 'done';
    const phase = (rawPhase || '').toLowerCase();
    if (/extract/.test(phase)) return 'extracting';
    if (/translat/.test(phase)) return 'translating';
    if (/rtl|layout|shape/.test(phase)) return 'rtl';
    if (/quality|qa|check/.test(phase)) return 'quality';
    if (progress >= 75) return 'quality';
    if (progress >= 50) return 'rtl';
    if (progress >= 25) return 'translating';
    return 'extracting';
  }
}

if (typeof window !== 'undefined') {
  window.SlideArabiAPI = SlideArabiAPI;
  window.GeoPricing = GeoPricing;
  window.UploadManager = UploadManager;
  window.ConversionTracker = ConversionTracker;
}
