// ========================================
// SCROLLBAR AUTO-HIDE
// ========================================
// Side-effect only: module scope already isolates this, so the IIFE wrapper
// from the classic script is dropped.

const HIDE_DELAY = 1500;
const MOVE_THROTTLE = 250;
const timers = new WeakMap();

function showScrollbar(el) {
    el.classList.add('scrollbar-active');
    clearTimeout(timers.get(el));
    timers.set(el, setTimeout(() => el.classList.remove('scrollbar-active'), HIDE_DELAY));
}

function isScrollable(el) {
    const s = getComputedStyle(el);
    const oy = s.overflowY, ox = s.overflowX;
    return ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight)
        || ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth);
}

function findScrollable(el) {
    while (el && el !== document) {
        if (el.nodeType === 1 && isScrollable(el)) return el;
        el = el.parentElement;
    }
    return null;
}

document.addEventListener('scroll', (e) => {
    const t = e.target === document ? document.documentElement : e.target;
    if (t && t.nodeType === 1) showScrollbar(t);
}, { capture: true, passive: true });

let lastMove = 0;
document.addEventListener('mousemove', (e) => {
    const now = Date.now();
    if (now - lastMove < MOVE_THROTTLE) return;
    lastMove = now;
    const el = findScrollable(e.target);
    if (el) showScrollbar(el);
}, { passive: true });
