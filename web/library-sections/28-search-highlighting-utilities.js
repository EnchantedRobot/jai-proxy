// ==============================================
// Search Highlighting Utilities
// ==============================================

function highlightText(container, query) {
    clearHighlights(container);
    if (!query) return;
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escaped})`, 'gi');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
        if (node.parentElement?.closest('.search-highlight, input, select, textarea, button, .glass-input')) continue;
        if (!regex.test(node.nodeValue)) continue;
        regex.lastIndex = 0;
        const frag = document.createDocumentFragment();
        let last = 0;
        let match;
        while ((match = regex.exec(node.nodeValue)) !== null) {
            if (match.index > last) frag.appendChild(document.createTextNode(node.nodeValue.slice(last, match.index)));
            const mark = document.createElement('mark');
            mark.className = 'search-highlight';
            mark.textContent = match[1];
            frag.appendChild(mark);
            last = regex.lastIndex;
        }
        if (last < node.nodeValue.length) frag.appendChild(document.createTextNode(node.nodeValue.slice(last)));
        node.parentNode.replaceChild(frag, node);
    }
}

function clearHighlights(container) {
    container.querySelectorAll('mark.search-highlight').forEach(mark => {
        const parent = mark.parentNode;
        mark.replaceWith(document.createTextNode(mark.textContent));
        parent.normalize();
    });
}

