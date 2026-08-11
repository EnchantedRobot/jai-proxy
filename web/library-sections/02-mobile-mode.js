// ========================================
// MOBILE MODE
// ========================================

// Read of html.cl-mobile (owned by the boot policy computeMobileMode + the library-mobile
// lifecycle). Evaluate at event time, never cache at attach time: the mode flips live mid-session.
function isMobileMode() {
    return document.documentElement.classList.contains('cl-mobile');
}

