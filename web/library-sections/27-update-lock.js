// ========================================
// UPDATE LOCK
// ========================================

function isUpdateLocked(char) {
    return !!char?.data?.extensions?.update_locked;
}

async function setUpdateLocked(avatar, locked) {
    const success = await window.applyCardFieldUpdates(avatar, {
        'extensions.update_locked': !!locked,
    });
    if (!success) throw new Error('Failed to save update lock');
}
