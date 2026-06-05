(() => {
    const BACKEND_URL = 'https://exam-backend-by4y.onrender.com';
    const AI_SERVICE_URL = 'https://sai1912-exam-ai-proctor.hf.space';
    const apiBaseUrl = window.API_BASE_URL || BACKEND_URL;

    window.API_BASE_URL = apiBaseUrl;
    window.PROCTOR_SERVICES = {
        backendUrl: apiBaseUrl,
        aiServiceUrl: AI_SERVICE_URL
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = (resource, init) => {
        if (typeof resource === 'string' && resource.startsWith('/api/')) {
            return originalFetch(`${apiBaseUrl}${resource}`, init);
        }
        return originalFetch(resource, init);
    };
})();