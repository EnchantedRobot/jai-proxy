// ==============================================
// Keyboard Navigation
// ==============================================
// Side-effect only: reaches its deps through window.ProviderRegistry and the
// bare global closeModal(), both runtime-only lookups that stay working.

document.addEventListener('keydown', (e) => {
    // Don't intercept when typing in inputs
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {
        return;
    }

    // Handle Escape for full-screen modals
    if (e.key === 'Escape') {
        const charModal = document.getElementById('charModal');
        if (charModal && !charModal.classList.contains('hidden')) {
            closeModal();
            return;
        }
        const reg = window.ProviderRegistry;
        const previewIds = reg?.getPreviewModalIds?.() || [];
        for (const id of previewIds) {
            const el = document.getElementById(id);
            if (el && !el.classList.contains('hidden')) {
                reg.closeActivePreviewModal();
                return;
            }
        }
    }

    // Don't intercept other keys when a modal is open
    const charModal = document.getElementById('charModal');
    if (charModal && !charModal.classList.contains('hidden')) return;
    if ((window.ProviderRegistry?.getPreviewModalIds?.() || []).some(id => {
        const el = document.getElementById(id);
        return el && !el.classList.contains('hidden');
    })) return;

    const scrollContainer = document.querySelector('.gallery-content');
    if (!scrollContainer) return;

    const scrollAmount = scrollContainer.clientHeight * 0.8; // 80% of visible height

    switch (e.key) {
        case 'PageDown':
            e.preventDefault();
            scrollContainer.scrollBy({ top: scrollAmount, behavior: 'smooth' });
            break;
        case 'PageUp':
            e.preventDefault();
            scrollContainer.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
            break;
        case 'Home':
            e.preventDefault();
            scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
            break;
        case 'End':
            e.preventDefault();
            scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
            break;
    }
});
