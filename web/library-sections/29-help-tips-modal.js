// ==============================================
// Help & Tips Modal
// ==============================================

function openGalleryInfoModal(section, anchorId) {
    const modal = document.getElementById('galleryInfoModal');
    modal.classList.add('visible');
    if (section) {
        modal.querySelectorAll('.help-nav-item').forEach(n => n.classList.toggle('active', n.dataset.section === section));
        modal.querySelectorAll('.help-panel').forEach(p => p.classList.toggle('active', p.dataset.section === section));
    }
    if (anchorId) {
        requestAnimationFrame(() => document.getElementById(anchorId)?.scrollIntoView({ block: 'start' }));
    }
}
// Exposed for the datacat browse view's Cloudflare-blocked notice to deep-link into the help section.
window.openGalleryInfoModal = openGalleryInfoModal;

document.getElementById('galleryInfoBtn')?.addEventListener('click', () => openGalleryInfoModal());

// Cross-references between help sections. Delegated because the panels are static markup and a
// bare href="#id" would fight the modal's own scroll container and leave a hash on the URL.
document.getElementById('galleryInfoModal')?.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-help-jump]');
    if (!link) return;
    e.preventDefault();
    document.getElementById(link.dataset.helpJump)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
});

// Deep-link from the DataCat settings hint into the matching help section
document.getElementById('hampterHelpLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('gallerySettingsModal')?.classList.remove('visible');
    openGalleryInfoModal('providers', 'helpDatacatHampter');
});

function closeGalleryInfoModal() {
    const modal = document.getElementById('galleryInfoModal');
    modal.classList.remove('visible');
    const searchInput = document.getElementById('helpSearchInput');
    if (searchInput && searchInput.value) {
        searchInput.value = '';
        searchInput.dispatchEvent(new Event('input'));
    }
}

document.getElementById('closeGalleryInfoModal')?.addEventListener('click', closeGalleryInfoModal);
document.getElementById('closeGalleryInfoModalBtn')?.addEventListener('click', closeGalleryInfoModal);

// Help sidebar navigation
const helpModal = document.getElementById('galleryInfoModal');
if (helpModal) {
    helpModal.querySelectorAll('.help-nav-item').forEach(item => {
        item.addEventListener('click', () => {
            const section = item.dataset.section;
            helpModal.querySelectorAll('.help-nav-item').forEach(n => n.classList.toggle('active', n.dataset.section === section));
            helpModal.querySelectorAll('.help-panel').forEach(p => p.classList.toggle('active', p.dataset.section === section));
        });
    });

    // Help search/filter
    const helpSearchInput = document.getElementById('helpSearchInput');
    if (helpSearchInput) {
        const helpLayout = helpModal.querySelector('.help-layout');
        helpSearchInput.addEventListener('input', () => {
            const q = helpSearchInput.value.trim().toLowerCase();
            if (!q) {
                helpLayout.classList.remove('help-search-active');
                clearHighlights(helpModal);
                const activeNav = helpModal.querySelector('.help-nav-item.active');
                if (activeNav) {
                    const section = activeNav.dataset.section;
                    helpModal.querySelectorAll('.help-panel').forEach(p => p.classList.toggle('active', p.dataset.section === section));
                }
                helpModal.querySelectorAll('.help-search-hidden').forEach(el => el.classList.remove('help-search-hidden'));
                return;
            }
            helpLayout.classList.add('help-search-active');

            helpModal.querySelectorAll('.info-section').forEach(section => {
                const text = section.textContent.toLowerCase();
                section.classList.toggle('help-search-hidden', !text.includes(q));
            });

            highlightText(helpModal.querySelector('.help-content'), q);
        });
    }
}

