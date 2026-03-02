import { defineConfig } from 'vite';

export default defineConfig({
    // Note: COOP/COEP headers removed because they break
    // blob URL downloads (browser ignores the 'download' attribute).
    // The library still works fine without them, just slightly slower.
});
